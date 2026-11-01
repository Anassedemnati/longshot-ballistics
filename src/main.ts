import * as THREE from 'three';
import { DESERT_ATMO, STANDARD_ATMO } from './ballistics/atmosphere';
import { RIFLES } from './ballistics/rifles';
import { findZeroElevation } from './ballistics/trajectory';
import type { WindField } from './ballistics/types';
import { muzzleLaunch } from './game/aim';
import { BulletSystem } from './game/bullets';
import type { ImpactEvent } from './game/bullets';
import { parseConfig } from './game/config';
import { DustSystem } from './fx/dust';
import { InputState, bindInput } from './player/input';
import { PlayerView } from './player/view';
import { createRenderer, resizeRenderer } from './scene/renderer';
import { createSky } from './scene/sky';
import { createTargetDummy } from './scene/target';
import { SHOOTER_POS, createRocks, createTerrainMesh, terrainHeight } from './scene/terrain';
import { Hud } from './ui/hud';

/** Seconds to swap a magazine. */
const RELOAD_TIME = 1.5;
/** Frame time cap, s: a long stall (hidden tab) must not fast-forward bullets, dust or reloads. */
const MAX_FRAME_DT = 0.1;
/** Height of the aim point on the dummy (chest), m above its feet. */
const CHEST_HEIGHT = 1.35;

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
    // Once it has been knocked over its upright hit spheres no longer match the body.
    targets: () => (dummy.down ? [] : [dummy.hitTarget]),
  });
  let ammo = rifle.magazine;
  let reloadRemaining = 0;

  // Player
  const view = new PlayerView(document.body, SHOOTER_POS, window.innerWidth, window.innerHeight);
  const input = new InputState();
  // Start looking at the target's chest.
  const chestY = terrainHeight(0, -config.range) + CHEST_HEIGHT;
  input.pitch = Math.atan2(chestY - SHOOTER_POS.y, config.range);
  view.look(input.yaw, input.pitch);

  const hud = new Hud(document.body, config);
  hud.setRounds(ammo, rifle.magazine, false);
  hud.setHintVisible(true);

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
    if (reloadRemaining > 0) return;
    if (ammo <= 0) {
      hud.setResult('Empty – press R to reload');
      return;
    }
    ammo -= 1;
    hud.setRounds(ammo, rifle.magazine, false);
    const { origin, velocity } = muzzleLaunch(SHOOTER_POS, view.forward(), view.up(), rifle, zeroElevation);
    bullets.fire(origin, velocity, rifle.bcG7);
    hud.setResult('Shot away…');
  }

  function reload(): void {
    if (reloadRemaining > 0 || ammo >= rifle.magazine) return;
    reloadRemaining = RELOAD_TIME;
    hud.setRounds(ammo, rifle.magazine, true);
  }

  function onImpact(event: ImpactEvent): void {
    if (event.kind === 'target') {
      dummy.knockDown();
      hud.setResult(`HIT – ${event.zone} – ${event.time.toFixed(2)} s`);
    } else if (event.kind === 'terrain') {
      dust.spawn(event.point);
      hud.setResult('MISS');
    } else {
      hud.setResult('MISS');
    }
  }

  bindInput(
    renderer.domElement,
    input,
    { fire, toggleScope, reload, wheel: zoom, sensitivity: () => view.sensitivity },
    (locked) => hud.setHintVisible(!locked),
  );

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

    if (reloadRemaining > 0) {
      reloadRemaining -= dt;
      if (reloadRemaining <= 0) {
        reloadRemaining = 0;
        ammo = rifle.magazine;
        hud.setRounds(ammo, rifle.magazine, false);
      }
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
