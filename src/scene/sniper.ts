import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Vec3 } from '../ballistics/types';
import type { Awareness } from '../game/encounter';
import type { HitTarget } from '../game/hit';
import {
  SNIPER_BOUNDS,
  SNIPER_BOUNDS_MARGIN,
  SNIPER_HELMET,
  SNIPER_PARTS,
  SNIPER_RIFLE,
  sniperWorldPoint,
  sniperZones,
} from '../mission/sniperDims';
import type { TargetDummy } from './target';

// A prone enemy sniper: a low-poly body lying on the ground or a roof, head toward the shooter, with a
// rifle that sweeps and a glint (the scope lens catching the sun). The visible body and the hit spheres
// are both built from mission/sniperDims.ts. All snipers share one body geometry, one rifle geometry and
// one material (vertex colours), so a sniper costs three draw calls: body, rifle, glint.

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

/** The roll of a fallen sniper about his own long axis, rad, reached after 1/FALL_RATE s. */
const FALL_ROLL = 0.35;
const FALL_RATE = 3;
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

/** Paint every vertex of `geometry` with `hex` (sRGB hex, as the rest of the scene's colours). */
function tint(geometry: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const color = new THREE.Color(hex);
  const count = geometry.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

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
  const unit = new THREE.SphereGeometry(1, 16, 12);
  const bodyParts: THREE.BufferGeometry[] = SNIPER_PARTS.map((p) => {
    const g = unit.clone();
    g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(p.cx, p.cy, p.cz), new THREE.Quaternion(), new THREE.Vector3(p.rx, p.ry, p.rz)));
    return tint(g, p.color);
  });
  const h = SNIPER_HELMET;
  const helmet = new THREE.SphereGeometry(h.radius, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.6);
  helmet.translate(0, h.cy, h.cz);
  bodyParts.push(tint(helmet, h.color));
  unit.dispose();

  const { tubes, bipod } = SNIPER_RIFLE;
  const rifleParts: THREE.BufferGeometry[] = [];
  for (const t of tubes) {
    const g = new THREE.CylinderGeometry(t.radius, t.radius, t.length, 16);
    g.rotateX(Math.PI / 2); // the cylinder's axis along Z
    g.translate(0, t.y, t.z);
    rifleParts.push(tint(g, SNIPER_RIFLE.color));
  }
  for (const leg of bipod) {
    const g = new THREE.CylinderGeometry(leg.radius, leg.radius, leg.length, 8);
    g.rotateZ(leg.tilt);
    g.translate(leg.x, leg.y, leg.z);
    rifleParts.push(tint(g, SNIPER_RIFLE.color));
  }
  // The rifle's geometry is in its own frame; the rifle group sits at the pivot.
  const rifle = mergeGeometries(rifleParts);
  const body = mergeGeometries(bodyParts);
  for (const g of [...bodyParts, ...rifleParts]) g.dispose();
  if (!body || !rifle) throw new Error('sniper geometry could not be merged');
  return {
    body,
    rifle,
    material: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0.05 }),
    glintTexture: glintTexture(),
  };
}

function sharedParts(): Shared {
  shared ??= buildShared();
  return shared;
}

/**
 * A prone sniper whose belly is at `position` (x, ground or roof height, z), turned by `yaw` about +Y like
 * three.js `rotation.y`: his head end (+Z) points at (sin yaw, cos yaw), so `yaw = facingYaw(x, z)` makes him
 * look at a shooter at the origin. `id` is the HitTarget id the bullets report (`sniper-<n>`); the number also
 * sets the phase of his scope sweep, so two snipers never glint in step.
 */
export function createSniper(position: Vec3, yaw: number, id: string): Sniper {
  const { body, rifle: rifleGeometry, material: bodyMaterial, glintTexture: texture } = sharedParts();
  const index = Number(/(\d+)$/.exec(id)?.[1] ?? 0);

  const group = new THREE.Group();
  group.name = 'enemy-sniper';
  group.position.set(position.x, position.y, position.z);
  group.rotation.order = 'YXZ';
  group.rotation.y = yaw;

  const bodyMesh = new THREE.Mesh(body, bodyMaterial);
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  group.add(bodyMesh);

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
  let fall = 0;
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
    knockDown() {
      down = true;
      // The optical cue is gone for as long as he lies there.
      glint.visible = false;
      glintMaterial.opacity = 0;
      glint.removeFromParent();
    },
    reset() {
      down = false;
      fall = 0;
      group.rotation.z = 0;
      glint.visible = false;
      glintMaterial.opacity = 0;
      rifle.add(glint);
    },
    update(frameDt: number) {
      if (!down) return;
      const dt = Number.isFinite(frameDt) && frameDt > 0 ? frameDt : 0;
      fall = Math.min(1, fall + dt * FALL_RATE);
      group.rotation.z = fall * FALL_ROLL;
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
    },
  };
}
