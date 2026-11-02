import { RIFLES } from '../ballistics/rifles';
import { findZeroElevation } from '../ballistics/trajectory';
import type { WindField } from '../ballistics/types';
import { AudioEngine } from '../audio/engine';
import {
  playBoltCycle,
  playDryFire,
  playImpactDust,
  playImpactHit,
  playImpactMetal,
  playReload,
  playShot,
  startWindAmbience,
} from '../audio/sounds';
import { windAmbienceGain } from '../audio/timing';
import { muzzleLaunch } from '../game/aim';
import type { AimTarget } from '../game/assistance';
import { BulletSystem } from '../game/bullets';
import type { ImpactEvent } from '../game/bullets';
import type { HitTarget } from '../game/hit';
import { rangeUnderCrosshair } from '../game/rangefinder';
import { BOLT_TIME_S, RELOAD_TIME_S, Weapon } from '../game/weapon';
import { InputState, bindInput } from '../player/input';
import { FirstPersonRifle } from '../player/rifle';
import { PlayerView } from '../player/view';
import { createRenderer, resizeRenderer } from '../scene/renderer';
import { Assists } from '../ui/assists';
import { showFatalError } from '../ui/fatal';
import { Hud } from '../ui/hud';
import { menuSearch } from '../ui/menuModel';
import { showResults } from '../ui/results';
import { windVector } from './config';
import type { MissionConfig } from './config';
import { installDebugHook } from './debugHook';
import { applyImpact } from './impact';
import { isComplete, markAssistsUsed, newStats, recordShot, startClock } from './stats';
import { themeAtmosphere } from './themes';
import { buildWorld, nearestAimPoint, planMission } from './world';

/** Frame time cap, s: a long stall (hidden tab) must not fast-forward bullets, dust or reloads. */
const MAX_FRAME_DT = 0.1;
/** HUD result shown when the trigger is pulled during a reload. */
const RELOADING_TEXT = 'Reloading…';
/** The rangefinder reading is refreshed this often, s of game time. */
const RANGEFINDER_INTERVAL_S = 0.1;
/** Pause after the last target goes down before the results appear, s of game time. */
const RESULTS_DELAY_S = 1.5;

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
  const renderer = createRenderer(app);
  prep.remove(); // the canvas is in; the rest of the build runs before the next paint
  const world = buildWorld(config, plan, {
    legacy,
    maxAnisotropy: renderer.capabilities.getMaxAnisotropy(),
    wind: windVec,
  });
  // `obstacles` and `liveTargets` are the world's single arrays, only ever edited in place.
  const { scene, dust, sparks, obstacles, liveTargets, soldiers, vehicles, targetsTotal } = world;

  // Game state
  const bullets = new BulletSystem({
    atmo,
    wind,
    terrainHeight: field.height,
    targets: () => liveTargets,
    obstacles: () => obstacles,
  });
  const weapon = new Weapon(rifle.magazine);
  // The mission clock is stopped until the player's first pointer lock or first shot (whichever comes first).
  let stats = newStats(targetsTotal);
  /** Timestamp of the frame being processed, ms (impacts are stamped with it). */
  let frameNowMs = performance.now();
  let resultsShown = false;

  // Player
  const view = new PlayerView(document.body, shooter, window.innerWidth, window.innerHeight);
  const input = new InputState();
  // The visible rifle: drawn over the world when not scoped, no flash when suppressed.
  const rifleModel = new FirstPersonRifle(config.rifle, config.suppressed);
  rifleModel.resize(window.innerWidth, window.innerHeight);

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
  const firstLook = nearestAimPoint(world);
  if (firstLook) lookAtPoint(firstLook.x, firstLook.y, firstLook.z);
  view.look(input.yaw, input.pitch);

  // Both ways back to the menu (the HUD's link and the results button) carry the mission's settings, and
  // `debug=1` when the page had it. The legacy practice URL goes there too: its config (one soldier at the
  // range, no props, desert) is a valid menu setup, so the menu opens on what the player was practising.
  const menuHref = `${import.meta.env.BASE_URL}${menuSearch(config, opts.debug)}`;

  const hud = new Hud(document.body, config, targetsTotal, menuHref);
  hud.setRounds(weapon.ammo, weapon.magazine, false);
  hud.setHintVisible(true);

  // Aim assists (T / A / P): only in missions that enable them. They aim at what stands: a soldier's chest, a vehicle's engine.
  const assistTargets = (): AimTarget[] => {
    const list: AimTarget[] = [];
    for (const s of soldiers.values()) if (!s.dummy.down) list.push({ id: s.placement.id, point: s.upperTorso });
    for (const v of vehicles.values()) if (!v.target.disabled) list.push({ id: v.placement.id, point: v.engineCenter });
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
        onUsed: () => {
          stats = markAssistsUsed(stats);
        },
      })
    : null;

  // Audio: the context only starts on a user gesture (the first click that grabs the pointer).
  const audio = new AudioEngine();
  const windLevel = windAmbienceGain(config.windSpeedMps);

  function unlockAudio(): void {
    audio.resume();
    startWindAmbience(audio, windLevel); // starts the loop once; later calls only set its level
  }

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
    if (missionDone()) return; // the score is final
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
    hud.setRounds(weapon.ammo, weapon.magazine, false);
    const { origin, velocity } = muzzleLaunch(shooter, view.forward(), view.up(), rifle, zeroElevation);
    bullets.fire(origin, velocity, rifle.bcG7);
    playShot(audio, config.rifle, config.suppressed);
    rifleModel.fire(shot.boltCycle);
    if (shot.boltCycle) playBoltCycle(audio, BOLT_TIME_S);
    hud.setResult('Shot away…');
  }

  function reload(): void {
    if (!weapon.reload()) return;
    hud.setRounds(weapon.ammo, weapon.magazine, true);
    playReload(audio, RELOAD_TIME_S);
    rifleModel.reload(RELOAD_TIME_S);
  }

  /** Take a target out of the list the bullets see. */
  function removeLive(target: HitTarget): void {
    const i = liveTargets.indexOf(target);
    if (i >= 0) liveTargets.splice(i, 1);
  }

  /** Decide what an impact does (`applyImpact`, pure) and carry it out; each event is applied before the next is decided. */
  function onImpact(event: ImpactEvent): void {
    const result = applyImpact(event, {
      stats,
      shooter,
      speedOfSound: atmo.speedOfSound,
      nowMs: frameNowMs,
      target: (id) => {
        const soldier = soldiers.get(id);
        if (soldier) return { kind: 'soldier', down: soldier.dummy.down };
        const vehicle = vehicles.get(id);
        if (vehicle) return { kind: 'vehicle', down: vehicle.target.disabled };
        return undefined;
      },
    });
    stats = result.stats;

    if (result.killedTargetId !== null) {
      const soldier = soldiers.get(result.killedTargetId);
      const vehicle = vehicles.get(result.killedTargetId);
      if (soldier) {
        soldier.dummy.knockDown();
        soldier.live = false;
        removeLive(soldier.dummy.hitTarget);
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

  if (import.meta.env.DEV || opts.debug) {
    installDebugHook(
      { toggleScope, zoom, fire, reload, unlockAudio, aimAt: lookAtPoint },
      {
        stats: () => stats,
        targetsLeft: () => liveTargets.length,
        complete: missionDone,
        resultsShown: () => resultsShown,
        soldiers,
        vehicles,
        render: () => ({ calls: renderer.info.render.calls, triangles: renderer.info.render.triangles }),
      },
    );
  }

  window.addEventListener('resize', () => {
    resizeRenderer(renderer, window.innerWidth, window.innerHeight);
    view.resize(window.innerWidth, window.innerHeight);
    rifleModel.resize(window.innerWidth, window.innerHeight);
  });

  // Game loop
  let lastMs: number | null = null;
  let rangeTimer = RANGEFINDER_INTERVAL_S; // read it on the first frame
  let completeTimer = 0;
  function tick(nowMs: number): void {
    // The first frame (and any bad timestamp) counts as 0 s; stalls are capped.
    const rawDt = lastMs === null ? 0 : (nowMs - lastMs) / 1000;
    lastMs = nowMs;
    const dt = Number.isFinite(rawDt) && rawDt > 0 ? Math.min(rawDt, MAX_FRAME_DT) : 0;
    frameNowMs = nowMs;

    view.look(input.yaw, input.pitch);

    for (const event of bullets.update(dt)) onImpact(event);
    for (const s of soldiers.values()) {
      s.dummy.update(dt);
      // The practice dummy stands up again by itself and can then be hit again.
      if (!s.live && !s.dummy.down) {
        s.live = true;
        liveTargets.push(s.dummy.hitTarget);
        hud.setTargets(liveTargets.length, targetsTotal);
      }
    }
    for (const v of vehicles.values()) v.target.update(dt);
    dust.update(dt);
    sparks.update(dt);
    rifleModel.update(dt);

    rangeTimer += dt;
    if (rangeTimer >= RANGEFINDER_INTERVAL_S) {
      rangeTimer = 0;
      hud.setRange(rangeUnderCrosshair(shooter, view.forward(), field, obstacles, liveTargets));
    }

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

    renderer.render(scene, view.camera);
    if (!view.isScoped) rifleModel.render(renderer);
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
