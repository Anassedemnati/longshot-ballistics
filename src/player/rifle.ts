import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Rifle } from '../ballistics/types';
import { BOLT_TIME_S, RELOAD_TIME_S } from '../game/weapon';

// The visible rifle (spec B.3): a camera-local model with its own scene and camera, drawn after the world with
// the depth buffer cleared so it never sinks into terrain. Modelled after public/references/rifle-concept.png.
// All parts are baked into one mesh per material (about 8 draw calls in all) and built once; nothing here
// allocates per frame.

/** Barrel length by rifle, m: the .338 is the longer rifle. */
export const BARREL_LENGTH_M: Readonly<Record<Rifle['id'], number>> = { '308': 0.36, '338': 0.47 };
/** Stock colour by rifle: .308 olive polymer, .338 sand chassis. */
const STOCK_COLOR: Readonly<Record<Rifle['id'], number>> = { '308': 0x62654a, '338': 0xb39a72 };

/** Where the barrel starts (the receiver's front), m along the model's z axis (negative = forward). */
const BARREL_START_Z = -0.5;
/** Barrel height above the model origin, m. */
const BARREL_Y = 0.04;
/** The suppressor is this long, m, and sits on the muzzle. */
export const SUPPRESSOR_LENGTH_M = 0.19;

/** Bolt handle pivot (on the bolt axis, in model space), m. */
const BOLT_PIVOT = { x: 0, y: BARREL_Y, z: 0.02 } as const;
/** The raised bolt handle is turned this far about the bolt axis, rad. */
const BOLT_LIFT_RAD = 1.1;
/** The bolt slides this far back, m. */
const BOLT_SLIDE_M = 0.045;

/** Where the rifle sits relative to the camera, m (right, down, forward = -z). */
const HOLD = { x: 0.21, y: -0.24, z: -0.49 } as const;
/** Slight yaw of the whole model toward the centre of the view, rad. */
const HOLD_YAW_RAD = -0.09;
/** Resting roll, rad. */
const HOLD_ROLL_RAD = -0.025;
/** The rifle's own field of view, deg (independent of the world camera's scope zoom). */
const VIEW_FOV_DEG = 55;
/** Idle sway: amplitude m and speed rad/s. */
const SWAY_M = 0.002;
const SWAY_SPEED = 1.2;

/** Recoil: the kick fades as exp(-KICK_DECAY * t); it pushes the rifle back and tips the muzzle up. */
const KICK_DECAY = 13;
const KICK_BACK_M = 0.065;
const KICK_PITCH_RAD = 0.09;

/** Reload motion: the rifle dips, pitches the muzzle down and rolls, then comes back. */
const RELOAD_DIP_M = 0.18;
const RELOAD_PITCH_RAD = 0.3;
const RELOAD_ROLL_RAD = 0.25;

/** The muzzle flash lasts this long, s. */
const FLASH_TIME_S = 0.085;
/** Peak flash light, in the rifle scene only (the world is not lit by it), and its reach, m. */
const FLASH_LIGHT_INTENSITY = 3;
const FLASH_LIGHT_RANGE_M = 2;
const FLASH_LIGHT_COLOR = 0xffa344;
/** Sprite sizes, m: the flame and the hot core in front of it. */
const FLAME_SIZE_M = 0.23;
const CORE_SIZE_M = 0.12;
/** The flame starts this far in front of the barrel's muzzle end, m. */
const FLASH_GAP_M = 0.026;

type MaterialKey = 'metal' | 'edge' | 'stock' | 'rubber' | 'glass';

/** The part-by-part geometry of one rifle, collected per material and then baked into one mesh per material. */
class PartSet {
  private readonly byMaterial = new Map<MaterialKey, THREE.BufferGeometry[]>();
  private readonly matrix = new THREE.Matrix4();
  private readonly euler = new THREE.Euler();

  /** Put `geometry` at (x, y, z), turned by the Euler angles (XYZ order), and file it under `material`. */
  add(material: MaterialKey, geometry: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): void {
    this.euler.set(rx, ry, rz, 'XYZ');
    this.matrix.makeRotationFromEuler(this.euler).setPosition(x, y, z);
    geometry.applyMatrix4(this.matrix);
    // Rounded boxes are not indexed and cylinders are; a merge needs them all alike.
    const part = geometry.index ? geometry.toNonIndexed() : geometry;
    if (part !== geometry) geometry.dispose();
    const list = this.byMaterial.get(material);
    if (list) list.push(part);
    else this.byMaterial.set(material, [part]);
  }

  /** A box of w x h x d with softened edges (plain for slivers, where rounding would only add triangles). */
  box(material: MaterialKey, w: number, h: number, d: number, x: number, y: number, z: number, rx = 0): void {
    const smallest = Math.min(w, h, d);
    const geometry = smallest < 0.02 ? new THREE.BoxGeometry(w, h, d) : new RoundedBoxGeometry(w, h, d, 2, smallest * 0.15);
    this.add(material, geometry, x, y, z, rx);
  }

  /**
   * A cylinder (or cone: `rFront` is the radius at the muzzle end) along the z axis by default; `rx/rz` turn it.
   * Small tubes get fewer sides.
   */
  tube(material: MaterialKey, rFront: number, rBack: number, length: number, x: number, y: number, z: number, rx = Math.PI / 2, rz = 0): void {
    const radius = Math.max(rFront, rBack);
    const sides = radius >= 0.03 ? 32 : radius >= 0.015 ? 20 : 10;
    // CylinderGeometry has its +y end (radiusTop) toward the shooter once turned about x.
    this.add(material, new THREE.CylinderGeometry(rBack, rFront, length, sides), x, y, z, rx, 0, rz);
  }

  sphere(material: MaterialKey, radius: number, x: number, y: number, z: number): void {
    this.add(material, new THREE.SphereGeometry(radius, 16, 10), x, y, z);
  }

  /** One mesh per material, in `materials`' colours; the part geometry is merged and then released. */
  toMeshes(materials: Readonly<Record<MaterialKey, THREE.Material>>): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    for (const [key, list] of this.byMaterial) {
      const merged = mergeGeometries(list);
      if (!merged) throw new Error(`rifle: parts of '${key}' could not be merged`);
      for (const part of list) part.dispose();
      const mesh = new THREE.Mesh(merged, materials[key]);
      mesh.name = key;
      mesh.frustumCulled = false; // always within a hand's reach of the camera
      meshes.push(mesh);
    }
    return meshes;
  }
}

/** What `buildRifleModel` returns. */
export interface RifleModel {
  /** Everything that recoils together. */
  group: THREE.Group;
  /** The bolt handle and knob (a child of `group`), pivoting on the bolt axis. */
  bolt: THREE.Group;
  /** z of the front of the muzzle device (the suppressor's end when fitted), m. */
  muzzleZ: number;
}

function makeMaterials(id: Rifle['id']): Record<MaterialKey, THREE.Material> {
  return {
    metal: new THREE.MeshStandardMaterial({ color: 0x30343a, metalness: 0.35, roughness: 0.32 }),
    edge: new THREE.MeshStandardMaterial({ color: 0x62666a, metalness: 0.4, roughness: 0.42 }),
    stock: new THREE.MeshStandardMaterial({ color: STOCK_COLOR[id], metalness: 0.12, roughness: 0.8 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x161b1c, roughness: 0.95 }),
    glass: new THREE.MeshPhysicalMaterial({ color: 0x214b59, metalness: 0.65, roughness: 0.08, clearcoat: 1 }),
  };
}

/**
 * Build the rifle model (no WebGL needed): the body parts (butt, cheek rest, receiver, fore-end, grip,
 * magazine, rails, scope), the bolt handle as its own small group, and - only when `suppressed` - a
 * suppressor group on the muzzle. The camera looks down -z; +x is to the right.
 */
export function buildRifleModel(id: Rifle['id'], suppressed: boolean): RifleModel {
  const materials = makeMaterials(id);
  const group = new THREE.Group();
  const body = new PartSet();
  const length = BARREL_LENGTH_M[id];

  // Butt, cheek rest, receiver and fore-end.
  body.box('stock', 0.105, 0.16, 0.27, 0, -0.05, 0.2);
  body.box('rubber', 0.11, 0.175, 0.035, 0, -0.055, 0.35); // butt pad
  body.box('rubber', 0.105, 0.055, 0.18, 0, 0.055, 0.19); // cheek rest
  body.box('stock', 0.08, 0.105, 0.26, 0, 0, -0.06); // receiver housing
  body.tube('metal', 0.039, 0.039, 0.25, 0, 0.055, -0.065);
  body.box('stock', 0.075, 0.075, 0.34, 0, -0.005, -0.34); // fore-end
  body.box('rubber', 0.065, 0.15, 0.085, 0, -0.12, 0.02, -0.25); // pistol grip
  body.box('metal', 0.065, 0.135, 0.095, 0, -0.12, -0.14); // magazine
  body.box('metal', 0.065, 0.014, 0.12, 0, -0.13, -0.035); // trigger guard
  body.box('metal', 0.012, 0.085, 0.013, 0.025, -0.08, -0.085); // safety / release
  body.box('edge', 0.009, 0.05, 0.012, 0, -0.06, -0.035, 0.3); // trigger

  // Barrel, muzzle crown and the dark bore.
  body.tube('metal', 0.015, 0.021, length, 0, BARREL_Y, BARREL_START_Z - length / 2); // tapers toward the muzzle
  body.tube('metal', 0.024, 0.024, 0.065, 0, BARREL_Y, BARREL_START_Z - 0.01 - length);
  body.tube('rubber', 0.013, 0.013, 0.001, 0, BARREL_Y, BARREL_START_Z - 0.044 - length);

  // Top rail with its teeth, handguard recesses, magazine fluting.
  body.box('metal', 0.055, 0.016, 0.44, 0, 0.09, -0.19);
  for (let i = 0; i < 24; i++) body.box('edge', 0.062, 0.009, 0.008, 0, 0.102, -0.395 + i * 0.018);
  for (let i = 0; i < 7; i++) {
    for (const side of [-1, 1]) body.box('rubber', 0.003, 0.018, 0.028, side * 0.038, 0.005, -0.23 - i * 0.038);
  }
  for (let i = 0; i < 4; i++) {
    for (const side of [-1, 1]) body.box('edge', 0.003, 0.095, 0.006, side * 0.033, -0.13, -0.17 + i * 0.02);
  }

  // Scope: rings, tube, eyepiece, objective bell, lenses, turrets.
  for (const z of [-0.04, -0.23]) {
    body.box('metal', 0.07, 0.04, 0.035, 0, 0.125, z);
    body.tube('edge', 0.036, 0.036, 0.028, 0, 0.17, z);
  }
  body.tube('metal', 0.028, 0.028, 0.32, 0, 0.17, -0.14);
  body.tube('metal', 0.041, 0.041, 0.085, 0, 0.17, 0.045);
  body.tube('metal', 0.045, 0.029, 0.11, 0, 0.17, -0.35);
  body.tube('metal', 0.046, 0.046, 0.035, 0, 0.17, -0.42);
  body.tube('glass', 0.035, 0.035, 0.002, 0, 0.17, 0.089);
  body.tube('glass', 0.04, 0.04, 0.002, 0, 0.17, -0.439);
  for (const z of [0.012, 0.078, -0.407]) body.tube('edge', 0.043, 0.043, 0.008, 0, 0.17, z);
  body.tube('metal', 0.024, 0.024, 0.04, 0, 0.215, -0.12, 0); // elevation turret (axis up)
  body.tube('metal', 0.022, 0.022, 0.035, 0.04, 0.17, -0.12, Math.PI / 2, Math.PI / 2); // windage turret (axis sideways)
  for (let i = 0; i < 24; i++) {
    const a = (i * Math.PI) / 12;
    body.box('edge', 0.004, 0.027, 0.004, Math.cos(a) * 0.024, 0.22, -0.12 + Math.sin(a) * 0.024); // turret ridges
  }
  for (const z of [-0.25, -0.12, 0.1]) {
    for (const side of [-1, 1]) body.tube('edge', 0.006, 0.006, 0.003, side * 0.052, 0.015, z, Math.PI / 2, Math.PI / 2); // screws
  }

  for (const mesh of body.toMeshes(materials)) group.add(mesh);

  // The bolt handle: a rod out of the receiver's right side and its knob, local to the pivot.
  const boltParts = new PartSet();
  boltParts.tube('edge', 0.008, 0.008, 0.07, 0.06, 0, 0, Math.PI / 2, Math.PI / 2);
  boltParts.sphere('edge', 0.018, 0.1, -0.004, 0);
  const bolt = new THREE.Group();
  bolt.name = 'bolt';
  bolt.position.set(BOLT_PIVOT.x, BOLT_PIVOT.y, BOLT_PIVOT.z);
  for (const mesh of boltParts.toMeshes(materials)) bolt.add(mesh);
  group.add(bolt);

  // The suppressor: a fat tube on the muzzle and its dark front opening.
  let muzzleZ = BARREL_START_Z - 0.0425 - length;
  if (suppressed) {
    const can = new PartSet();
    const centre = BARREL_START_Z - 0.12 - length;
    can.tube('metal', 0.032, 0.032, SUPPRESSOR_LENGTH_M, 0, BARREL_Y, centre);
    muzzleZ = centre - SUPPRESSOR_LENGTH_M / 2;
    can.tube('rubber', 0.016, 0.016, 0.002, 0, BARREL_Y, muzzleZ - 0.001);
    const suppressor = new THREE.Group();
    suppressor.name = 'suppressor';
    for (const mesh of can.toMeshes(materials)) suppressor.add(mesh);
    group.add(suppressor);
  }

  return { group, bolt, muzzleZ };
}

/** 0 before `a`, 1 after `b`, a smooth ramp between. */
function smooth(p: number, a: number, b: number): number {
  const t = Math.min(1, Math.max(0, (p - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * How far the bolt handle is raised (rad) `progress` (0..1) of the way through the bolt cycle: it waits
 * for the muzzle blast to pass, lifts, and drops again before the cycle ends.
 */
export function boltLift(progress: number): number {
  return BOLT_LIFT_RAD * (smooth(progress, 0.2, 0.32) - smooth(progress, 0.78, 0.9));
}

/** How far the bolt has slid back (m) at `progress` of the cycle: back once lifted, forward before it drops. */
export function boltSlide(progress: number): number {
  return BOLT_SLIDE_M * (smooth(progress, 0.32, 0.5) - smooth(progress, 0.55, 0.75));
}

/** A soft additive flame (ragged star shape, white-yellow core fading to orange). Built once. */
function flameTexture(): THREE.DataTexture {
  const size = 64;
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5 - size / 2) / (size / 2);
      const dy = (y + 0.5 - size / 2) / (size / 2);
      const edge = 0.7 + 0.16 * Math.cos(Math.atan2(dy, dx) * 5);
      const alpha = Math.pow(Math.max(0, 1 - Math.hypot(dx, dy) / edge), 1.5);
      const i = (y * size + x) * 4;
      pixels[i] = 255;
      pixels[i + 1] = Math.round(110 + 145 * alpha);
      pixels[i + 2] = Math.round(20 + 220 * alpha * alpha);
      pixels[i + 3] = Math.round(255 * alpha);
    }
  }
  const texture = new THREE.DataTexture(pixels, size, size);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/** The flame and its light at the muzzle; follows the rifle's recoil because it is a child of the model. */
class MuzzleFlash {
  readonly group = new THREE.Group();
  readonly light = new THREE.PointLight(FLASH_LIGHT_COLOR, 0, FLASH_LIGHT_RANGE_M, 2);
  private readonly material: THREE.SpriteMaterial;
  private remaining = 0;
  /** True from `trigger` to the next `update`: that first frame is shown even when it was a slow one. */
  private fresh = false;

  constructor(muzzleZ: number) {
    this.material = new THREE.SpriteMaterial({
      map: flameTexture(),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    const flame = new THREE.Sprite(this.material);
    flame.scale.set(FLAME_SIZE_M, FLAME_SIZE_M, 1);
    const core = new THREE.Sprite(this.material);
    core.position.z = -0.07;
    core.scale.set(CORE_SIZE_M, CORE_SIZE_M, 1);
    this.group.add(flame, core);
    this.group.position.set(0, BARREL_Y, muzzleZ - FLASH_GAP_M);
    this.group.visible = false;
    this.light.position.set(0, BARREL_Y + 0.05, muzzleZ + 0.05);
  }

  trigger(): void {
    this.remaining = FLASH_TIME_S;
    this.fresh = true;
    this.material.rotation = Math.random() * Math.PI * 2;
    this.group.scale.setScalar(0.85 + Math.random() * 0.3);
  }

  update(dt: number): void {
    if (!this.fresh) this.remaining = Math.max(0, this.remaining - dt);
    this.fresh = false;
    this.group.visible = this.remaining > 0;
    const brightness = this.remaining / FLASH_TIME_S;
    this.material.opacity = brightness;
    this.light.intensity = brightness * FLASH_LIGHT_INTENSITY;
  }
}

/**
 * The player's own rifle, seen from behind: recoil kick and muzzle flash on `fire()`, a bolt-working motion
 * after a shot that leaves a round to chamber, and a dip on `reload()`. Its own scene, camera and lights keep it
 * apart from the world: `render` draws it on top of what the world pass drew. Pure state plus three.js objects:
 * it builds and animates without WebGL (only `render` needs a renderer).
 * A suppressed rifle has the suppressor fitted and never flashes.
 */
export class FirstPersonRifle {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(VIEW_FOV_DEG, 1, 0.01, 10);
  /** The model group (recoils and dips as a whole). */
  readonly model: THREE.Group;
  private readonly bolt: THREE.Group;
  /** Null when suppressed: a suppressed shot has no flash at all. */
  private readonly flash: MuzzleFlash | null;
  private kick = 0;
  private time = 0;
  private reloadRemaining = 0;
  private reloadDuration = RELOAD_TIME_S;
  /** Time since the bolt cycle started, s; BOLT_TIME_S means no cycle is running. */
  private boltElapsed = BOLT_TIME_S;

  constructor(
    id: Rifle['id'],
    readonly suppressed = false,
  ) {
    const built = buildRifleModel(id, suppressed);
    this.model = built.group;
    this.bolt = built.bolt;
    this.flash = suppressed ? null : new MuzzleFlash(built.muzzleZ);
    if (this.flash) this.model.add(this.flash.group, this.flash.light);
    this.model.rotation.y = HOLD_YAW_RAD;
    this.scene.add(this.model);
    this.scene.add(new THREE.HemisphereLight(0xdcecff, 0x8d7654, 3));
    const key = new THREE.DirectionalLight(0xffdfad, 4);
    key.position.set(-3, 4, 2);
    const fill = new THREE.DirectionalLight(0xc5e0ff, 2);
    fill.position.set(3, 1, -2);
    this.scene.add(key, fill);
    this.update(0); // settle into the hold pose
  }

  /** True while the muzzle flash is on screen (never for a suppressed rifle). */
  get flashVisible(): boolean {
    return this.flash !== null && this.flash.group.visible;
  }

  /** Brightness of the flash's light now (0 when there is none). */
  get flashLightIntensity(): number {
    return this.flash ? this.flash.light.intensity : 0;
  }

  /**
   * A shot went off: kick and (unsuppressed) flash. `boltCycle` is true when a round is left to chamber:
   * the bolt is then worked (it takes BOLT_TIME_S).
   */
  fire(boltCycle = true): void {
    this.kick = 1;
    this.flash?.trigger();
    if (boltCycle) this.boltElapsed = 0;
  }

  /** A reload started: dip and come back over `durationS`. */
  reload(durationS = RELOAD_TIME_S): void {
    if (!(durationS > 0)) return;
    this.reloadDuration = durationS;
    this.reloadRemaining = durationS;
  }

  update(dt: number): void {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    this.time += step;
    this.flash?.update(step);

    this.kick *= Math.exp(-step * KICK_DECAY);
    this.reloadRemaining = Math.max(0, this.reloadRemaining - step);
    const dip = this.reloadRemaining > 0 ? Math.sin(Math.PI * (1 - this.reloadRemaining / this.reloadDuration)) : 0;
    this.model.position.set(
      HOLD.x + Math.sin(this.time * SWAY_SPEED) * SWAY_M,
      HOLD.y - dip * RELOAD_DIP_M,
      HOLD.z + this.kick * KICK_BACK_M,
    );
    this.model.rotation.x = this.kick * KICK_PITCH_RAD - dip * RELOAD_PITCH_RAD;
    this.model.rotation.z = HOLD_ROLL_RAD + dip * RELOAD_ROLL_RAD;

    this.boltElapsed = Math.min(BOLT_TIME_S, this.boltElapsed + step);
    const progress = this.boltElapsed / BOLT_TIME_S;
    this.bolt.rotation.z = boltLift(progress);
    this.bolt.position.z = BOLT_PIVOT.z + boltSlide(progress);
  }

  /** Match the camera to the window (CSS px); call on start and on every resize. */
  resize(width: number, height: number): void {
    if (!(width > 0 && height > 0)) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Draw the rifle over what is already on the canvas: the depth buffer is cleared (the rifle never clips
   * into the world), the colour is kept. The draw calls and triangles are added to `renderer.info`, which the
   * world pass reset at its start, so the readings cover the whole frame.
   */
  render(renderer: THREE.WebGLRenderer): void {
    const { autoClear } = renderer;
    const { autoReset } = renderer.info;
    renderer.autoClear = false;
    renderer.info.autoReset = false;
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = autoClear;
    renderer.info.autoReset = autoReset;
  }
}
