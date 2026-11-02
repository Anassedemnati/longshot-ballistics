import * as THREE from 'three';
import type { Rifle } from '../ballistics/types';
import { BOLT_TIME_S, RELOAD_TIME_S } from '../game/weapon';
import { rifleEnvironment } from './rifleEnvironment';
import { addHands } from './rifleHands';
import { type MaterialKey, PartSet, type PartStyle } from './rifleParts';
import { rifleTextures } from './rifleTextures';

// The visible rifle (spec B.3, C.5): a camera-local model with its own scene and camera, drawn after the world with
// the depth buffer cleared so it never sinks into terrain. Modelled after public/references/rifle-concept.png.
// PBR finish: anodised / cerakote metal (roughness and metalness maps, edge wear in the vertex colours), stippled
// polymer, rubber, a coated glass scope lens, camo-tan gloves; lit by a small environment of its own (the world's sky
// is not in this scene). All parts are baked into one mesh per material (7 draw calls at most) and built once;
// nothing here allocates per frame.

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

/** Scope axis height, m, and the rear lens' radius: the eyepiece faces the shooter. */
const SCOPE_Y = 0.17;

/** Bolt handle pivot (on the bolt axis, in model space), m. */
const BOLT_PIVOT = { x: 0, y: BARREL_Y, z: 0.02 } as const;
/** The raised bolt handle is turned this far about the bolt axis, rad. */
const BOLT_LIFT_RAD = 1.1;
/** The bolt slides this far back, m. */
const BOLT_SLIDE_M = 0.045;

/** Where the rifle sits relative to the camera, m (right, down, forward = -z). */
const HOLD = { x: 0.3, y: -0.26, z: -0.8 } as const;
/** Yaw of the whole model toward the centre of the view (muzzle to the left), rad: shows the rifle's left side. */
const HOLD_YAW_RAD = 0.3;
/** Resting roll, rad. */
const HOLD_ROLL_RAD = -0.06;
/** The rifle's own field of view, deg (independent of the world camera's scope zoom). */
const VIEW_FOV_DEG = 58;
/** Strength of the rifle's own environment light (the sky stand-in, see rifleEnvironment.ts). */
const ENVIRONMENT_INTENSITY = 0.9;

/** Idle breathing: a slow rise and fall, a slower drift, and a tiny tilt. Amplitudes in m / rad, periods in s. */
const BREATH_PERIOD_S = 4.6;
const BREATH_RISE_M = 0.0022;
const BREATH_DRIFT_PERIOD_S = 7.3;
const BREATH_DRIFT_M = 0.0008;
const BREATH_PITCH_RAD = 0.0035;
const BREATH_ROLL_RAD = 0.0015;

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

/** Part colours (sRGB hex): the coats and metals of the rifle. */
const CERAKOTE = 0x4a4e54;
const ANODISED = 0x3a3d42;
const BLUED = 0x32353a;
const STEEL = 0x9a9da1;
/** Ribs, teeth and rings: a lighter coat than the body's. */
const LIGHT_COAT = 0x565a60;
const BRASS = 0xb28a3c;
const BORE = 0x050607;

/** Where the sway of the breathing rifle is, m and rad (see `breathingSway`). */
export interface Sway {
  x: number;
  y: number;
  pitch: number;
  roll: number;
}

/**
 * Idle breathing at time `timeS` (s): a few millimetres of rise and fall with a trace of drift and tilt. Pure and
 * deterministic (the same time gives the same pose); writes into `out`, so it allocates nothing.
 */
export function breathingSway(timeS: number, out: Sway): Sway {
  const breath = Math.sin((timeS * Math.PI * 2) / BREATH_PERIOD_S);
  const drift = Math.sin((timeS * Math.PI * 2) / BREATH_DRIFT_PERIOD_S + 1.3);
  out.x = drift * BREATH_DRIFT_M;
  out.y = breath * BREATH_RISE_M;
  out.pitch = (breath * 0.8 + drift * 0.2) * BREATH_PITCH_RAD;
  out.roll = drift * BREATH_ROLL_RAD;
  return out;
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
  const maps = rifleTextures();
  return {
    // Albedo is in the vertex colours; roughness and metalness come from the packed map (G, B).
    metal: new THREE.MeshStandardMaterial({
      vertexColors: true,
      metalness: 1,
      roughness: 1,
      roughnessMap: maps.metal,
      metalnessMap: maps.metal,
    }),
    // Polymer: the stock colour times the vertex wear, with a stipple normal map.
    stock: new THREE.MeshStandardMaterial({
      color: STOCK_COLOR[id],
      vertexColors: true,
      metalness: 0.02,
      roughness: 0.6,
      normalMap: maps.stipple,
      normalScale: new THREE.Vector2(0.6, 0.6),
    }),
    rubber: new THREE.MeshStandardMaterial({
      vertexColors: true,
      metalness: 0,
      roughness: 0.88,
      normalMap: maps.pebble,
      normalScale: new THREE.Vector2(0.8, 0.8),
    }),
    // Coated glass: a dark teal tint that still reflects (not a black disc), a clear lacquer layer and the thin-film
    // sheen of an anti-reflection coating. No transmission: that would cost a second pass of the scene.
    glass: new THREE.MeshPhysicalMaterial({
      color: 0x3b6a73,
      emissive: 0x03100f,
      metalness: 0.85,
      roughness: 0.03,
      clearcoat: 1,
      clearcoatRoughness: 0.03,
      iridescence: 0.5,
      iridescenceIOR: 1.38,
      iridescenceThicknessMinimum: 180,
      iridescenceThicknessMaximum: 420,
      envMapIntensity: 1.4,
    }),
    glove: new THREE.MeshStandardMaterial({
      vertexColors: true,
      map: maps.fabric,
      normalMap: maps.fabricNormal,
      normalScale: new THREE.Vector2(0.7, 0.7),
      metalness: 0,
      roughness: 0.93,
    }),
  };
}

/**
 * A shallow spherical lens cap (a dome of `radius` m aperture bulging `bulge` m) with its rim plane at `rimZ`, facing
 * the shooter (`+1`) or the muzzle (`-1`). Curved, so it reflects a spread of the environment instead of one flat tone.
 */
function lens(parts: PartSet, radius: number, bulge: number, facing: 1 | -1, y: number, rimZ: number): void {
  const sphereRadius = (radius * radius + bulge * bulge) / (2 * bulge);
  const theta = Math.asin(radius / sphereRadius);
  const dome = new THREE.SphereGeometry(sphereRadius, 40, 10, 0, Math.PI * 2, 0, theta);
  dome.translate(0, -sphereRadius * Math.cos(theta), 0); // rim plane at y = 0, pole at y = bulge
  parts.add('glass', dome, 0, y, rimZ, (facing * Math.PI) / 2);
}

/**
 * Build the rifle model (no WebGL needed): the body parts (butt, cheek rest, receiver, fore-end, grip,
 * magazine, rails, scope), the gloved hands holding grip and fore-end (unless `hands` is false), the bolt handle as
 * its own small group, and - only when `suppressed` - a suppressor group on the muzzle. The camera looks down -z;
 * +x is to the right. One mesh per surface: stock (polymer), metal, rubber, glass, glove.
 */
export function buildRifleModel(id: Rifle['id'], suppressed: boolean, hands = true): RifleModel {
  const materials = makeMaterials(id);
  const group = new THREE.Group();
  const body = new PartSet();
  const length = BARREL_LENGTH_M[id];
  const coat: PartStyle = { color: CERAKOTE, wear: 0.8 };
  const bare: PartStyle = { color: STEEL };

  // Butt, neck, cheek rest on its posts, receiver and fore-end.
  body.box('stock', 0.105, 0.16, 0.2, 0, -0.05, 0.27, 0, { wear: 0.7, round: 0.3 }); // butt
  body.box('stock', 0.064, 0.1, 0.1, 0, -0.03, 0.135, 0, { wear: 0.7 }); // neck, behind the grip
  body.box('rubber', 0.11, 0.175, 0.035, 0, -0.055, 0.385, 0, { wear: 0.4, round: 0.3 }); // butt pad
  body.box('rubber', 0.08, 0.045, 0.2, 0, 0.07, 0.24, 0, { wear: 0.5, round: 0.45 }); // cheek rest
  for (const z of [0.18, 0.3]) body.tube('metal', 0.007, 0.007, 0.03, 0, 0.04, z, 0, 0, { color: ANODISED }); // its posts
  body.box('stock', 0.08, 0.105, 0.26, 0, 0, -0.06, 0, { wear: 0.7 }); // receiver housing
  body.tube('metal', 0.039, 0.039, 0.25, 0, 0.055, -0.065, Math.PI / 2, 0, { color: BLUED });
  body.box('stock', 0.075, 0.075, 0.34, 0, -0.005, -0.34, 0, { wear: 0.7 }); // fore-end
  body.box('stock', 0.065, 0.15, 0.085, 0, -0.12, 0.02, -0.25, { wear: 0.6 }); // pistol grip
  body.box('metal', 0.065, 0.135, 0.095, 0, -0.12, -0.14, 0, { color: ANODISED, wear: 0.9 }); // magazine
  body.box('metal', 0.065, 0.014, 0.12, 0, -0.145, -0.035, 0, { color: ANODISED, wear: 0.5 }); // trigger guard
  body.box('metal', 0.012, 0.085, 0.013, 0.025, -0.08, -0.085, 0, bare); // safety / release
  body.box('metal', 0.009, 0.05, 0.012, 0, -0.06, -0.035, 0.3, bare); // trigger

  // Barrel, muzzle brake (with its side ports) and the dark bore.
  body.tube('metal', 0.015, 0.021, length, 0, BARREL_Y, BARREL_START_Z - length / 2, Math.PI / 2, 0, { color: BLUED }); // tapers toward the muzzle
  body.tube('metal', 0.024, 0.024, 0.065, 0, BARREL_Y, BARREL_START_Z - 0.01 - length, Math.PI / 2, 0, { color: ANODISED });
  for (let i = 0; i < 3; i++) {
    for (const side of [-1, 1]) body.box('rubber', 0.006, 0.02, 0.008, side * 0.0245, BARREL_Y, BARREL_START_Z - 0.006 - length - i * 0.014);
  }
  body.tube('metal', 0.013, 0.013, 0.001, 0, BARREL_Y, BARREL_START_Z - 0.044 - length, Math.PI / 2, 0, { color: BORE });

  // Top rail with its teeth, handguard recesses, magazine fluting.
  body.box('metal', 0.055, 0.016, 0.44, 0, 0.09, -0.19, 0, { color: ANODISED, wear: 0.8 });
  for (let i = 0; i < 24; i++) body.box('metal', 0.062, 0.009, 0.008, 0, 0.102, -0.395 + i * 0.018, 0, { color: LIGHT_COAT });
  for (let i = 0; i < 7; i++) {
    for (const side of [-1, 1]) body.box('rubber', 0.003, 0.018, 0.028, side * 0.038, 0.005, -0.23 - i * 0.038);
  }
  for (let i = 0; i < 4; i++) {
    for (const side of [-1, 1]) body.box('metal', 0.003, 0.095, 0.006, side * 0.033, -0.13, -0.17 + i * 0.02, 0, { color: LIGHT_COAT });
  }

  // Scope: rings, tube, eyepiece with its eyecup and rear lens, objective bell with its coated ring and front lens, turrets.
  for (const z of [-0.04, -0.23]) {
    body.box('metal', 0.07, 0.04, 0.035, 0, 0.125, z, 0, coat);
    body.tube('metal', 0.036, 0.036, 0.028, 0, SCOPE_Y, z, Math.PI / 2, 0, { color: ANODISED });
  }
  body.tube('metal', 0.028, 0.028, 0.32, 0, SCOPE_Y, -0.14, Math.PI / 2, 0, { color: ANODISED });
  // Eyepiece: z 0.0025 .. 0.086, flaring to the eyecup lip, hollow at the rear for the lens.
  body.lathe(
    'metal',
    [
      [0.0405, 0],
      [0.0405, 0.066],
      [0.0405, 0.066],
      [0.0445, 0.07],
      [0.0445, 0.0835],
      [0.0445, 0.0835],
      [0.0375, 0.0835],
      [0.0375, 0.0835],
      [0.0375, 0.0745],
    ],
    0,
    SCOPE_Y,
    0.0025,
    { color: ANODISED },
  );
  lens(body, 0.0375, 0.0065, 1, SCOPE_Y, 0.0025 + 0.0745);
  body.tube('metal', 0.0375, 0.0375, 0.002, 0, SCOPE_Y, 0.0025 + 0.0735, Math.PI / 2, 0, { color: BORE }); // the dark inside behind it
  for (let i = 0; i < 36; i++) {
    const a = (i * Math.PI) / 18;
    body.box('metal', 0.0035, 0.0035, 0.024, Math.cos(a) * 0.0425, SCOPE_Y + Math.sin(a) * 0.0425, 0.04, 0, { color: LIGHT_COAT }); // magnification ring knurling
  }
  // Objective bell: z -0.44 (front) .. -0.29, flaring from the tube, recessed at the front for the lens.
  body.lathe(
    'metal',
    [
      [0.0415, 0.016],
      [0.0415, 0],
      [0.0415, 0],
      [0.0455, 0],
      [0.0455, 0],
      [0.0455, 0.04],
      [0.0455, 0.04],
      [0.029, 0.15],
    ],
    0,
    SCOPE_Y,
    -0.44,
    { color: ANODISED },
  );
  lens(body, 0.0415, 0.0075, -1, SCOPE_Y, -0.44 + 0.015);
  body.tube('metal', 0.0415, 0.0415, 0.002, 0, SCOPE_Y, -0.44 + 0.016, Math.PI / 2, 0, { color: BORE });
  body.tube('metal', 0.0458, 0.0458, 0.003, 0, SCOPE_Y, -0.4, Math.PI / 2, 0, { color: BRASS }); // the gold coating ring
  for (const z of [0.012]) body.tube('metal', 0.0435, 0.0435, 0.006, 0, SCOPE_Y, z, Math.PI / 2, 0, { color: LIGHT_COAT });
  body.tube('metal', 0.024, 0.024, 0.04, 0, 0.215, -0.12, 0, 0, { color: ANODISED }); // elevation turret (axis up)
  body.tube('metal', 0.022, 0.022, 0.035, 0.04, SCOPE_Y, -0.12, Math.PI / 2, Math.PI / 2, { color: ANODISED }); // windage turret (axis sideways)
  body.tube('metal', 0.02, 0.02, 0.03, -0.04, SCOPE_Y, -0.12, Math.PI / 2, Math.PI / 2, { color: ANODISED }); // parallax knob
  for (let i = 0; i < 24; i++) {
    const a = (i * Math.PI) / 12;
    body.box('metal', 0.004, 0.027, 0.004, Math.cos(a) * 0.024, 0.22, -0.12 + Math.sin(a) * 0.024, 0, { color: 0x6a6e73 }); // turret ridges
  }
  for (const z of [-0.25, -0.12, 0.1]) {
    for (const side of [-1, 1]) body.tube('metal', 0.006, 0.006, 0.003, side * 0.052, 0.015, z, Math.PI / 2, Math.PI / 2, bare); // screws
  }

  if (hands) addHands(body);
  for (const mesh of body.toMeshes(materials)) group.add(mesh);

  // The bolt handle: a rod out of the receiver's right side and its knob, local to the pivot.
  const boltParts = new PartSet();
  boltParts.tube('metal', 0.008, 0.008, 0.07, 0.06, 0, 0, Math.PI / 2, Math.PI / 2, bare);
  boltParts.sphere('metal', 0.018, 0.1, -0.004, 0, { color: ANODISED });
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
    can.tube('metal', 0.032, 0.032, SUPPRESSOR_LENGTH_M, 0, BARREL_Y, centre, Math.PI / 2, 0, { color: CERAKOTE, wear: 0 });
    muzzleZ = centre - SUPPRESSOR_LENGTH_M / 2;
    can.tube('metal', 0.016, 0.016, 0.002, 0, BARREL_Y, muzzleZ - 0.001, Math.PI / 2, 0, { color: BORE });
    for (const z of [centre + 0.09, centre - 0.09]) can.tube('metal', 0.0335, 0.0335, 0.008, 0, BARREL_Y, z, Math.PI / 2, 0, { color: LIGHT_COAT });
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
  /** Carries `model` and the breathing sway (kept apart so the sway never mixes with the recoil poses). */
  private readonly holder = new THREE.Group();
  private readonly sway: Sway = { x: 0, y: 0, pitch: 0, roll: 0 };
  /** The rifle's own environment is set up on the first `render` (it needs the renderer); this is true from then on. */
  private environmentTried = false;
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
    this.holder.name = 'holder';
    this.holder.add(this.model);
    this.scene.add(this.holder);
    // A touch of ambient for the frame before the environment map exists, then a key and a fill: the map does the rest.
    this.scene.add(new THREE.HemisphereLight(0xeeeadf, 0x8d7654, 0.5));
    const key = new THREE.DirectionalLight(0xffdfad, 2.4);
    key.position.set(-3, 4, 2);
    const fill = new THREE.DirectionalLight(0xe6eef5, 0.7);
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
    breathingSway(this.time, this.sway);
    this.holder.position.set(this.sway.x, this.sway.y, 0);
    this.holder.rotation.set(this.sway.pitch, 0, this.sway.roll);
    this.model.position.set(
      HOLD.x,
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
    if (!this.environmentTried) {
      this.environmentTried = true;
      try {
        this.scene.environment = rifleEnvironment(renderer);
        this.scene.environmentIntensity = ENVIRONMENT_INTENSITY;
      } catch {
        this.scene.environment = null; // no float render targets or the like: keep the plain lights
      }
    }
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
