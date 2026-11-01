import * as THREE from 'three';
import { DESERT_ATMO, STANDARD_ATMO } from './ballistics/atmosphere';
import { RIFLES } from './ballistics/rifles';
import { findZeroElevation } from './ballistics/trajectory';
import type { WindField } from './ballistics/types';
import { AudioEngine } from './audio/engine';
import {
  playBoltCycle,
  playDryFire,
  playImpactDust,
  playImpactHit,
  playReload,
  playShot,
  startWindAmbience,
} from './audio/sounds';
import { distance, impactSoundDelay, windAmbienceGain } from './audio/timing';
import { muzzleLaunch } from './game/aim';
import { BulletSystem } from './game/bullets';
import type { ImpactEvent } from './game/bullets';
import { parseConfig } from './game/config';
import { BOLT_TIME_S, RELOAD_TIME_S, Weapon } from './game/weapon';
import { DustSystem } from './fx/dust';
import { InputState, bindInput } from './player/input';
import { PlayerView } from './player/view';
import { createRenderer, resizeRenderer } from './scene/renderer';
import { createSky } from './scene/sky';
import { createTargetDummy } from './scene/target';
import { SHOOTER_POS, createRocks, createTerrainMesh, terrainHeight } from './scene/terrain';
import { Hud } from './ui/hud';

/** Frame time cap, s: a long stall (hidden tab) must not fast-forward bullets, dust or reloads. */
const MAX_FRAME_DT = 0.1;
/** Height of the aim point on the dummy (chest), m above its feet. */
const CHEST_HEIGHT = 1.35;
/** HUD result shown when the trigger is pulled during a reload. */
const RELOADING_TEXT = 'Reloading…';

/**
 * Debug/automation hook, `window.__game`: the same functions the mouse and keys call. Only exposed
 * in dev builds or with `?debug=1` in the URL (the headless smoke check uses it).
 */
interface GameDebugHook {
  toggleScope(): void;
  zoom(notches: number): void;
  fire(): void;
  reload(): void;
}

declare global {
  interface Window {
    __game?: GameDebugHook;
  }
}

function start(): void {
  const app = document.getElementById('app');
  if (!app) throw new Error('#app missing');

  const config = parseConfig(window.location.search);
  const rifle = RIFLES[config.rifle];
  const atmo = config.air === 'desert' ? DESERT_ATMO : STANDARD_ATMO;
  const zeroElevation = findZeroElevation(rifle, atmo);
  const wind: WindField = () => ({ x: config.windFromLeftMps, y: 0, z: 0 });

  // Scene
  const renderer = createRenderer(app);
  const scene = new THREE.Scene();
  createSky(scene);
  scene.add(createTerrainMesh(renderer.capabilities.getMaxAnisotropy()));
  scene.add(createRocks());
  const dummy = createTargetDummy(config.range);
  scene.add(dummy.group);
  const dust = new DustSystem();
  scene.add(dust.group);

  // Game state
  const bullets = new BulletSystem({
    atmo,
    wind,
    terrainHeight,
    // While it lies on the sand its upright hit spheres no longer match the body; it stands up again
    // by itself a few seconds after falling, and then it can be hit again.
    targets: () => (dummy.down ? [] : [dummy.hitTarget]),
  });
  const weapon = new Weapon(rifle.magazine);

  // Player
  const view = new PlayerView(document.body, SHOOTER_POS, window.innerWidth, window.innerHeight);
  const input = new InputState();
  // Start looking at the target's chest.
  const chestY = terrainHeight(0, -config.range) + CHEST_HEIGHT;
  input.pitch = Math.atan2(chestY - SHOOTER_POS.y, config.range);
  view.look(input.yaw, input.pitch);

  const hud = new Hud(document.body, config);
  hud.setRounds(weapon.ammo, weapon.magazine, false);
  hud.setHintVisible(true);

  // Audio: the context only starts on a user gesture (the first click that grabs the pointer).
  const audio = new AudioEngine();
  const windLevel = windAmbienceGain(config.windFromLeftMps);

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

  function fire(): void {
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
    hud.setRounds(weapon.ammo, weapon.magazine, false);
    const { origin, velocity } = muzzleLaunch(SHOOTER_POS, view.forward(), view.up(), rifle, zeroElevation);
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

  function onImpact(event: ImpactEvent): void {
    // The event fires when the bullet arrives; the sound still has to travel back to the shooter.
    if (event.kind === 'target') {
      dummy.knockDown();
      playImpactHit(
        audio,
        impactSoundDelay(event.point, SHOOTER_POS, atmo.speedOfSound),
        distance(event.point, SHOOTER_POS),
      );
      hud.setResult(`HIT – ${event.zone} – ${event.time.toFixed(2)} s`);
    } else if (event.kind === 'terrain') {
      dust.spawn(event.point);
      playImpactDust(
        audio,
        impactSoundDelay(event.point, SHOOTER_POS, atmo.speedOfSound),
        distance(event.point, SHOOTER_POS),
      );
      hud.setResult('MISS');
    } else {
      hud.setResult('MISS');
    }
  }

  bindInput(
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
    (locked) => hud.setHintVisible(!locked),
  );

  // The hook calls the handlers directly: it needs no pointer lock and does not touch InputState.
  if (import.meta.env.DEV || new URLSearchParams(window.location.search).get('debug') === '1') {
    window.__game = { toggleScope, zoom, fire, reload };
  }

  window.addEventListener('resize', () => {
    resizeRenderer(renderer, window.innerWidth, window.innerHeight);
    view.resize(window.innerWidth, window.innerHeight);
  });

  // Game loop
  let lastMs: number | null = null;
  function frame(nowMs: number): void {
    // The first frame (and any bad timestamp) counts as 0 s; stalls are capped.
    const rawDt = lastMs === null ? 0 : (nowMs - lastMs) / 1000;
    lastMs = nowMs;
    const dt = Number.isFinite(rawDt) && rawDt > 0 ? Math.min(rawDt, MAX_FRAME_DT) : 0;

    view.look(input.yaw, input.pitch);

    for (const event of bullets.update(dt)) onImpact(event);
    dummy.update(dt);
    dust.update(dt);

    refreshSound(); // the context starts (or is suspended) asynchronously
    if (weapon.update(dt)) {
      hud.setRounds(weapon.ammo, weapon.magazine, false);
      if (hud.resultText === RELOADING_TEXT) hud.setResult(''); // do not leave a stale message
    }

    renderer.render(scene, view.camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

try {
  start();
} catch (error) {
  console.error(error);
  const app = document.getElementById('app');
  if (app) app.textContent = 'Could not start the game: ' + (error instanceof Error ? error.message : String(error));
}
