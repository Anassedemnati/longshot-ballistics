import * as THREE from 'three';
import { Encounter } from './game/encounter';
import { createSniper, sniperPositions } from './scene/sniper';
import { createOutpost } from './scene/outpost';
import { configurePosition, POSITIONS } from './scene/terrainHeight';
import { missionSetup } from './ui/mission';
import { createGroundDetail } from './scene/detail';
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
import { predict, solveAim } from './game/assistance';
import { muzzleLaunch } from './game/aim';
import { BulletSystem } from './game/bullets';
import type { ImpactEvent } from './game/bullets';
import { parseConfig } from './game/config';
import { BOLT_TIME_S, RELOAD_TIME_S, Weapon } from './game/weapon';
import { DustSystem } from './fx/dust';
import { InputState, bindInput } from './player/input';
import { FirstPersonRifle } from './player/rifle';
import { PlayerView } from './player/view';
import { createRenderer, resizeRenderer } from './scene/renderer';
import { createSky } from './scene/sky';
import { createTargetDummy } from './scene/target';
import { createRocks, createTerrainMesh, terrainHeight } from './scene/terrain';
import { Hud } from './ui/hud';

/** Frame time cap, s: a long stall (hidden tab) must not fast-forward bullets, dust or reloads. */
const MAX_FRAME_DT = 0.1;
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
  /** What the first click does: create the audio context (it needs no pointer lock) and start the wind. */
  unlockAudio(): void;
}

declare global {
  interface Window {
    __game?: GameDebugHook;
  }
}

async function start(): Promise<void> {
  const app = document.getElementById('app');
  if (!app) throw new Error('#app missing');

  const config = new URLSearchParams(location.search).get('debug') === '1'
    ? parseConfig(location.search) : await missionSetup();
  const shooterPos = configurePosition(config.position ?? 'ridge');
  const rifle = RIFLES[config.rifle];
  const atmo = config.air === 'desert' ? DESERT_ATMO : STANDARD_ATMO;
  const zeroElevation = findZeroElevation(rifle, atmo);
  const wind: WindField = () => ({ x: config.windFromLeftMps, y: 0, z: 0 });

  // Scene
  const renderer = createRenderer(app);
  const scene = new THREE.Scene();
  const lighting = createSky(scene);
  const shadowLight = new THREE.DirectionalLight(0xffedcf, 1.2);
  const groundY = terrainHeight(0, -config.range);
  shadowLight.position.set(lighting.sunDirection.x * 50, groundY + lighting.sunDirection.y * 50, -config.range + lighting.sunDirection.z * 50);
  shadowLight.target.position.set(0, groundY, -config.range);
  shadowLight.castShadow = true;
  shadowLight.shadow.mapSize.set(2048, 2048);
  Object.assign(shadowLight.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 1, far: 100 });
  shadowLight.shadow.normalBias = 0.025;
  scene.add(shadowLight, shadowLight.target);
  scene.add(createTerrainMesh(renderer.capabilities.getMaxAnisotropy()));
  scene.add(createRocks());
  scene.add(createGroundDetail());
  const combat = config.theme === 'outpost' || config.theme === 'convoy';
  const encounter = new Encounter();
  let covered = false;
  const compound = combat ? createOutpost(config.range, config.theme as 'outpost' | 'convoy') : null;
  if (compound) scene.add(compound.group);
  const collisionHeight = compound?.height ?? terrainHeight;
  const snipers = combat ? sniperPositions(config.range).map(createSniper) : [];
  const enemies = combat ? snipers : [createTargetDummy(config.range)];
  for (const enemy of enemies) scene.add(enemy.group);
  scene.traverse(object => {
    if (object instanceof THREE.Mesh && object.geometry.type !== 'BoxGeometry') object.receiveShadow = true;
  });
  for (const enemy of enemies) enemy.group.traverse(object => { if (object instanceof THREE.Mesh) { object.castShadow = true; object.receiveShadow = true; } });
  const dust = new DustSystem();
  scene.add(dust.group);

  // Game state
  const bullets = new BulletSystem({
    atmo,
    wind,
    terrainHeight: collisionHeight,
    // While it lies on the sand its upright hit spheres no longer match the body; it stands up again
    // by itself a few seconds after falling, and then it can be hit again.
    targets: () => enemies.filter(enemy => !enemy.down).map(enemy => enemy.hitTarget),
  });
  const weapon = new Weapon(rifle.magazine);

  // Player
  const view = new PlayerView(document.body, shooterPos, window.innerWidth, window.innerHeight);
  const rifleModel = new FirstPersonRifle(config.rifle, config.suppressed);
  const input = new InputState();
  // Start looking at the target's chest.
  const initialZone = enemies[0].hitTarget.zones.find(zone => zone.name === 'upperTorso')!;
  const chestY = initialZone.center.y;
  input.yaw = Math.atan2(-initialZone.center.x, -initialZone.center.z);
  input.pitch = Math.atan2(chestY - shooterPos.y, Math.hypot(initialZone.center.x,initialZone.center.z));
  view.look(input.yaw, input.pitch);

  const hud = new Hud(document.body, config);
  hud.setRounds(weapon.ammo, weapon.magazine, false);
  hud.setHintVisible(true);

  const eye = new THREE.Vector3(shooterPos.x, shooterPos.y, shooterPos.z);
  const targetPoint = new THREE.Vector3(initialZone.center.x, chestY, initialZone.center.z);
  let aimPoint = solveAim(eye, targetPoint, rifle, atmo, wind, zeroElevation);
  const path = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x7debdc, transparent: true, opacity: 0.8 }));
  path.frustumCulled = false;
  scene.add(path);
  const panel = document.createElement('div');
  panel.className = 'assist-panel';
  panel.innerHTML = '<small>FIELD ASSISTANCE</small><div class="mode-buttons"></div><p class="spotter"></p>';
  document.body.append(panel);
  const briefing = document.createElement('p');
  briefing.className = 'mission-briefing';
  const elevation = shooterPos.y - chestY;
  briefing.textContent = `${POSITIONS[config.position ?? 'ridge'].name} · ${Math.round(shooterPos.y)} m elevation. ${combat ? 'Clear snipers on the west roof, east roof, and valley overlook. Watch for sweeping scope glints; steady glints mean acquired. C: toggle cover. Suppressor reduces detection from shots.' : 'Target: training dummy in dry wash.'} ${config.range} m horizontal / ${Math.round(Math.hypot(config.range, elevation))} m line of sight. ${combat ? 'Objective: clear all three opponents and survive.' : 'Objective: confirm 3 hits in 5 shots.'}`;
  panel.prepend(briefing);
  const setupButton = document.createElement('button');
  setupButton.className = 'mission-return';
  setupButton.textContent = 'Mission setup';
  setupButton.onclick = () => { const url = new URL(location.href); url.searchParams.delete('debug'); location.assign(url.href); };
  panel.append(setupButton);
  const marker = document.createElement('div');
  marker.className = 'aim-marker';
  marker.textContent = '◇';
  document.body.append(marker);
  const modes = { trajectory: false, assisted: false, spotter: false };
  const keys = ['KeyT', 'KeyA', 'KeyP'];
  (Object.keys(modes) as (keyof typeof modes)[]).forEach((mode, i) => {
    const button = document.createElement('button');
    const refresh = () => { button.textContent = `${keys[i].slice(3)} · ${mode} ${modes[mode] ? 'ON' : 'OFF'}`; button.setAttribute('aria-pressed', String(modes[mode])); };
    const toggle = () => { modes[mode] = !modes[mode]; refresh(); };
    button.onclick = toggle;
    panel.querySelector('.mode-buttons')!.append(button);
    window.addEventListener('keydown', e => { if (e.code === keys[i] && !e.repeat && !(e.target instanceof HTMLInputElement)) toggle(); });
    refresh();
  });
  const report = panel.querySelector('.spotter')!;
  let previewAge = 1;
  let missionShots = 0;
  let missionHits = 0;
  let missionResolved = 0;
  const missionStatus = document.createElement('p');
  panel.append(missionStatus);
  missionStatus.textContent = 'Qualification: 0 hits / 0 shots · 5-shot string';
  const threat = document.createElement('div');
  threat.className = 'threat-panel'; threat.hidden = !combat; document.body.append(threat);
  const coverMask = document.createElement('div'); coverMask.className = 'cover-mask'; coverMask.hidden = true; document.body.append(coverMask);
  const damageFlash = document.createElement('div'); damageFlash.className = 'damage-flash'; document.body.append(damageFlash);
  let damageTime = 0;
  window.addEventListener('keydown', e => {
    if (e.code === 'KeyC' && !e.repeat && combat && !encounter.ended) { covered = !covered; coverMask.hidden = !covered; }
  });
  let lastCall = 'Acquire the target. Right click for scope.';

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
    if (combat && (covered || encounter.ended)) return;
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
    const { origin, velocity } = muzzleLaunch(shooterPos, view.forward(), view.up(), rifle, zeroElevation);
    bullets.fire(origin, velocity, rifle.bcG7);
    rifleModel.fire();
    missionShots++;
    if (missionShots <= 5) missionStatus.textContent = `Qualification: ${missionHits} hits / ${missionShots} shots · shot in flight`;
    if (combat) encounter.shot(!!config.suppressed);
    playShot(audio, config.rifle, config.suppressed);
    if (shot.boltCycle) playBoltCycle(audio, BOLT_TIME_S);
    hud.setResult('Shot away…');
  }

  function reload(): void {
    if (!weapon.reload()) return;
    rifleModel.reload();
    hud.setRounds(weapon.ammo, weapon.magazine, true);
    playReload(audio, RELOAD_TIME_S);
  }

  function onImpact(event: ImpactEvent): void {
    if (event.bulletId <= 5) { missionResolved++; if (event.kind === 'target') missionHits++; }
    missionStatus.textContent = missionHits >= 3 ? 'Qualification complete · 3 confirmed hits. Free practice.' : missionResolved >= 5 ? 'String complete · return to Mission setup to retry.' : `Qualification: ${missionHits} hits / ${missionShots} shots`;
    lastCall = event.kind === 'target' ? 'Confirmed hit. Target down.' : 'Miss. Re-align with the aim diamond and try again.';
    // The event fires when the bullet arrives; the sound still has to travel back to the shooter.
    if (event.kind === 'target') {
      enemies.find(enemy => enemy.hitTarget.id === event.targetId)?.knockDown();
      playImpactHit(
        audio,
        impactSoundDelay(event.point, shooterPos, atmo.speedOfSound),
        distance(event.point, shooterPos),
      );
      hud.setResult(`HIT – ${event.zone} – ${event.time.toFixed(2)} s`);
    } else if (event.kind === 'terrain') {
      dust.spawn(event.point);
      playImpactDust(
        audio,
        impactSoundDelay(event.point, shooterPos, atmo.speedOfSound),
        distance(event.point, shooterPos),
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
    window.__game = { toggleScope, zoom, fire, reload, unlockAudio };
  }

  window.addEventListener('resize', () => {
    resizeRenderer(renderer, window.innerWidth, window.innerHeight);
    view.resize(window.innerWidth, window.innerHeight);
  });

  // Game loop
  let lastMs: number | null = null;
  let scanTime = 0;
  function frame(nowMs: number): void {
    // The first frame (and any bad timestamp) counts as 0 s; stalls are capped.
    const rawDt = lastMs === null ? 0 : (nowMs - lastMs) / 1000;
    lastMs = nowMs;
    const dt = Number.isFinite(rawDt) && rawDt > 0 ? Math.min(rawDt, MAX_FRAME_DT) : 0;

    view.look(input.yaw, input.pitch);

    for (const event of bullets.update(dt)) onImpact(event);
    for (const enemy of enemies) enemy.update(dt);
    if (combat) {
      scanTime += input.locked ? dt : 0;
      for (const sniper of snipers) sniper.scan(scanTime,encounter.detection >= 65,covered,eye);
      const alive = enemies.filter(enemy => !enemy.down);
      const action = encounter.update(input.locked ? dt : 0, alive.length, covered);
      if (action) {
        damageTime = .45;
        const point = { x: shooterPos.x + 2, y: shooterPos.y - .3, z: shooterPos.z - 3 };
        dust.spawn(point);
        playImpactDust(audio, 0, action === 'blast' ? 1 : 5);
      }
      threat.textContent = encounter.health <= 0 ? 'MISSION FAILED · Return to Mission setup to retry' : alive.length === 0 ? 'AREA CLEAR · Mission complete' :
        `${covered ? 'IN COVER' : 'EXPOSED'} · Health ${encounter.health} · Detection ${Math.round(encounter.detection)}% · ${alive.length} snipers remaining${encounter.warning > 0 ? ` · INCOMING BOMBARDMENT ${encounter.warning.toFixed(1)}s — C: COVER` : encounter.detection >= 65 ? ` · SNIPER FIRING IN ${Math.max(0,4-encounter.sniperClock).toFixed(1)}s` : ' · Enemy searching'}${!input.locked ? ' · PAUSED — click to resume' : ''}`;
      if (alive[0]) {
        const zone = alive[0].hitTarget.zones.find(zone => zone.name === 'upperTorso')!;
        if (targetPoint.x !== zone.center.x || targetPoint.y !== zone.center.y || targetPoint.z !== zone.center.z) {
          targetPoint.set(zone.center.x, zone.center.y, zone.center.z);
          aimPoint = solveAim(eye,targetPoint,rifle,atmo,wind,zeroElevation);
        }
      }
      missionStatus.hidden = true;
    }
    damageTime = Math.max(0,damageTime-dt);
    damageFlash.style.opacity = String(damageTime);

    dust.update(dt);

    refreshSound(); // the context starts (or is suspended) asynchronously
    if (weapon.update(dt)) {
      hud.setRounds(weapon.ammo, weapon.magazine, false);
      if (hud.resultText === RELOADING_TEXT) hud.setResult(''); // do not leave a stale message
    }

    previewAge += dt;
    path.visible = modes.trajectory;
    if (previewAge > 0.1 && (modes.trajectory || modes.spotter)) {
      previewAge = 0;
      const preview = predict(eye, new THREE.Vector3().copy(view.forward()), rifle, atmo, wind, zeroElevation, -targetPoint.z);
      const visiblePoints = [];
      for (const point of preview.points) {
        visiblePoints.push(point);
        if (point.y < collisionHeight(point.x, point.z)) break;
      }
      path.geometry.dispose();
      path.geometry = new THREE.BufferGeometry().setFromPoints(visiblePoints);
      const miss = preview.impact?.clone().sub(targetPoint);
      report.textContent = enemies.every(enemy => enemy.down) ? combat ? 'All sniper positions cleared.' : 'Target down — waiting for reset.' : miss
        ? `${lastCall} Adjust ${Math.abs(miss.x).toFixed(1)} m ${miss.x > 0 ? 'left' : 'right'}, ${Math.abs(miss.y).toFixed(1)} m ${miss.y > 0 ? 'down' : 'up'} at target range. Flight ${preview.time.toFixed(2)} s. Prediction at target plane; terrain may block shot.`
        : 'Turn toward the target to get a solution.';
    }
    report.toggleAttribute('hidden', !modes.spotter);
    marker.hidden = true;
    if (modes.assisted && aimPoint && enemies.some(enemy => !enemy.down) && !covered) {
      view.camera.updateMatrixWorld();
      const projected = aimPoint.clone().project(view.camera);
      const px = projected.x * window.innerWidth / 2;
      const py = projected.y * window.innerHeight / 2;
      marker.hidden = projected.z > 1 || projected.z < -1 || Math.abs(projected.x) > 1 || Math.abs(projected.y) > 1 || (view.isScoped && Math.hypot(px, py) > Math.min(innerWidth, innerHeight) * 0.46);
      marker.style.left = `${(projected.x + 1) * 50}%`;
      marker.style.top = `${(1 - projected.y) * 50}%`;
      marker.title = 'Place your crosshair on this diamond';
    }
    rifleModel.update(dt);
    renderer.render(scene, view.camera);
    if (!view.isScoped && !covered) rifleModel.render(renderer);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

start().catch((error: unknown) => {
  console.error(error);
  const app = document.getElementById('app');
  if (app) app.textContent = 'Could not start the game: ' + (error instanceof Error ? error.message : String(error));
});
