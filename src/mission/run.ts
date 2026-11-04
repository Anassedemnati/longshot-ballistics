import { RIFLES } from '../ballistics/rifles';
import { findZeroElevation } from '../ballistics/trajectory';
import type { Vec3, WindField } from '../ballistics/types';
import { AudioEngine } from '../audio/engine';
import { distance, impactSoundDelay } from '../audio/timing';
import {
  playBoltCycle,
  playBulletCrack,
  playDryFire,
  playEnemyShot,
  playImpactDust,
  playImpactHit,
  playImpactMetal,
  playReload,
  playShot,
} from '../audio/sounds';
import { muzzleLaunch } from '../game/aim';
import type { AimTarget } from '../game/assistance';
import { BulletSystem } from '../game/bullets';
import type { ImpactEvent } from '../game/bullets';
import { MuzzleFlashes } from '../fx/muzzleFlash';
import { Encounter } from '../game/encounter';
import { CueQueue, HEARING, crackDelay, crackHeard, reportArrival } from '../game/hearing';
import { HVT } from '../game/hvt';
import type { AlarmCue } from '../game/hvt';
import type { Cue } from '../game/hearing';
import { segmentBox, segmentSphere } from '../game/hit';
import type { HitTarget, HitZone } from '../game/hit';
import { continuedVelocity, downsSecondTarget, exitPoint, punchThrough } from '../game/penetration';
import { rangeUnderCrosshair } from '../game/rangefinder';
import { Squad } from '../game/squad';
import { Weapon } from '../game/weapon';
import { InputState, bindInput } from '../player/input';
import { FirstPersonRifle } from '../player/rifle';
import { GHILLIE_TINT } from '../player/rifleHands';
import { PlayerView } from '../player/view';
import { createPostFx } from '../scene/postfx';
import type { PostFx } from '../scene/postfx';
import { FrameGovernor, pixelRatioFor, qualityFromSearch, settingsFor } from '../scene/quality';
import type { GovernorAction } from '../scene/quality';
import { createRenderer, resizeRenderer } from '../scene/renderer';
import { shadowFocus } from '../scene/shadows';
import type { ShadowFocusInput } from '../scene/shadows';
import { applyHdriSky, loadSkyHdri } from '../scene/sky';
import { Assists } from '../ui/assists';
import { showFatalError } from '../ui/fatal';
import { fullscreenAvailable, onFullscreenChange, toggleFullscreen } from '../ui/fullscreen';
import { Hud } from '../ui/hud';
import { menuSearch } from '../ui/menuModel';
import { showResults } from '../ui/results';
import { ThreatUi } from '../ui/threat';
import { Combat } from './combat';
import { windVector } from './config';
import type { MissionConfig } from './config';
import { CoverMap } from './coverSpots';
import { installDebugHook } from './debugHook';
import { HvtDirector, objectiveText } from './hvtDirector';
import { applyImpact } from './impact';
import { settledWithin } from './preload';
import { createRng } from './random';
import { SquadDirector } from './squadDirector';
import { isComplete, markAssistsUsed, newStats, recordFailure, recordGuardDown, recordHvtDown, recordShot, startClock } from './stats';
import { themeAtmosphere } from './themes';
import { buildWorld, nearestAimPoint, planMission } from './world';

/** Longest the mission start waits for the glTF models (logs, grass, boulders, the nest's rocks), ms; later they join the scene as they arrive. */
const MODELS_TIMEOUT_MS = 8000;
/** A bullet that came out of a body and landed this close to where it left kicks up only a small puff of dust, m. */
const NEAR_LANDING_M = 2.5;
/** Frame time cap, s: a long stall (hidden tab) must not fast-forward bullets, dust or reloads. */
const MAX_FRAME_DT = 0.1;
/** HUD result shown when the trigger is pulled during a reload. */
const RELOADING_TEXT = 'Reloading…';
/** The rangefinder reading is refreshed this often, s of game time. */
const RANGEFINDER_INTERVAL_S = 0.1;
/** Pause after the last target goes down before the results appear, s of game time. */
const RESULTS_DELAY_S = 1.5;
/** Pause after the player is killed before "Mission failed" appears, s of game time. */
const FAILED_DELAY_S = 1.2;
/** Pause after the HVT gets away before "Mission failed" appears, s of game time (long enough to watch the jeep pull away). */
const ESCAPE_RESULTS_DELAY_S = 4;

/**
 * Resolve once the browser has had a chance to paint what is in the DOM now: after the next animation
 * frame's paint (a bare rAF callback runs just before it). A hidden tab draws no frames, so a timer
 * backs it up and the mission still gets built.
 */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    requestAnimationFrame(() => setTimeout(finish, 0));
    setTimeout(finish, 250);
  });
}

/**
 * Play one mission: build the scene from the config (terrain, cover, soldiers, vehicle targets), run the
 * game loop (view, weapon, bullets, effects, HUD, rangefinder, sound) and show the results when every
 * target is down. `legacy` is the old `?range=...` practice range: one soldier that stands up again
 * after a few seconds, no props, and no results screen. `debug` exposes `window.__game`.
 * Building the world takes a moment, so "Preparing mission…" is painted first; the returned promise
 * resolves once the game loop is running. An error in a frame stops the loop and shows the error panel.
 */
export async function runMission(config: MissionConfig, opts: { legacy: boolean; debug: boolean }): Promise<void> {
  const app = document.getElementById('app');
  if (!app) throw new Error('#app missing');
  const { legacy } = opts;

  const prep = document.createElement('div');
  prep.className = 'prep';
  prep.textContent = 'Preparing mission…';
  app.appendChild(prep);
  await nextPaint();

  const rifle = RIFLES[config.rifle];
  const atmo = themeAtmosphere(config.theme);
  const zeroElevation = findZeroElevation(rifle, atmo);
  const windVec = windVector(config.windSpeedMps, config.windClock);
  const wind: WindField = () => windVec;

  // Plan the world first (terrain, layout): a layout that cannot be built throws before any canvas exists.
  const plan = planMission(config, legacy);
  const { field } = plan;
  const shooter = field.shooter;

  // Scene
  // Render quality (scene/quality.ts): `?quality=auto|high|medium|low`, `auto` (the default) starting at `medium` and holding 60 fps by
  // scaling the resolution; the older `?post=high|low|off` maps onto it. The HDRI sky (and its post-processing) is fetched while the
  // world is built; `?post=off` keeps the stage-1 sky and render path.
  const request = qualityFromSearch(window.location.search);
  const auto = request.choice === 'auto';
  let settings = settingsFor(request.choice === 'auto' ? 'medium' : request.choice, request.post);
  const governor = new FrameGovernor(auto);
  let pixelRatio = pixelRatioFor(settings, window.devicePixelRatio, 1);
  const renderer = createRenderer(app, { composer: settings.post !== 'off', pixelRatio });
  const hdriLoading = settings.post === 'off' ? Promise.resolve(null) : loadSkyHdri(config.theme);
  const world = buildWorld(config, plan, {
    legacy,
    maxAnisotropy: renderer.capabilities.getMaxAnisotropy(),
    wind: windVec,
    quality: settings,
  });
  // `obstacles` and `liveTargets` are the world's single arrays, only ever edited in place.
  const { scene, dust, sparks, blood, obstacles, liveTargets, soldiers, vehicles, snipers, targetsTotal } = world;

  // Game state
  // The enemy snipers still up, as the points a bullet's flight is measured against (head and upper torso of each): the crack and the dust of a
  // bullet that ends near one tell him where the shot came from (`combat.onBulletEnd`). One array, refilled in place when a sniper goes down.
  const watchPoints: Vec3[] = [];
  function refreshWatchPoints(): void {
    watchPoints.length = 0;
    for (const k of snipers.values()) if (!k.sniper.down) watchPoints.push(k.head, k.upperTorso);
  }
  refreshWatchPoints();

  // Who hears the player's shots (game/hearing.ts): the enemy snipers, the soldiers that fight back, and each as a GROUP (the first of them
  // to hear a cue tells the rest). One table of live points for the whole mission, in a fixed order (a dead listener stays in it and is
  // skipped): the bullets measure their closest pass by each, for the crack.
  type Listeners = 'snipers' | 'squad' | 'hvt';
  const listenerPoints: Vec3[] = [];
  const listenerGroup: Listeners[] = [];
  const listenerAlive: Array<() => boolean> = [];
  const cues = new CueQueue<Listeners>();
  /** Game time, s: the sum of the (capped) frame times, the clock the bullets fly by and the cues arrive by. */
  let gameTime = 0;
  /** Game time each bullet in flight was fired at, s (a bullet that came out of a body keeps its own's); and the groups its crack has reached (bit per group). */
  const firedAt = new Map<number, number>();
  const cracked = new Map<number, number>();
  const GROUP_BIT: Record<Listeners, number> = { snipers: 1, squad: 2, hvt: 4 };

  const bullets = new BulletSystem({
    atmo,
    wind,
    terrainHeight: field.height,
    targets: () => liveTargets,
    obstacles: () => obstacles,
    watchPoints: () => watchPoints,
    listeners: () => listenerPoints,
    passRadiusM: HEARING.crackRadiusM,
  });
  const weapon = new Weapon(rifle.magazine, rifle); // the rifle's own bolt (or semi-auto cycle) and reload times
  // The mission clock is stopped until the player's first pointer lock or first shot (whichever comes first).
  let stats = newStats(targetsTotal, null, world.hvt ? { guards: world.hvt.guards.length } : undefined);
  /** Timestamp of the frame being processed, ms (impacts are stamped with it). */
  let frameNowMs = performance.now();
  let resultsShown = false;

  // Player
  const view = new PlayerView(document.body, shooter, window.innerWidth, window.innerHeight);
  const input = new InputState();
  // The visible rifle: drawn over the world when not scoped, no flash when suppressed, sleeves in the theme's ghillie tint when the suit is on.
  const rifleModel = new FirstPersonRifle(config.rifle, config.suppressed, config.camo ? GHILLIE_TINT[config.theme] : null);
  rifleModel.resize(window.innerWidth, window.innerHeight);

  // Sky and post-processing: with the HDRI (background, image-based light, matched fog, exposure) the world is drawn
  // through the composer; without it (file missing, `?post=off`) the procedural sky stays and the render is direct.
  // The glTF models were requested with the world: wait for them too (they load alongside the HDRI), so the vegetation is there on the first frame.
  const [hdri] = await Promise.all([hdriLoading, settledWithin([world.vegetation.ready, world.nest.ready], MODELS_TIMEOUT_MS)]);
  if (hdri) applyHdriSky(renderer, scene, config.theme, hdri);
  // Without the HDRI the procedural sky is drawn through the same chain (its float depth keeps the far precision).
  const buildPost = (): PostFx =>
    createPostFx({
      renderer,
      scene,
      camera: view.camera,
      theme: config.theme,
      quality: settings.post,
      samples: settings.samples,
      fxaa: settings.fxaa,
      overlay: () => rifleModel.render(renderer),
      glow: () => rifleModel.flashVisible,
    });
  let post = buildPost();
  // Drawn into the post chain, the rifle is lit by the world's own sky and sun (its muzzle flash then blooms); on the direct path it keeps its stand-in light.
  if (post.composer) rifleModel.lightFrom(scene, renderer.toneMappingExposure, post.bloom !== null);
  prep.remove(); // the canvas is in; the rest of the build runs before the next paint

  /** `?debug=1` only: the world runs without pointer lock (see the debug hook's `keepRunning`). */
  let debugLive = false;

  /** The lines from the eye to the HVT's head and chest are clear of his guards' bodies and of every collider (the debug hook's `exposed`). */
  function hvtExposed(): boolean {
    if (!hvt || !world.hvt || hvt.escaped) return false;
    for (const p of [hvt.officerSoldier.head, hvt.officerSoldier.upperTorso]) {
      for (const g of world.hvt.guards) {
        if (g.dummy.down) continue;
        for (const z of g.dummy.hitTarget.zones) if (segmentSphere(shooter, p, z.center, z.radius + 0.05) !== null) return false;
      }
      for (const o of obstacles) if (segmentBox(shooter, p, o.box) !== null) return false;
    }
    return true;
  }

  /** Turn the view at a world point (also used by the debug hook). */
  function lookAtPoint(x: number, y: number, z: number): void {
    const dx = x - shooter.x;
    const dz = z - shooter.z;
    const horizontal = Math.hypot(dx, dz);
    if (!(horizontal > 1e-6)) return;
    input.yaw = Math.atan2(-dx, -dz) + 0; // + 0 turns -0 into 0
    input.pitch = Math.atan2(y - shooter.y, horizontal);
    view.look(input.yaw, input.pitch);
  }

  // Start looking at the nearest target: a soldier's chest, a vehicle's engine.
  const firstLook = world.hvt ? world.hvt.officer.upperTorso : nearestAimPoint(world);
  if (firstLook) lookAtPoint(firstLook.x, firstLook.y, firstLook.z);
  view.look(input.yaw, input.pitch);

  // Both ways back to the menu (the HUD's link and the results button) carry the mission's settings, and
  // `debug=1` when the page had it. The legacy practice URL goes there too: its config (one soldier at the
  // range, no props, desert) is a valid menu setup, so the menu opens on what the player was practising.
  const menuHref = `${import.meta.env.BASE_URL}${menuSearch(config, opts.debug)}`;

  // The hint lists C (cover) only when there is something to hide from (snipers, or soldiers that shoot back), and T / A / P only when the assists are on.
  const hasSnipers = !legacy && snipers.size > 0;
  const squadFights = !legacy && config.soldiersFightBack && soldiers.size > 0;
  const hud = new Hud(document.body, config, targetsTotal, menuHref, {
    cover: hasSnipers || squadFights,
    assists: config.assists,
    fullscreen: fullscreenAvailable(),
    objective: world.hvt !== null,
  });
  hud.setRounds(weapon.ammo, weapon.magazine, false);
  hud.setHintVisible(true);

  // Audio: the context only starts on a user gesture (the first click that grabs the pointer).
  const audio = new AudioEngine();

  function unlockAudio(): void {
    audio.resume();
  }

  // The soldiers that fight back (game/squad.ts, mission/squadDirector.ts): the squad's knowledge of where the player lies, and each soldier's
  // brain, body and rifle. Declared before the combat, which asks it how many are up and what the squad knows.
  const squad = new Squad(config.seed);
  const flashes = new MuzzleFlashes();
  if (squadFights) scene.add(flashes.group);
  let director: SquadDirector | null = null;

  // Enemy snipers (spec B.4) and soldiers that fight back: the fight with them (detection, fire, bombardments, cover) and its threat line,
  // damage flash and cover mask. A training mission (0 snipers, soldiers standing still) and the practice range have none of it. Declared
  // before the handlers below that ask it whether the player is ducked.
  const combat: Combat | null =
    hasSnipers || squadFights
      ? new Combat({
          encounter: new Encounter({ camo: config.camo }),
          snipers: [...snipers.values()].map((k) => k.sniper),
          ui: new ThreatUi(document.body),
          field,
          shooter,
          suppressed: config.suppressed,
          yaw: () => input.yaw,
          fx: {
            dust: (point) => dust.spawn(point),
            impactSound: (distanceM) => playImpactDust(audio, 0, distanceM),
          },
          dropScope: () => {
            if (!view.isScoped) return;
            view.toggleScope();
            refreshView();
          },
          squad: squadFights ? { state: () => squad.state, alive: () => director?.alive ?? 0 } : undefined,
        })
      : null;
  // The soldiers' cover map: their cover spots, and the routes round the props both they and the HVT's party walk.
  const coverMap = squadFights || world.hvt ? new CoverMap(plan.layout, field) : null;
  if (squadFights && coverMap) {
    director = new SquadDirector({
      soldiers,
      map: coverMap,
      field,
      shooter,
      squad,
      seed: config.seed,
      speedOfSound: atmo.speedOfSound,
      covered: () => combat?.covered ?? false,
      hurt: (points) => combat?.hurt(points),
      callMortar: () => combat?.encounter.callBombardment() ?? false,
      fx: {
        flash: (point, distanceM) => flashes.spawn(point, distanceM),
        shot: (delayS, distanceM) => playEnemyShot(audio, delayS, distanceM, config.rifle),
        dust: (point) => dust.spawn(point, 0.6),
        impact: (delayS, distanceM) => playImpactDust(audio, delayS, Math.max(5, distanceM)),
        crack: (delayS) => playBulletCrack(audio, delayS),
      },
    });
  }

  // The HVT and his bodyguards (an `hvt` mission): their own brain and bodies (mission/hvtDirector.ts).
  const hvt = world.hvt && coverMap ? new HvtDirector({ world: world.hvt, field, map: coverMap, seed: config.seed }) : null;
  /** What the party learns from a cue: the shooter's direction only from a report it could place. */
  const cueFor = (directional: boolean): AlarmCue => ({ directional, shooterX: shooter.x, shooterZ: shooter.z });

  // The listener table: every sniper's head, every soldier's upper torso (the director moves those points in place), when they fight;
  // the HVT's and each bodyguard's head.
  if (combat && snipers.size > 0) {
    for (const k of snipers.values()) {
      listenerPoints.push(k.head);
      listenerGroup.push('snipers');
      listenerAlive.push(() => !k.sniper.down);
    }
  }
  if (director) {
    for (const s of soldiers.values()) {
      listenerPoints.push(s.upperTorso);
      listenerGroup.push('squad');
      listenerAlive.push(() => !s.dummy.down);
    }
  }
  if (hvt) {
    for (const l of hvt.listeners()) {
      listenerPoints.push(l.point);
      listenerGroup.push('hvt');
      listenerAlive.push(l.alive);
    }
  }

  /** Distance from the rifle to the nearest live listener of `group`, m (Infinity when none is left). */
  function nearestListener(group: Listeners): number {
    let best = Infinity;
    for (let i = 0; i < listenerPoints.length; i++) {
      if (listenerGroup[i] !== group || !listenerAlive[i]()) continue;
      best = Math.min(best, distance(listenerPoints[i], shooter));
    }
    return best;
  }

  /** The player's shot: its report is on its way to every group, arriving when the sound reaches the nearest of them (if it is heard at all). */
  function scheduleReports(): void {
    for (const group of ['snipers', 'squad', 'hvt'] as const) {
      const arrival = reportArrival(nearestListener(group), atmo.speedOfSound, config.suppressed);
      if (arrival) cues.schedule({ kind: 'report', group, at: gameTime + arrival.delayS, directional: arrival.directional, suppressed: config.suppressed });
    }
  }

  /** The bullets that went past a listener this frame: a supersonic one close enough cracks for his group (once per bullet and group). */
  function schedulePasses(): void {
    for (const pass of bullets.passes) {
      const group = listenerGroup[pass.listener];
      if (group === undefined || !listenerAlive[pass.listener]()) continue;
      if (!crackHeard(pass.distanceM, pass.speed, atmo.speedOfSound)) continue;
      const bit = GROUP_BIT[group];
      const done = cracked.get(pass.bulletId) ?? 0;
      if ((done & bit) !== 0) continue;
      cracked.set(pass.bulletId, done | bit);
      const shotAt = firedAt.get(pass.bulletId) ?? gameTime - pass.time;
      cues.schedule({ kind: 'crack', group, at: shotAt + crackDelay(pass.time, pass.distanceM, atmo.speedOfSound), directional: false, suppressed: config.suppressed });
    }
  }

  /** A cue has reached its group: the report gives the existing amounts of detection and knowledge; a crack only alarms. */
  function hear(cue: Cue<Listeners>): void {
    if (missionDone() || stats.failed) return;
    if (cue.group === 'hvt') {
      hvt?.alarm(cueFor(cue.directional));
    } else if (cue.group === 'snipers') {
      if (cue.kind === 'report') combat?.onShot();
      else combat?.onCrack();
    } else if (director) {
      if (cue.kind === 'report') director.onPlayerShot({ suppressed: config.suppressed, camo: config.camo });
      else director.squad.alarm();
    }
  }

  // Aim assists (T / A / P): only in missions that enable them. They aim at what stands: a soldier's or an enemy
  // sniper's upper torso, a vehicle's engine.
  const assistTargets = (): AimTarget[] => {
    const list: AimTarget[] = [];
    // An `hvt` mission: while he is up, the HVT is the assists' one target (the spotter calls him, whoever else is nearer the crosshair).
    if (hvt && !hvt.officerSoldier.dummy.down && !hvt.escaped) {
      list.push({ id: 'hvt', point: hvt.officerSoldier.upperTorso });
      return list;
    }
    if (world.hvt) for (const g of world.hvt.guards) if (!g.dummy.down) list.push({ id: g.placement.id, point: g.upperTorso });
    for (const s of soldiers.values()) if (!s.dummy.down) list.push({ id: s.placement.id, point: s.upperTorso });
    for (const v of vehicles.values()) if (!v.target.disabled) list.push({ id: v.placement.id, point: v.engineCenter });
    for (const k of snipers.values()) if (!k.sniper.down) list.push({ id: k.placement.id, point: k.upperTorso });
    return list;
  };
  const assists = config.assists
    ? new Assists({
        parent: document.body,
        scene,
        view,
        eye: shooter,
        rifle,
        atmo,
        wind,
        zero: zeroElevation,
        groundHeight: field.height,
        targets: assistTargets,
        covered: () => combat?.covered ?? false,
        onUsed: () => {
          stats = markAssistsUsed(stats);
        },
      })
    : null;

  function toggleMute(): void {
    audio.toggleMute();
    refreshSound();
  }

  function refreshSound(): void {
    hud.setSound(audio.running, audio.muted, audio.available);
  }

  function refreshView(): void {
    hud.setMagnification(view.magnification);
  }

  function toggleScope(): void {
    if (combat?.covered) return; // ducked behind cover: no scope
    view.toggleScope();
    refreshView();
  }

  function zoom(notches: number): void {
    view.zoom(notches);
    refreshView();
  }

  /** The mission is over (every target down); the practice range never is. */
  function missionDone(): boolean {
    return !legacy && isComplete(stats);
  }

  function fire(): void {
    if (missionDone() || stats.failed) return; // the score is final
    if (combat?.covered) return; // no shooting from behind cover
    const shot = weapon.fire();
    if (!shot.fired) {
      // A click during the bolt cycle is ignored silently, so the last HIT/MISS stays on screen.
      if (shot.reason === 'reloading') hud.setResult(RELOADING_TEXT);
      else if (shot.reason === 'empty') {
        playDryFire(audio);
        hud.setResult('Empty – press R to reload');
      }
      return;
    }
    stats = recordShot(startClock(stats, performance.now()));
    // The muzzle blast gives the player away, but only once its sound has reached them (game/hearing.ts).
    scheduleReports();
    hud.setRounds(weapon.ammo, weapon.magazine, false);
    const { origin, velocity } = muzzleLaunch(shooter, view.forward(), view.up(), rifle, zeroElevation);
    firedAt.set(bullets.fire(origin, velocity, rifle.bcG7), gameTime);
    playShot(audio, config.rifle, config.suppressed);
    rifleModel.fire(shot.boltCycle);
    view.kick(rifle.recoil); // the picture jumps: barely for a .308, the sight picture lost for a moment with a .50
    if (shot.boltCycle && rifle.action === 'bolt') playBoltCycle(audio, weapon.boltTimeS); // a semi-auto cycles inside the shot's own report
    hud.setResult('Shot away…');
  }

  function reload(): void {
    if (!weapon.reload()) return;
    hud.setRounds(weapon.ammo, weapon.magazine, true);
    playReload(audio, weapon.reloadTimeS);
    rifleModel.reload(weapon.reloadTimeS);
  }

  /** Take a target out of the list the bullets see. */
  function removeLive(target: HitTarget): void {
    const i = liveTargets.indexOf(target);
    if (i >= 0) liveTargets.splice(i, 1);
  }

  /**
   * The bullets that have come out of a body and fly on: they kick up dust or sparks, and down a man behind only with the energy for it
   * (`downsSecondTarget`: a heavy calibre does, a .308 hardly ever); that kill counts, but not as a hit.
   */
  const throughBullets = new Map<number, Vec3>(); // bullet id -> where it came out of the body
  const penetrationRng = createRng(0x51ee7);

  /** Where a bullet that went through a soldier or sniper ends: dust (or sparks off metal) and the thud, nothing else. */
  function onThroughImpact(event: ImpactEvent, exit: Vec3): void {
    if (event.kind === 'expired') return;
    if (event.kind === 'target') {
      // Too spent to down him (or he is a vehicle's engine): it stops in him.
      playImpactHit(audio, impactSoundDelay(event.point, shooter, atmo.speedOfSound), distance(event.point, shooter));
      return;
    }
    const metal = event.kind === 'obstacle' && event.material === 'metal';
    if (metal) sparks.spawn(event.point);
    else dust.spawn(event.point, distance(event.point, exit) < NEAR_LANDING_M ? 0.35 : 1); // landing at his feet: a small puff, not one that hides him
    const distanceM = distance(event.point, shooter);
    const delayS = impactSoundDelay(event.point, shooter, atmo.speedOfSound);
    if (metal) playImpactMetal(audio, delayS, distanceM);
    else playImpactDust(audio, delayS, distanceM);
  }

  /** A bullet that struck a body (not a vehicle): the wound where it went in, the spray where it came out, and the bullet flying on through. */
  function penetrate(event: ImpactEvent, zones: readonly HitZone[]): void {
    if (event.kind !== 'target' || !event.velocity) return;
    const speed = Math.hypot(event.velocity.x, event.velocity.y, event.velocity.z);
    if (!(speed > 1)) return;
    const dir = { x: event.velocity.x / speed, y: event.velocity.y / speed, z: event.velocity.z / speed };
    const out = exitPoint(zones, event.point, dir);
    blood.spawnEntry(event.point, dir);
    blood.spawnExit(out, dir);
    const id = bullets.fire(out, continuedVelocity(event.velocity, penetrationRng, rifle.bulletMassG), rifle.bcG7, {
      ignoreTargetId: event.targetId,
      startTime: event.time,
    });
    throughBullets.set(id, out);
    firedAt.set(id, firedAt.get(event.bulletId) ?? gameTime - event.time); // it keeps the clock of the shot it came from
  }

  /** Decide what an impact does (`applyImpact`, pure) and carry it out; each event is applied before the next is decided. */
  function onImpact(event: ImpactEvent): void {
    const exit = throughBullets.get(event.bulletId);
    if (exit) {
      throughBullets.delete(event.bulletId);
      const live = event.kind === 'target' && event.velocity && downsSecondTarget(rifle.bulletMassG, event.velocity);
      if (!live) {
        onThroughImpact(event, exit);
        return;
      }
    }
    // A heavy anti-materiel bullet goes on through a vehicle's skin (walls still stop everything): the sparks and the clang here, the
    // bullet flying on past the far face to what is behind (an engine block, a man in cover).
    let punched = false;
    if (!exit && rifle.antiMateriel && event.kind === 'obstacle' && event.material === 'metal' && event.velocity) {
      const box = obstacles.find((o) => o.id === event.obstacleId)?.box;
      const on = box ? punchThrough(box, event.point, event.velocity, rifle.bulletMassG, penetrationRng) : null;
      if (on) {
        bullets.fire(on.origin, on.velocity, rifle.bcG7, { ignoreObstacleId: event.obstacleId, startTime: event.time });
        punched = true;
      }
    }
    const result = applyImpact(event, {
      stats,
      shooter,
      speedOfSound: atmo.speedOfSound,
      nowMs: frameNowMs,
      target: (id) => {
        if (hvt && id === 'hvt') return { kind: 'hvt', down: hvt.officerSoldier.dummy.down, wounded: hvt.status === 'wounded' };
        const guard = hvt ? hvt.guardIndex(id) : -1;
        if (guard >= 0 && world.hvt) return { kind: 'soldier', down: world.hvt.guards[guard].dummy.down };
        const soldier = soldiers.get(id);
        if (soldier) return { kind: 'soldier', down: soldier.dummy.down };
        const vehicle = vehicles.get(id);
        if (vehicle) return { kind: 'vehicle', down: vehicle.target.disabled };
        const sniper = snipers.get(id);
        if (sniper) return { kind: 'sniper', down: sniper.sniper.down };
        return undefined;
      },
    }, exit !== undefined);
    stats = result.stats;

    // A bullet that kills a sniper passed within a hair of him: that is no cue for the others, who only see him go down. One that
    // punched through a vehicle has not ended yet.
    const killedSniper = result.killedTargetId !== null && snipers.has(result.killedTargetId);
    if (!killedSniper && !punched) combat?.onBulletEnd(event.closestWatchM);

    const hit = event.kind === 'target' && event.velocity ? { point: event.point, velocity: event.velocity, zone: event.zone } : undefined;
    // The HVT's party sees what happens round them: a bullet that strikes close by, a man going down near the officer.
    if (hvt && !hvt.party.alarmed && event.kind !== 'expired' && hvt.nearest(event.point) <= HEARING.impactSeenM) hvt.alarm(cueFor(false));
    if (hvt && result.woundedTargetId === 'hvt') {
      penetrate(event, hvt.officerSoldier.dummy.hitTarget.zones);
      hvt.wound(cueFor(false));
    }
    if (hvt && result.killedTargetId !== null && (result.killedTargetId === 'hvt' || hvt.guardIndex(result.killedTargetId) >= 0)) {
      const body = result.killedTargetId === 'hvt' ? hvt.officerSoldier : world.hvt?.guards[hvt.guardIndex(result.killedTargetId)];
      if (body) {
        penetrate(event, body.dummy.hitTarget.zones);
        body.dummy.knockDown(hit);
        body.live = false;
        removeLive(body.dummy.hitTarget);
        if (result.killedTargetId === 'hvt') stats = recordHvtDown(stats, event.kind === 'target' ? distance(event.point, shooter) : 0, frameNowMs);
        else stats = recordGuardDown(stats);
        hvt.killed(result.killedTargetId, cueFor(false));
      }
    } else if (result.killedTargetId !== null) {
      const soldier = soldiers.get(result.killedTargetId);
      const vehicle = vehicles.get(result.killedTargetId);
      const sniper = snipers.get(result.killedTargetId);
      if (sniper) {
        penetrate(event, sniper.sniper.hitTarget.zones);
        sniper.sniper.knockDown(hit);
        sniper.live = false;
        removeLive(sniper.sniper.hitTarget);
        refreshWatchPoints();
      } else if (soldier) {
        penetrate(event, soldier.dummy.hitTarget.zones);
        soldier.dummy.knockDown(hit);
        soldier.live = false;
        removeLive(soldier.dummy.hitTarget);
        director?.onSoldierKilled(soldier.placement.id);
        // One of his soldiers going down within sight of the officer raises the alarm.
        if (hvt && hvt.nearest(soldier.upperTorso) <= HVT.sightM) hvt.alarm(cueFor(false));
      } else if (vehicle) {
        vehicle.target.disable();
        removeLive(vehicle.target.hitTarget);
        obstacles.push(vehicle.engineSolid); // the dead engine block is solid; bullets must not pass through it
      }
    }
    if (result.fx) (result.fx.kind === 'sparks' ? sparks : dust).spawn(result.fx.point);
    if (result.sound) {
      const { kind, delayS, distanceM } = result.sound;
      if (kind === 'hit') playImpactHit(audio, delayS, distanceM);
      else if (kind === 'metal') playImpactMetal(audio, delayS, distanceM);
      else playImpactDust(audio, delayS, distanceM);
    }
    if (result.hud.result !== null) hud.setResult(result.hud.result);
    if (result.hud.refreshTargets) hud.setTargets(liveTargets.length, targetsTotal);
  }

  const unbindInput = bindInput(
    renderer.domElement,
    input,
    {
      fire,
      toggleScope,
      reload,
      wheel: zoom,
      sensitivity: () => view.sensitivity,
      userGesture: unlockAudio,
      toggleMute,
      toggleCover: () => combat?.toggleCover(missionDone() || stats.failed || resultsShown),
      toggleFullscreen: () => toggleFullscreen(),
    },
    (locked) => {
      hud.setHintVisible(!locked);
      if (locked) stats = startClock(stats, performance.now());
    },
  );

  function showResultsScreen(): void {
    resultsShown = true;
    assists?.dispose();
    // The input listeners sit on the document: take them off, or a click on a results button would grab the pointer again.
    unbindInput();
    input.onLockChange(false);
    if (document.pointerLockElement) document.exitPointerLock();
    hud.setHintVisible(false);
    showResults(document.body, stats, {
      onRestart: () => window.location.reload(),
      onMenu: () => {
        window.location.href = menuHref;
      },
    });
  }

  // Performance probes (`?debug=1` only): the scene, renderer and post chain, so a measuring script can switch parts off.
  if (opts.debug) {
    (window as unknown as { __perf?: unknown }).__perf = {
      scene,
      renderer,
      view,
      world,
      get post() {
        return post;
      },
      quality: () => ({ level: settings.level, scale: governor.scale, pixelRatio, frameMs: governor.frameMs, auto }),
    };
  }
  if (import.meta.env.DEV || opts.debug) {
    installDebugHook(
      {
        toggleScope,
        zoom,
        fire,
        reload,
        unlockAudio,
        aimAt: lookAtPoint,
        // The cheats exist only with `?debug=1`: a dev server's plain URL gets the hook but not them.
        ...(opts.debug
          ? {
              setDetection: (percent: number) => combat?.encounter.setDetection(percent),
              setHealth: (points: number) => {
                if (combat && Number.isFinite(points)) combat.encounter.health = Math.min(100, Math.max(1, points));
              },
              setSquadKnowledge: (value: number) => {
                if (director) squad.setKnowledge(value);
              },
              keepRunning: (on: boolean) => {
                debugLive = on === true;
              },
            }
          : {}),
        aimAtHvt: (part: 'head' | 'chest' = 'head') => {
          if (!hvt) return;
          const p = part === 'chest' ? hvt.officerSoldier.upperTorso : hvt.officerSoldier.head;
          lookAtPoint(p.x, p.y, p.z);
        },
      },
      {
        stats: () => stats,
        targetsLeft: () => liveTargets.length,
        complete: missionDone,
        resultsShown: () => resultsShown,
        soldiers,
        base: plan.layout.base
          ? { size: plan.layout.base.size, center: { ...plan.layout.base.center }, guards: [...soldiers.values()].filter((s) => s.placement.post).length }
          : null,
        vehicles,
        snipers,
        combat: combat && {
          health: () => combat.encounter.health,
          detection: () => combat.encounter.detection,
          covered: () => combat.covered,
          awareness: () => combat.encounter.awareness,
          snipersLeft: () => combat.snipersLeft,
        },
        squad: director && { state: () => squad.state, knowledge: () => squad.knowledge, soldiers: () => director?.states() ?? [] },
        hvt: hvt && (() => ({ ...hvt.state(), exposed: hvtExposed() })),
        render: () => ({ calls: renderer.info.render.calls, triangles: renderer.info.render.triangles }),
      },
    );
  }

  /** Render at the level's pixel ratio times the governor's scale (a new pixel ratio reallocates the post chain's targets). */
  function applyResolution(): void {
    pixelRatio = pixelRatioFor(settings, window.devicePixelRatio, governor.scale);
    resizeRenderer(renderer, window.innerWidth, window.innerHeight, pixelRatio);
    post.setSize(window.innerWidth, window.innerHeight);
  }
  function applyGovernor(action: GovernorAction): void {
    if (action.kind === 'scale') {
      applyResolution();
      return;
    }
    // `auto` found the machine hopelessly slow: what can change at run time goes to the low level (no FXAA, the shadow map every other frame).
    settings = settingsFor(action.level, request.post);
    world.shadow.setEvery(settings.shadowEvery);
    post.dispose();
    post = buildPost();
    rifleModel.setFlashBloom(post.bloom !== null); // an HDR flash needs a bloom pass to take it
    applyResolution();
  }

  /** The window changed size (a resize, or fullscreen on or off): the canvas, the post chain, the camera, the scope overlay and the rifle follow. */
  function onResize(): void {
    resizeRenderer(renderer, window.innerWidth, window.innerHeight, pixelRatio);
    post.setSize(window.innerWidth, window.innerHeight);
    view.resize(window.innerWidth, window.innerHeight);
    rifleModel.resize(window.innerWidth, window.innerHeight);
  }
  window.addEventListener('resize', onResize);
  // Browsers fire `resize` as the page goes fullscreen, but not always at the final size: measure again when the change is done.
  onFullscreenChange(onResize);

  // Game loop
  let lastMs: number | null = null;
  let rangeTimer = RANGEFINDER_INTERVAL_S; // read it on the first frame
  let lastRange: number | null = null;
  let completeTimer = 0;
  let failedTimer = 0;
  // Scratch for the shadow focus, refilled every frame (the loop makes no objects of its own).
  const viewDir: Vec3 = { x: 0, y: 0, z: 0 };
  const focusInput: ShadowFocusInput = { scoped: false, eye: shooter, forward: viewDir, rangeM: null, ground: field.height };
  const focus: Vec3 = { x: 0, y: 0, z: 0 };
  function tick(nowMs: number): void {
    // The first frame (and any bad timestamp) counts as 0 s; stalls are capped.
    const rawDt = lastMs === null ? 0 : (nowMs - lastMs) / 1000;
    lastMs = nowMs;
    const dt = Number.isFinite(rawDt) && rawDt > 0 ? Math.min(rawDt, MAX_FRAME_DT) : 0;
    if (auto) {
      const action = governor.frame(rawDt * 1000);
      if (action) applyGovernor(action);
    }
    frameNowMs = nowMs;

    view.update(dt); // the recoil settles
    view.look(input.yaw, input.pitch);

    gameTime += dt;
    const events = bullets.update(dt);
    schedulePasses();
    // Before the impacts are applied: which bullets came near a soldier (the ones that went through a body are not counted; they are still in `throughBullets`).
    director?.observeBullets(bullets.active, events, throughBullets);
    for (const event of events) onImpact(event);
    for (const event of events) {
      firedAt.delete(event.bulletId);
      cracked.delete(event.bulletId);
    }
    for (const s of soldiers.values()) {
      s.dummy.update(dt);
      // The practice dummy stands up again by itself and can then be hit again.
      if (!s.live && !s.dummy.down) {
        s.live = true;
        liveTargets.push(s.dummy.hitTarget);
        hud.setTargets(liveTargets.length, targetsTotal);
      }
    }
    // The HVT's party falls like the soldiers do (their ragdolls run whatever the pause).
    if (world.hvt) for (const b of [world.hvt.officer, ...world.hvt.guards]) b.dummy.update(dt);
    for (const v of vehicles.values()) v.target.update(dt);
    for (const k of snipers.values()) k.sniper.update(dt);
    // The cues that have reached their listeners by now (after this frame's impacts, which may have taken one of them out).
    cues.deliver(gameTime, hear);
    // The fight with the snipers and the soldiers stands still while the pointer is free and once the mission is over.
    const paused = (!input.locked && !debugLive) || resultsShown || missionDone() || stats.failed;
    if (director && !paused) director.update(dt, combat !== null && combat.encounter.awareness === 'firing' && combat.snipersLeft > 0);
    if (hvt) {
      if (!paused) hvt.update(dt);
      // He got away: his hit target leaves the list, and the mission is lost.
      if (hvt.escaped && hvt.officerSoldier.live) {
        hvt.officerSoldier.live = false;
        removeLive(hvt.officerSoldier.dummy.hitTarget);
        if (!stats.failed && !missionDone()) {
          stats = recordFailure(stats, frameNowMs, 'escaped');
          hud.setResult('The HVT escaped');
        }
      }
      const status = hvt.status;
      hud.setObjective(objectiveText(status, hvt.party.escapeIn), status === 'fleeing' || status === 'wounded' || status === 'alarmed' || status === 'escaped');
    }
    if (combat && combat.update(dt, paused) && !stats.failed) {
      stats = recordFailure(stats, frameNowMs);
    }
    flashes.update(dt);
    dust.update(dt);
    sparks.update(dt);
    blood.update(dt);
    rifleModel.update(dt);

    view.forwardInto(viewDir);
    rangeTimer += dt;
    if (rangeTimer >= RANGEFINDER_INTERVAL_S) {
      rangeTimer = 0;
      lastRange = rangeUnderCrosshair(shooter, viewDir, field, obstacles, liveTargets);
      hud.setRange(lastRange);
    }
    // The shadow box follows the crosshair point when scoped, the ground ahead otherwise.
    focusInput.scoped = view.isScoped;
    focusInput.rangeM = lastRange;
    world.shadow.update(shadowFocus(focusInput, focus));

    assists?.update(dt);

    refreshSound(); // the context starts (or is suspended) asynchronously
    if (weapon.update(dt)) {
      hud.setRounds(weapon.ammo, weapon.magazine, false);
      if (hud.resultText === RELOADING_TEXT) hud.setResult(''); // do not leave a stale message
    }

    if (missionDone() && !resultsShown) {
      completeTimer += dt;
      if (completeTimer >= RESULTS_DELAY_S) showResultsScreen();
    }
    if (stats.failed && !resultsShown) {
      failedTimer += dt;
      // An escape gives the jeep a few seconds to be seen driving off.
      if (failedTimer >= (stats.failReason === 'escaped' ? ESCAPE_RESULTS_DELAY_S : FAILED_DELAY_S)) showResultsScreen();
    }

    // The rifle is in front of the player's face: not through the scope, and not while he is ducked behind cover.
    rifleModel.orient(view.camera.quaternion); // the world's sun and sky stay put as he turns
    post.render(!view.isScoped && !combat?.covered, view.isScoped);
  }
  function frame(nowMs: number): void {
    try {
      tick(nowMs);
    } catch (error) {
      // Stop the loop (no further frame is requested) and leave the player a way out.
      console.error(error);
      unbindInput();
      assists?.dispose();
      showFatalError('The game stopped: ' + (error instanceof Error ? error.message : String(error)));
      return;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
