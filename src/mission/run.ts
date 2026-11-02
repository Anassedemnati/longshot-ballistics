import * as THREE from 'three';
import { RIFLES } from '../ballistics/rifles';
import { findZeroElevation } from '../ballistics/trajectory';
import type { Vec3, WindField } from '../ballistics/types';
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
import { distance, impactSoundDelay, windAmbienceGain } from '../audio/timing';
import { muzzleLaunch } from '../game/aim';
import { BulletSystem } from '../game/bullets';
import type { ImpactEvent } from '../game/bullets';
import type { HitTarget, Obstacle, ZoneName } from '../game/hit';
import { rangeUnderCrosshair } from '../game/rangefinder';
import { BOLT_TIME_S, RELOAD_TIME_S, Weapon } from '../game/weapon';
import { DustSystem } from '../fx/dust';
import { SparkSystem } from '../fx/sparks';
import { InputState, bindInput } from '../player/input';
import { PlayerView } from '../player/view';
import { createPropMesh } from '../scene/props';
import { createRenderer, resizeRenderer } from '../scene/renderer';
import { createSky } from '../scene/sky';
import { createTargetDummy } from '../scene/target';
import type { TargetDummy } from '../scene/target';
import { DESERT_FIELD, createRocks, createTerrainMesh } from '../scene/terrain';
import { createTerrainField } from '../scene/terrainField';
import { createVehicleTarget } from '../scene/vehicleTarget';
import type { VehicleTarget } from '../scene/vehicleTarget';
import { Hud } from '../ui/hud';
import { menuSearch } from '../ui/menuModel';
import { showResults } from '../ui/results';
import { windVector } from './config';
import type { MissionConfig } from './config';
import { generateLayout, legacyLayout, soldierAimPoints } from './layout';
import type { SoldierPlacement, VehicleTargetPlacement } from './layout';
import { propColliders, vehicleEngineObstacle } from './props';
import { isComplete, newStats, recordImpact, recordShot, startClock } from './stats';
import type { MissionStats } from './stats';
import { themeAtmosphere } from './themes';

/** Frame time cap, s: a long stall (hidden tab) must not fast-forward bullets, dust or reloads. */
const MAX_FRAME_DT = 0.1;
/** Height of the aim point on a soldier (chest), m above the feet. */
const CHEST_HEIGHT = 1.35;
/** HUD result shown when the trigger is pulled during a reload. */
const RELOADING_TEXT = 'Reloading…';
/** The rangefinder reading is refreshed this often, s of game time. */
const RANGEFINDER_INTERVAL_S = 0.1;
/** Pause after the last target goes down before the results appear, s of game time. */
const RESULTS_DELAY_S = 1.5;

/** Zone names as the HUD shows them. */
const ZONE_LABEL: Record<ZoneName, string> = {
  head: 'Head',
  upperTorso: 'Upper torso',
  lowerTorso: 'Lower torso',
  limbs: 'Limb',
  engine: 'Engine',
};

/** What `window.__game.state()` returns: the score and enough about the targets for the smoke check to aim. */
export interface GameDebugState {
  stats: MissionStats;
  targetsLeft: number;
  /** Every target is down and the mission would show its results (always false on the legacy practice route). */
  complete: boolean;
  /** True once the results overlay is on screen. */
  resultsShown: boolean;
  soldiers: Array<{ id: string; head: Vec3; upperTorso: Vec3; lowerTorso: Vec3; behindCover: boolean; down: boolean }>;
  vehicles: Array<{ id: string; engine: Vec3; disabled: boolean }>;
  /** Draw calls and triangles of the last rendered frame. */
  render: { calls: number; triangles: number };
}

/**
 * Debug/automation hook, `window.__game`: the same functions the mouse and keys call. Only exposed
 * in dev builds or with `?debug=1` in the URL (the headless smoke check uses it).
 */
export interface GameDebugHook {
  toggleScope(): void;
  zoom(notches: number): void;
  fire(): void;
  reload(): void;
  /** What the first click does: create the audio context (it needs no pointer lock) and start the wind. */
  unlockAudio(): void;
  state(): GameDebugState;
  /** Point the view at a world position (the crosshair, not the bullet: it adds no hold-over). */
  aimAt(x: number, y: number, z: number): void;
}

declare global {
  interface Window {
    __game?: GameDebugHook;
  }
}

interface Soldier {
  placement: SoldierPlacement;
  dummy: TargetDummy;
  head: Vec3;
  upperTorso: Vec3;
  lowerTorso: Vec3;
  /** Whether its hit target is in the live list the bullets see. */
  live: boolean;
}

interface Vehicle {
  placement: VehicleTargetPlacement;
  target: VehicleTarget;
  /** The engine block as a solid; joins the obstacles once the engine is disabled (the zones then stop being a target). */
  engineSolid: Obstacle;
  engineCenter: Vec3;
}

/** Static scenery: its matrices never change, so the renderer need not recompute them every frame. */
function freezeStatic(root: THREE.Object3D): void {
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    o.matrixAutoUpdate = false;
  });
}

/**
 * Play one mission: build the scene from the config (terrain, cover, soldiers, vehicle targets), run the
 * game loop (view, weapon, bullets, effects, HUD, rangefinder, sound) and show the results when every
 * target is down. `legacy` is the old `?range=...` practice range: one soldier that stands up again
 * after a few seconds, no props, and no results screen. `debug` exposes `window.__game`.
 */
export function runMission(config: MissionConfig, opts: { legacy: boolean; debug: boolean }): void {
  const app = document.getElementById('app');
  if (!app) throw new Error('#app missing');
  const { legacy } = opts;

  const rifle = RIFLES[config.rifle];
  const atmo = themeAtmosphere(config.theme);
  const zeroElevation = findZeroElevation(rifle, atmo);
  const windVec = windVector(config.windSpeedMps, config.windClock);
  const wind: WindField = () => windVec;

  // The world: the legacy route is the desert of seed 1, which the stage-1 modules already hold.
  const field = legacy ? DESERT_FIELD : createTerrainField(config.theme, config.seed);
  const shooter = field.shooter;
  const layout = legacy ? legacyLayout(config) : generateLayout(config, field);

  // Scene
  const renderer = createRenderer(app);
  const scene = new THREE.Scene();
  createSky(scene, config.theme);
  scene.add(createTerrainMesh(field, renderer.capabilities.getMaxAnisotropy()));
  scene.add(createRocks(field));
  const dust = new DustSystem();
  scene.add(dust.group);
  const sparks = new SparkSystem();
  scene.add(sparks.group);

  // Everything the bullets can meet. `obstacles` and `liveTargets` are single arrays built here and
  // only edited in place (BulletSystem caches bounding radii by Obstacle identity; no per-frame rebuilds).
  const obstacles: Obstacle[] = [];
  for (const p of layout.props) {
    const groundY = field.height(p.x, p.z);
    const mesh = createPropMesh(p, groundY, config.theme);
    freezeStatic(mesh);
    scene.add(mesh);
    obstacles.push(...propColliders(p, groundY));
  }

  const liveTargets: HitTarget[] = [];
  const soldiers = new Map<string, Soldier>();
  for (const p of layout.soldiers) {
    const groundY = field.height(p.x, p.z);
    // Mission soldiers stay down; only the practice range's dummy stands up again.
    const dummy = createTargetDummy({ x: p.x, y: groundY, z: p.z }, p.yaw, p.id, { autoReset: legacy });
    scene.add(dummy.group);
    const aim = soldierAimPoints(p, field);
    soldiers.set(p.id, {
      placement: p,
      dummy,
      head: aim.head,
      upperTorso: aim.upperTorso,
      lowerTorso: aim.lowerTorso,
      live: true,
    });
    liveTargets.push(dummy.hitTarget);
  }

  const vehicles = new Map<string, Vehicle>();
  for (const v of layout.vehicleTargets) {
    const groundY = field.height(v.x, v.z);
    const target = createVehicleTarget(v, groundY, config.theme, { wind: windVec });
    scene.add(target.group);
    obstacles.push(...target.obstacles);
    const engineSolid = vehicleEngineObstacle(v, groundY);
    vehicles.set(v.id, { placement: v, target, engineSolid, engineCenter: engineSolid.box.center });
    liveTargets.push(target.hitTarget);
  }
  const targetsTotal = layout.soldiers.length + layout.vehicleTargets.length;

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
  let nearest: { range: number; point: Vec3 } | null = null;
  for (const s of soldiers.values()) {
    const g = field.height(s.placement.x, s.placement.z);
    if (!nearest || s.placement.range < nearest.range) {
      nearest = { range: s.placement.range, point: { x: s.placement.x, y: g + CHEST_HEIGHT, z: s.placement.z } };
    }
  }
  for (const v of vehicles.values()) {
    if (!nearest || v.placement.range < nearest.range) nearest = { range: v.placement.range, point: v.engineCenter };
  }
  if (nearest) lookAtPoint(nearest.point.x, nearest.point.y, nearest.point.z);
  view.look(input.yaw, input.pitch);

  // Both ways back to the menu (the HUD's link and the results button) carry the mission's settings, and
  // `debug=1` when the page had it. The legacy practice URL goes there too: its config (one soldier at the
  // range, no props, desert) is a valid menu setup, so the menu opens on what the player was practising.
  const menuHref = `${import.meta.env.BASE_URL}${menuSearch(config, opts.debug)}`;

  const hud = new Hud(document.body, config, targetsTotal, menuHref);
  hud.setRounds(weapon.ammo, weapon.magazine, false);
  hud.setHintVisible(true);

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
    playShot(audio, config.rifle);
    if (shot.boltCycle) playBoltCycle(audio, BOLT_TIME_S);
    hud.setResult('Shot away…');
  }

  function reload(): void {
    if (!weapon.reload()) return;
    hud.setRounds(weapon.ammo, weapon.magazine, true);
    playReload(audio, RELOAD_TIME_S);
  }

  /** Take a target out of the list the bullets see. */
  function removeLive(target: HitTarget): void {
    const i = liveTargets.indexOf(target);
    if (i >= 0) liveTargets.splice(i, 1);
  }

  function onImpact(event: ImpactEvent): void {
    // The event fires when the bullet arrives; the sound still has to travel back to the shooter.
    if (event.kind === 'expired') {
      hud.setResult('MISS');
      return;
    }
    const rangeM = distance(event.point, shooter);
    const delay = impactSoundDelay(event.point, shooter, atmo.speedOfSound);

    if (event.kind === 'target') {
      const soldier = soldiers.get(event.targetId);
      const vehicle = vehicles.get(event.targetId);
      let killed = false;
      if (soldier) {
        killed = !soldier.dummy.down; // two bullets in flight can reach the same soldier
        if (killed) {
          soldier.dummy.knockDown();
          soldier.live = false;
          removeLive(soldier.dummy.hitTarget);
        }
        playImpactHit(audio, delay, rangeM);
        hud.setResult(`HIT – ${ZONE_LABEL[event.zone]} – ${event.time.toFixed(2)} s`);
      } else if (vehicle) {
        killed = !vehicle.target.disabled;
        if (killed) {
          vehicle.target.disable();
          removeLive(vehicle.target.hitTarget);
          obstacles.push(vehicle.engineSolid); // the dead engine block is solid; bullets must not pass through it
        }
        sparks.spawn(event.point);
        playImpactMetal(audio, delay, rangeM);
        hud.setResult('VEHICLE DISABLED');
      }
      stats = recordImpact(stats, event, killed, rangeM, frameNowMs);
      hud.setTargets(liveTargets.length, targetsTotal);
    } else if (event.kind === 'obstacle') {
      if (event.material === 'metal') {
        sparks.spawn(event.point);
        playImpactMetal(audio, delay, rangeM);
        hud.setResult('Hit cover (metal)');
      } else {
        dust.spawn(event.point);
        playImpactDust(audio, delay, rangeM);
        hud.setResult('Hit cover');
      }
    } else {
      dust.spawn(event.point);
      playImpactDust(audio, delay, rangeM);
      hud.setResult('MISS');
    }
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

  // The hook calls the handlers directly: it needs no pointer lock and does not touch the pointer.
  if (import.meta.env.DEV || opts.debug) {
    window.__game = {
      toggleScope,
      zoom,
      fire,
      reload,
      unlockAudio,
      aimAt: lookAtPoint,
      state: () => ({
        stats,
        targetsLeft: liveTargets.length,
        complete: missionDone(),
        resultsShown,
        soldiers: [...soldiers.values()].map((s) => ({
          id: s.placement.id,
          head: s.head,
          upperTorso: s.upperTorso,
          lowerTorso: s.lowerTorso,
          behindCover: s.placement.behindCover,
          down: s.dummy.down,
        })),
        vehicles: [...vehicles.values()].map((v) => ({
          id: v.placement.id,
          engine: v.engineCenter,
          disabled: v.target.disabled,
        })),
        render: { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles },
      }),
    };
  }

  window.addEventListener('resize', () => {
    resizeRenderer(renderer, window.innerWidth, window.innerHeight);
    view.resize(window.innerWidth, window.innerHeight);
  });

  // Game loop
  let lastMs: number | null = null;
  let rangeTimer = RANGEFINDER_INTERVAL_S; // read it on the first frame
  let completeTimer = 0;
  function frame(nowMs: number): void {
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

    rangeTimer += dt;
    if (rangeTimer >= RANGEFINDER_INTERVAL_S) {
      rangeTimer = 0;
      hud.setRange(rangeUnderCrosshair(shooter, view.forward(), field, obstacles, liveTargets));
    }

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
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
