import * as THREE from 'three';
import type { Vec3 } from '../ballistics/types';
import type { Awareness } from '../game/encounter';
import type { HitTarget } from '../game/hit';
import { SNIPER_BOUNDS, SNIPER_BOUNDS_MARGIN, SNIPER_RIFLE, sniperWorldPoint, sniperZones } from '../mission/sniperDims';
import { enemyMaterial } from './enemyMaterial';
import { sniperGeometries } from './sniperMesh';
import { createRagdollBody, seedOf } from './ragdollBody';
import { SNIPER_RIG, sniperFall } from '../mission/sniperRig';
import type { FallHit } from '../mission/soldierRig';
import { localGround, toLocal } from './target';
import type { KnockHit, TargetDummy } from './target';

// A prone enemy sniper: a rifleman in a ghillie suit lying on the ground or a roof, head toward the shooter, with a
// rifle that sweeps and a glint (the scope lens catching the sun). The hit spheres are built from mission/sniperDims.ts,
// the drawn body (mission/sniperModel.ts) covers them to within MAX_OVERHANG. All snipers share one body geometry, one rifle
// geometry and one material (the enemy material: per-vertex camo, skin, cloth and steel), so a sniper costs three draw
// calls: body, rifle, glint. The body is a skinned mesh: shot, he goes limp as a (lighter) ragdoll (scene/ragdollBody.ts,
// mission/sniperRig.ts): the head drops, the arms fall off the rifle, the body rolls a little with the bullet.

export interface Sniper extends TargetDummy {
  /**
   * Sweep the scope and place the glint. `time` is the game clock (s, runs only while the game does); `awareness` is how well the
   * snipers know where the player is: `unaware` is the slow wide lazy sweep, `searching` a sweep narrowed toward the player whose
   * glint shows more often, `firing` a steady glint with the rifle pointing at him; `covered` (the player is ducked) hides it; `eye`
   * is the player's eye (the glint grows with the distance so it stays a visible cue at 1 km). A downed sniper has no glint.
   */
  scan(time: number, awareness: Awareness, covered: boolean, eye: Vec3): void;
  /** True while the glint cue is on screen (the sniper is up and the glint is switched on). */
  readonly glintVisible: boolean;
  /** Release what this sniper alone owns (its glint material); the shared geometry and body material stay. */
  dispose(): void;
}

/** A glint is this wide per metre of distance, m (so it spans a few pixels at any range), at least MIN_GLINT. */
const GLINT_PER_M = 0.0035;
const MIN_GLINT = 0.8;
/** An unaware sniper's scope sweeps by +-SWEEP_YAW rad; it catches the player's eye while |sin| stays under LOOK_WINDOW. */
const SWEEP_YAW = 0.3;
const LOOK_WINDOW = 0.38;
/** A searching sniper narrows his sweep to +-SEARCH_YAW rad (toward where the shot came from) and catches the eye while |sin| stays under SEARCH_WINDOW: the glint shows about twice as often. */
const SEARCH_YAW = 0.1;
const SEARCH_WINDOW = 0.8;

interface Shared {
  body: THREE.BufferGeometry;
  rifle: THREE.BufferGeometry;
  material: THREE.MeshStandardMaterial;
  glintTexture: THREE.DataTexture;
}

let shared: Shared | null = null;

function glintTexture(): THREE.DataTexture {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - 31.5) / 32;
      const dy = (y - 31.5) / 32;
      const r = Math.hypot(dx, dy);
      const glow = Math.pow(Math.max(0, 1 - r), 3);
      const cross = Math.exp(-Math.min(dx * dx, dy * dy) * 650) * Math.pow(Math.max(0, 1 - r), 2) * 0.45;
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = 235;
      data[i + 2] = 180;
      data[i + 3] = Math.min(255, (glow + cross) * 255);
    }
  }
  const texture = new THREE.DataTexture(data, size, size);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function buildShared(): Shared {
  const { body, rifle } = sniperGeometries();
  return { body, rifle, material: enemyMaterial(), glintTexture: glintTexture() };
}

function sharedParts(): Shared {
  shared ??= buildShared();
  return shared;
}

/**
 * A prone sniper whose belly is at `position` (x, ground or roof height, z), turned by `yaw` about +Y like
 * three.js `rotation.y`: his head end (+Z) points at (sin yaw, cos yaw), so `yaw = facingYaw(x, z)` makes him
 * look at a shooter at the origin. `id` is the HitTarget id the bullets report (`sniper-<n>`); the number also
 * sets the phase of his scope sweep, so two snipers never glint in step. `ground` is the height of the surface he
 * lies on (x, z), where his body settles when he goes limp (the terrain; a roof passes a flat one); without it the
 * ground is flat at his belly.
 */
export function createSniper(position: Vec3, yaw: number, id: string, opts: { ground?: (x: number, z: number) => number } = {}): Sniper {
  const { body, rifle: rifleGeometry, material: bodyMaterial, glintTexture: texture } = sharedParts();
  const index = Number(/(\d+)$/.exec(id)?.[1] ?? 0);

  const group = new THREE.Group();
  group.name = 'enemy-sniper';
  group.position.set(position.x, position.y, position.z);
  group.rotation.y = yaw;

  const ragdoll = createRagdollBody<FallHit>({
    rig: SNIPER_RIG,
    geometry: body,
    material: bodyMaterial,
    group,
    ground: localGround(opts.ground, position, yaw),
    crumple: sniperFall,
    name: 'sniper-body',
  });

  const rifle = new THREE.Group();
  rifle.position.set(SNIPER_RIFLE.pivot.x, SNIPER_RIFLE.pivot.y, SNIPER_RIFLE.pivot.z);
  const rifleMesh = new THREE.Mesh(rifleGeometry, bodyMaterial);
  rifleMesh.castShadow = true;
  rifle.add(rifleMesh);
  group.add(rifle);

  const glintMaterial = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    toneMapped: false,
    fog: false, // haze would swallow the cue at 1 km, which is where it matters
  });
  const glint = new THREE.Sprite(glintMaterial);
  glint.position.set(SNIPER_RIFLE.glint.x, SNIPER_RIFLE.glint.y, SNIPER_RIFLE.glint.z);
  glint.visible = false;
  rifle.add(glint);

  // Hit zones in the world, from the same numbers as the mesh; the broad-phase sphere encloses all of them.
  const pose = { x: position.x, y: position.y, z: position.z, yaw };
  const zones = sniperZones(pose);
  const boundsCenter = sniperWorldPoint(pose, { x: SNIPER_BOUNDS.cx, y: SNIPER_BOUNDS.cy, z: SNIPER_BOUNDS.cz });
  let boundsRadius = 0;
  for (const zone of zones) {
    const d = Math.hypot(zone.center.x - boundsCenter.x, zone.center.y - boundsCenter.y, zone.center.z - boundsCenter.z);
    boundsRadius = Math.max(boundsRadius, d + zone.radius);
  }
  const hitTarget: HitTarget = { id, zones, bounds: { center: boundsCenter, radius: boundsRadius + SNIPER_BOUNDS_MARGIN } };

  let down = false;
  const toEye = new THREE.Vector3();

  return {
    group,
    hitTarget,
    get down() {
      return down;
    },
    get glintVisible() {
      return glint.parent !== null && glint.visible;
    },
    knockDown(hit?: KnockHit) {
      if (down) return;
      down = true;
      const local: FallHit | undefined = hit && {
        point: toLocal(hit.point, position, yaw),
        velocity: toLocal(hit.velocity, position, yaw, false),
        zone: hit.zone,
      };
      ragdoll.fall(local, seedOf(id, hit ? Math.round(hit.point.x * 1000 + hit.point.y * 7000 + hit.point.z * 311) : 0));
      // The optical cue is gone for as long as he lies there.
      glint.visible = false;
      glintMaterial.opacity = 0;
      glint.removeFromParent();
    },
    reset() {
      down = false;
      ragdoll.reset();
      glint.visible = false;
      glintMaterial.opacity = 0;
      rifle.add(glint);
    },
    update(frameDt: number) {
      if (!down) return;
      ragdoll.update(Number.isFinite(frameDt) && frameDt > 0 ? frameDt : 0);
    },
    scan(time: number, awareness: Awareness, covered: boolean, eye: Vec3) {
      if (down) {
        glint.visible = false;
        return;
      }
      const firing = awareness === 'firing';
      const searching = awareness === 'searching';
      const window = searching ? SEARCH_WINDOW : LOOK_WINDOW;
      const sweep = Math.sin(time * 0.85 + index * 2.1);
      const lookingAtPlayer = firing || Math.abs(sweep) < window;
      rifle.rotation.y = firing ? 0 : sweep * (searching ? SEARCH_YAW : SWEEP_YAW);
      glint.visible = lookingAtPlayer && !covered;
      glintMaterial.opacity = firing ? 0.95 : Math.max(0.15, 1 - Math.abs(sweep) / window);
      toEye.set(eye.x - position.x, eye.y - position.y, eye.z - position.z);
      glint.scale.setScalar(Math.max(MIN_GLINT, toEye.length() * GLINT_PER_M));
    },
    dispose() {
      glintMaterial.dispose();
      ragdoll.dispose();
    },
  };
}
