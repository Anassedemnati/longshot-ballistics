import * as THREE from 'three';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Rifle } from '../ballistics/types';
import { BOLT_TIME_S, RELOAD_TIME_S } from '../game/weapon';
import { SKY_OBJECT_NAMES } from '../scene/sky';
import { rifleEnvironment } from './rifleEnvironment';
import { GRIP_CENTER, GRIP_LEAN_RAD, addHands } from './rifleHands';
import { type MaterialKey, PartSet, type PartStyle } from './rifleParts';
import { rifleTextures } from './rifleTextures';

// The visible rifle (spec B.3, C.5): a camera-local model with its own scene and camera, drawn after the world with
// the depth buffer cleared so it never sinks into terrain. Modelled after public/references/rifle-concept.png.
// PBR finish: anodised / cerakote metal (roughness and metalness maps, edge wear in the vertex colours), stippled
// polymer, rubber, a coated glass scope lens, camo-tan gloves. Lit by the world's own light once `lightFrom` has taken
// it (the HDRI environment and the sun, turned with the view, so the rifle is in the same sky as the terrain); until
// then, and for good without the HDRI, by a small environment of its own (the sky stand-in of rifleEnvironment.ts).
// All parts are baked into one mesh per material (7 draw calls at most) and built once; nothing here allocates per frame.

/** Barrel length by rifle, m: the .338 is the longer rifle. */
export const BARREL_LENGTH_M: Readonly<Record<Rifle['id'], number>> = { '308': 0.36, '338': 0.47 };
/** Stock colour by rifle: .308 olive polymer, .338 sand chassis. */
const STOCK_COLOR: Readonly<Record<Rifle['id'], number>> = { '308': 0x535c3d, '338': 0x957f5c };
/** The grip's rubber overmould by rifle: a darker shade of the stock. */
const GRIP_COLOR: Readonly<Record<Rifle['id'], number>> = { '308': 0x3d4430, '338': 0x8a7656 };

/** Where the barrel starts (the receiver's front), m along the model's z axis (negative = forward). */
const BARREL_START_Z = -0.5;
/** Barrel height above the model origin, m. */
const BARREL_Y = 0.04;
/** The suppressor is this long, m, and sits on the muzzle. */
export const SUPPRESSOR_LENGTH_M = 0.19;

/** Scope axis height, m: a 30 mm tube on medium rings, its 56 mm objective just clearing the rail. */
const SCOPE_Y = 0.106;
/** Where the handguard ends, m along z; the barrel runs on alone from here. */
const HANDGUARD_FRONT_Z = -0.49;
/** Smooth normals across bevels and curves, hard at creases sharper than this, rad. */
const CREASE_RAD = (40 * Math.PI) / 180;
/** Cross-sections (x, y) of the dark slots: an M-LOK slot or the ejection port on a side face, a muzzle brake port. */
const SLOT: readonly OutlinePoint[] = [
  [-0.0008, -0.0045],
  [0.0008, -0.0045],
  [0.0008, 0.0045],
  [-0.0008, 0.0045],
];
const BRAKE_PORT: readonly OutlinePoint[] = [
  [-0.002, -0.006],
  [0.002, -0.006],
  [0.002, 0.006],
  [-0.002, 0.006],
];

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
const Y_AXIS = new THREE.Vector3(0, 1, 0);
/** The exposure the rifle's light is balanced for (the valley's), and the limits of its compensation for another theme's. */
export const RIFLE_REFERENCE_EXPOSURE = 0.85;
const RIFLE_GAIN_MIN = 0.5;
const RIFLE_GAIN_MAX = 1.3;
/** In the world's light the fill from the right is this share of the sun's strength, and the key sits this far out, m. */
const FILL_WORLD_SHARE = 0.08;
const KEY_DISTANCE_M = 5;
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
/**
 * Colour gain of the flash sprites when the rifle is drawn into the post chain's HDR target (the world's light units, where a
 * sunlit surface is about 1-3): far above the bloom threshold, so the flash glows. Drawn straight to the canvas it stays 1.
 */
export const FLASH_HDR_GAIN = 14;
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
      normalScale: new THREE.Vector2(0.3, 0.3),
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

/** A point of an outline: [u, v] and, optionally, how far its corner is rounded off (else the outline's own radius), m. */
type OutlinePoint = readonly [number, number, number?];

/** A closed outline through `points` (in order) with each corner rounded off by up to `radius` m. */
function roundedOutline(points: readonly OutlinePoint[], radius: number): THREE.Shape {
  const shape = new THREE.Shape();
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const [px, py] = points[(i + n - 1) % n];
    const [cx, cy, own] = points[i];
    const [nx, ny] = points[(i + 1) % n];
    const inLength = Math.hypot(cx - px, cy - py);
    const outLength = Math.hypot(nx - cx, ny - cy);
    const r = Math.min(own ?? radius, inLength / 2, outLength / 2);
    const ax = cx + ((px - cx) / inLength) * r;
    const ay = cy + ((py - cy) / inLength) * r;
    if (i === 0) shape.moveTo(ax, ay);
    else shape.lineTo(ax, ay);
    shape.quadraticCurveTo(cx, cy, cx + ((nx - cx) / outLength) * r, cy + ((ny - cy) / outLength) * r);
  }
  shape.closePath();
  return shape;
}

/**
 * `shape` extruded `depth` m along z (centred on z = 0) with a rounded bevel of `bevel` m all round its outline, and
 * smooth normals across the bevel and the curves (hard only at the sharper creases): a moulded or machined part.
 */
function extruded(shape: THREE.Shape, depth: number, bevel: number): THREE.BufferGeometry {
  const core = Math.max(0.001, depth - 2 * bevel);
  const raw = new THREE.ExtrudeGeometry(shape, {
    depth: core,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: -bevel, // the bevel ends on the outline: the part is exactly as big as drawn
    bevelSegments: 3,
    curveSegments: 6,
  });
  raw.translate(0, 0, -core / 2);
  const smooth = toCreasedNormals(raw, CREASE_RAD);
  if (smooth !== raw) raw.dispose();
  return smooth;
}

/**
 * A part cut from a side profile: `outline` is (z, y) points in model space, `holes` are cut through it, and the
 * part is `width` m across, centred on x = 0. Stock, grip, chassis, cheek rest.
 */
interface SidePartOptions {
  /** Corner rounding, m. */
  radius?: number;
  /** Edge bevel, m. */
  bevel?: number;
  /** Outlines cut through the part. */
  holes?: readonly (readonly OutlinePoint[])[];
  /** The outline is drawn about `at` and turned `lean` rad about x there (the pistol grip). */
  lean?: number;
  at?: THREE.Vector3;
}

/**
 * A part cut from a side profile: `outline` is (z, y) points in model space (or about `at`), and the part is `width` m
 * across, centred on x = 0. Chassis, stock, grip, cheek riser.
 */
function sidePart(parts: PartSet, material: MaterialKey, outline: readonly OutlinePoint[], width: number, style: PartStyle, options: SidePartOptions = {}): void {
  const { radius = 0.006, bevel = 0.004, holes = [], lean = 0, at } = options;
  const shape = roundedOutline(outline, radius);
  for (const hole of holes) shape.holes.push(roundedOutline(hole, radius));
  // The shape is drawn in (z, y): a quarter turn about y lays it on the model's side (shape x -> model z).
  parts.add(material, extruded(shape, width, bevel), at?.x ?? 0, at?.y ?? 0, at?.z ?? 0, lean, -Math.PI / 2, 0, style);
}

/** A part with the cross-section `outline` ((x, y) points about its axis) running from `zFront` to `zBack`. */
function lengthPart(
  parts: PartSet,
  material: MaterialKey,
  outline: readonly OutlinePoint[],
  zFront: number,
  zBack: number,
  x: number,
  y: number,
  style: PartStyle,
  { radius = 0.004, bevel = 0.003 } = {},
): void {
  parts.add(material, extruded(roundedOutline(outline, radius), zBack - zFront, bevel), x, y, (zFront + zBack) / 2, 0, 0, 0, style);
}

/** An arc of a ring of `radius` (tube `tube`) in the model's yz plane, centred at (y, z), from angle `from` sweeping `arc` (0 = forward). */
function ringArc(parts: PartSet, radius: number, tube: number, y: number, z: number, from: number, arc: number, style: PartStyle, squash = 1): void {
  const geometry = new THREE.TorusGeometry(radius, tube, 8, 24, arc);
  geometry.rotateZ(from);
  geometry.scale(1, squash, 1);
  // The torus lies in xy: a quarter turn about y puts its x (forward at angle 0) on the model's -z.
  parts.add('metal', geometry, 0, y, z, 0, Math.PI / 2, 0, style);
}

/**
 * Build the rifle model (no WebGL needed), after public/references/rifle-concept.png: a bolt action on a chassis with
 * a slotted handguard, moulded pistol grip and a stock with a cheek riser (solid on the .308, skeleton on the .338),
 * a 30 mm scope on a rail, the gloved hands holding grip and handguard (unless `hands` is false), the bolt handle as its
 * own small group, and - only when `suppressed` - a suppressor group on the muzzle. The camera looks down -z; +x is to
 * the right. One mesh per surface: stock (polymer / cerakote), metal, rubber, glass, glove.
 */
export function buildRifleModel(id: Rifle['id'], suppressed: boolean, hands = true): RifleModel {
  const materials = makeMaterials(id);
  const group = new THREE.Group();
  const body = new PartSet();
  const length = BARREL_LENGTH_M[id];
  const shell: PartStyle = { wear: 0.35 };
  const black: PartStyle = { color: ANODISED, wear: 0.5 };
  const dark: PartStyle = { color: BORE };
  const bare: PartStyle = { color: STEEL };

  // Chassis: the receiver bedding, the magazine well below it and the trigger area; the handguard runs forward from it.
  sidePart(
    body,
    'stock',
    [
      [-0.2, 0.034],
      [0.08, 0.034],
      [0.08, -0.03],
      [0.01, -0.044],
      [-0.085, -0.044],
      [-0.092, -0.082, 0.004],
      [-0.205, -0.082, 0.004],
      [-0.205, 0.006],
    ],
    0.05,
    shell,
  );
  // Handguard: a long chamfered tube round the barrel with rows of M-LOK slots, a rail on top.
  const guardY = 0.032;
  const guard: OutlinePoint[] = [
    [-0.026, -0.014],
    [-0.015, -0.026],
    [0.015, -0.026],
    [0.026, -0.014],
    [0.026, 0.017],
    [0.017, 0.026],
    [-0.017, 0.026],
    [-0.026, 0.017],
  ];
  lengthPart(body, 'stock', guard, HANDGUARD_FRONT_Z, -0.19, 0, guardY, shell);
  for (let i = 0; i < 6; i++) {
    const z = -0.235 - i * 0.043;
    for (const side of [-1, 1]) {
      lengthPart(body, 'metal', SLOT, z - 0.014, z + 0.014, side * 0.0262, guardY + 0.002, dark, { radius: 0.003, bevel: 0.0004 });
    }
  }

  // Pistol grip: moulded, finger grooves down the front, a palm swell behind, a flared heel.
  sidePart(
    body,
    'rubber',
    [
      [-0.022, 0.07],
      [0.03, 0.07],
      [0.031, 0.02, 0.02],
      [0.034, -0.035, 0.02],
      [0.03, -0.07],
      [0.02, -0.08],
      [-0.027, -0.08],
      [-0.025, -0.055],
      [-0.019, -0.042, 0.008],
      [-0.025, -0.026, 0.008],
      [-0.019, -0.01, 0.008],
      [-0.025, 0.006, 0.008],
      [-0.02, 0.026],
    ],
    0.036,
    { color: GRIP_COLOR[id], wear: 0.2 },
    { radius: 0.005, bevel: 0.006, lean: GRIP_LEAN_RAD, at: GRIP_CENTER },
  );
  ringArc(body, 0.03, 0.0035, -0.044, -0.045, Math.PI, Math.PI, black, 0.9); // trigger guard, a loop under the chassis
  ringArc(body, 0.015, 0.0028, -0.056, -0.012, -Math.PI * 0.3, Math.PI * 0.5, bare); // the trigger blade, curved back
  body.box('metal', 0.008, 0.012, 0.01, 0, -0.05, -0.09, 0, bare); // magazine release, ahead of the guard

  // Buttstock: a straight comb back to the butt, a toe hook below; skeletonised on the .338.
  const butt = 0.385;
  const stockWidth = id === '338' ? 0.04 : 0.048;
  sidePart(
    body,
    'stock',
    [
      [0.07, 0.034],
      [butt, 0.034, 0.008],
      [butt, -0.126, 0.012],
      [0.335, -0.124, 0.01],
      [0.318, -0.1, 0.012],
      [0.27, -0.094],
      [0.19, -0.072],
      [0.11, -0.046],
      [0.07, -0.032],
    ],
    stockWidth,
    shell,
    {
      holes:
        id === '338'
          ? [
              [
                [0.12, 0.012],
                [0.31, 0.012],
                [0.31, -0.07],
                [0.27, -0.074],
                [0.19, -0.054],
                [0.13, -0.034],
              ],
            ]
          : [],
      radius: 0.008,
    },
  );
  // The seam where the stock meets the chassis, and a sling cup in the butt.
  body.box('metal', 0.0505, 0.064, 0.0015, 0, 0.001, 0.0745, 0, dark);
  body.tube('metal', 0.0078, 0.0078, stockWidth + 0.0012, 0, -0.075, 0.36, Math.PI / 2, Math.PI / 2, bare);
  body.tube('metal', 0.0055, 0.0055, stockWidth + 0.0016, 0, -0.075, 0.36, Math.PI / 2, Math.PI / 2, dark);
  // Cheek riser on two posts, and the butt pad with its ribs.
  sidePart(
    body,
    id === '338' ? 'rubber' : 'stock',
    [
      [0.13, 0.064, 0.012],
      [0.33, 0.064, 0.012],
      [0.33, 0.042, 0.004],
      [0.13, 0.042, 0.004],
    ],
    0.042,
    id === '338' ? { wear: 0.3 } : shell,
    { bevel: 0.004 },
  );
  for (const z of [0.17, 0.29]) body.tube('metal', 0.0045, 0.0045, 0.012, 0, 0.038, z, 0, 0, bare);
  body.tube('metal', 0.007, 0.007, 0.0525, 0, 0, 0.35, Math.PI / 2, Math.PI / 2, black); // the riser's adjuster knob, through the stock
  body.box('rubber', 0.052, 0.166, 0.022, 0, -0.046, butt + 0.012, 0, { wear: 0.4, round: 0.35 });
  for (let i = 0; i < 6; i++) body.box('rubber', 0.054, 0.004, 0.018, 0, -0.105 + i * 0.024, butt + 0.013, 0, { wear: 0.2 });
  for (const [y, z] of [
    [-0.1, 0.3],
    [guardY - 0.027, -0.45],
  ]) {
    body.tube('metal', 0.0065, 0.0065, 0.004, 0, y, z, 0, 0, bare); // sling studs
  }

  // Receiver (a round action bedded in the chassis), its ejection port and the bolt shroud behind.
  body.tube('metal', 0.0175, 0.0175, 0.25, 0, BARREL_Y, -0.06, Math.PI / 2, 0, { color: BLUED, wear: 0.3 });
  lengthPart(body, 'metal', SLOT, -0.1, -0.03, 0.0168, BARREL_Y + 0.006, dark, { radius: 0.002, bevel: 0.0004 });
  body.lathe(
    'metal',
    [
      [0.0165, 0],
      [0.016, 0.02],
      [0.012, 0.035],
      [0.006, 0.04],
    ],
    0,
    BARREL_Y,
    0.065,
    { color: BLUED, wear: 0.3 },
  );

  // Barrel (tapering toward the muzzle), the muzzle brake with three ports a side, and the dark bore.
  body.tube('metal', 0.0105, 0.0125, length + 0.32, 0, BARREL_Y, BARREL_START_Z + 0.32 - (length + 0.32) / 2, Math.PI / 2, 0, { color: BLUED, wear: 0.2 });
  body.tube('metal', 0.0145, 0.0145, 0.065, 0, BARREL_Y, BARREL_START_Z - 0.01 - length, Math.PI / 2, 0, { color: BLUED, wear: 0.6 });
  for (let i = 0; i < 3; i++) {
    const back = BARREL_START_Z + 0.016 - length - i * 0.016; // the brake spans 0.0225 m behind to 0.0425 m ahead of the barrel's end
    for (const side of [-1, 1]) {
      lengthPart(body, 'metal', BRAKE_PORT, back - 0.011, back, side * 0.0128, BARREL_Y, dark, { radius: 0.002, bevel: 0.0005 });
    }
  }
  body.tube('metal', 0.0062, 0.0062, 0.001, 0, BARREL_Y, BARREL_START_Z - 0.0425 - length, Math.PI / 2, 0, dark);

  // Picatinny rail from the receiver over the handguard, with its cross slots.
  const railTop = BARREL_Y + 0.027;
  body.box('metal', 0.021, 0.009, 0.5, 0, railTop - 0.0045, -0.2, 0, black);
  for (let i = 0; i < 50; i++) body.box('metal', 0.0215, 0.0028, 0.0052, 0, railTop + 0.0014, -0.445 + i * 0.01, 0, black);

  // Scope (30 mm tube, 56 mm objective): rings on the rail, tube, eyepiece and its rear lens, the turret saddle and
  // turrets, the objective bell with its gold ring and front lens.
  for (const z of [-0.035, -0.225]) {
    body.box('metal', 0.026, 0.03, 0.02, 0, railTop + 0.012, z, 0, black);
    body.tube('metal', 0.0182, 0.0182, 0.02, 0, SCOPE_Y, z, Math.PI / 2, 0, black);
    body.tube('metal', 0.005, 0.005, 0.034, 0, railTop + 0.006, z, Math.PI / 2, Math.PI / 2, bare); // the cross bolt
  }
  body.tube('metal', 0.015, 0.015, 0.32, 0, SCOPE_Y, -0.14, Math.PI / 2, 0, { color: ANODISED, wear: 0.4 });
  // Eyepiece: z 0.0025 .. 0.0875, the power ring, then the eyecup, hollow at the rear for the lens.
  body.lathe(
    'metal',
    [
      [0.0155, 0],
      [0.0195, 0.012],
      [0.0195, 0.05],
      [0.0215, 0.06],
      [0.0215, 0.085],
      [0.0215, 0.085],
      [0.0178, 0.085],
      [0.0178, 0.085],
      [0.0178, 0.077],
    ],
    0,
    SCOPE_Y,
    0.0025,
    { color: ANODISED, wear: 0.4 },
  );
  lens(body, 0.0178, 0.003, 1, SCOPE_Y, 0.0025 + 0.077);
  body.tube('metal', 0.0178, 0.0178, 0.002, 0, SCOPE_Y, 0.0025 + 0.076, Math.PI / 2, 0, dark); // the dark inside behind it
  for (let i = 0; i < 40; i++) {
    const a = (i * Math.PI) / 20;
    body.box('metal', 0.0022, 0.0022, 0.022, Math.cos(a) * 0.0197, SCOPE_Y + Math.sin(a) * 0.0197, 0.034, 0, { color: LIGHT_COAT }); // power ring knurling
  }
  // Turret saddle and turrets: elevation on top, windage on the right, parallax on the left.
  body.box('metal', 0.034, 0.034, 0.046, 0, SCOPE_Y, -0.13, 0, { color: ANODISED, wear: 0.6, round: 0.3 });
  body.tube('metal', 0.0135, 0.0135, 0.026, 0, SCOPE_Y + 0.03, -0.13, 0, 0, { color: ANODISED, wear: 0.5 });
  body.tube('metal', 0.0115, 0.0115, 0.003, 0, SCOPE_Y + 0.0445, -0.13, 0, 0, { color: LIGHT_COAT });
  for (let i = 0; i < 30; i++) {
    const a = (i * Math.PI) / 15;
    body.box('metal', 0.0024, 0.018, 0.0024, Math.cos(a) * 0.0137, SCOPE_Y + 0.033, -0.13 + Math.sin(a) * 0.0137, 0, { color: LIGHT_COAT }); // its ridges
  }
  body.tube('metal', 0.0125, 0.0125, 0.022, 0.026, SCOPE_Y, -0.13, Math.PI / 2, Math.PI / 2, { color: ANODISED, wear: 0.5 });
  body.tube('metal', 0.012, 0.012, 0.02, -0.025, SCOPE_Y, -0.13, Math.PI / 2, Math.PI / 2, { color: ANODISED, wear: 0.5 });
  for (const x of [0.0375, -0.0355]) body.tube('metal', 0.0105, 0.0105, 0.002, x, SCOPE_Y, -0.13, Math.PI / 2, Math.PI / 2, { color: LIGHT_COAT });
  // Objective bell: z -0.44 (front) .. -0.30, flaring from the tube, recessed at the front for the lens.
  body.lathe(
    'metal',
    [
      [0.0275, 0.013],
      [0.0275, 0],
      [0.0275, 0],
      [0.0305, 0],
      [0.0305, 0],
      [0.0305, 0.045],
      [0.0305, 0.045],
      [0.015, 0.14],
    ],
    0,
    SCOPE_Y,
    -0.44,
    { color: ANODISED, wear: 0.4 },
  );
  lens(body, 0.0275, 0.004, -1, SCOPE_Y, -0.44 + 0.012);
  body.tube('metal', 0.0275, 0.0275, 0.002, 0, SCOPE_Y, -0.44 + 0.013, Math.PI / 2, 0, dark);
  body.tube('metal', 0.0308, 0.0308, 0.0025, 0, SCOPE_Y, -0.398, Math.PI / 2, 0, { color: BRASS }); // the gold coating ring
  for (const z of [-0.15, -0.06, 0.05]) {
    for (const side of [-1, 1]) body.tube('metal', 0.0035, 0.0035, 0.002, side * 0.0255, -0.005, z, Math.PI / 2, Math.PI / 2, bare); // chassis screws
  }

  if (hands) addHands(body);
  for (const mesh of body.toMeshes(materials)) group.add(mesh);

  // The bolt handle: a bent rod out of the receiver's right side and its round knob, local to the pivot.
  const boltParts = new PartSet();
  boltParts.tube('metal', 0.0055, 0.0055, 0.055, 0.042, -0.006, 0, Math.PI / 2, Math.PI / 2 - 0.22, { color: BLUED });
  boltParts.sphere('metal', 0.0115, 0.07, -0.013, 0, { color: ANODISED, wear: 0.5 });
  const bolt = new THREE.Group();
  bolt.name = 'bolt';
  bolt.position.set(BOLT_PIVOT.x, BOLT_PIVOT.y, BOLT_PIVOT.z);
  for (const mesh of boltParts.toMeshes(materials)) bolt.add(mesh);
  group.add(bolt);

  // The suppressor: a can on the muzzle with machined end caps and its dark front opening.
  let muzzleZ = BARREL_START_Z - 0.0425 - length;
  if (suppressed) {
    const can = new PartSet();
    const centre = BARREL_START_Z - 0.12 - length;
    can.tube('metal', 0.022, 0.022, SUPPRESSOR_LENGTH_M, 0, BARREL_Y, centre, Math.PI / 2, 0, { color: CERAKOTE, wear: 0 });
    muzzleZ = centre - SUPPRESSOR_LENGTH_M / 2;
    can.tube('metal', 0.0075, 0.0075, 0.002, 0, BARREL_Y, muzzleZ - 0.001, Math.PI / 2, 0, dark);
    for (const z of [centre + 0.088, centre - 0.088]) can.tube('metal', 0.0228, 0.0228, 0.014, 0, BARREL_Y, z, Math.PI / 2, 0, { color: LIGHT_COAT, wear: 0.6 });
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

  /** Brightness multiplier of the sprites' colour (above 1 only where the target holds HDR values). */
  setGain(gain: number): void {
    this.material.color.setScalar(gain);
  }

  get gain(): number {
    return this.material.color.r;
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
  private readonly hemisphere = new THREE.HemisphereLight(0xeeeadf, 0x8d7654, 0.5);
  private readonly key = new THREE.DirectionalLight(0xffdfad, 2.4);
  private readonly fill = new THREE.DirectionalLight(0xe6eef5, 0.7);
  /** Set by `lightFrom`: the rifle is lit by the world's sun and sky, which `orient` turns with the view. */
  private worldLit = false;
  private readonly sunWorld = new THREE.Vector3();
  private readonly environmentYaw = new THREE.Quaternion();
  private readonly viewInverse = new THREE.Quaternion();
  private readonly environmentTurn = new THREE.Quaternion();
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
    this.key.position.set(-3, 4, 2);
    this.fill.position.set(3, 1, -2);
    this.scene.add(this.hemisphere, this.key, this.fill);
    this.update(0); // settle into the hold pose
  }

  /**
   * Light the rifle with `world`'s sky and sun instead of its own stand-in: the world's image-based light (the PMREM of the
   * HDRI, shared, not copied), the sun's colour and strength, the hemisphere's. Call it when the world has its HDRI
   * (`applyHdriSky`), and only when the rifle is then drawn into the same HDR post chain (so the exposure is the world's and the
   * muzzle flash, given an HDR colour, can bloom: `bloom` says whether the chain has a bloom pass, else the flash keeps its plain colour).
   * `exposure` is the world's tone mapping exposure. Returns false, leaving the stand-in, when the world has no environment.
   * `orient` must then follow the view every frame.
   */
  lightFrom(world: THREE.Scene, exposure: number = RIFLE_REFERENCE_EXPOSURE, bloom = true): boolean {
    const environment = world.environment;
    if (!environment) return false;
    // The sky's exposure differs by theme (the arctic's is high for its dim overcast, the desert's low for its strong sun): the rifle's
    // light is scaled so it reads about the same in all three, not blown out in the snow nor dark in the desert.
    const gain = Math.min(RIFLE_GAIN_MAX, Math.max(RIFLE_GAIN_MIN, RIFLE_REFERENCE_EXPOSURE / exposure));
    this.scene.environment = environment;
    this.scene.environmentIntensity = world.environmentIntensity * gain;
    this.environmentYaw.setFromAxisAngle(Y_AXIS, world.environmentRotation.y);
    this.environmentTried = true; // no stand-in to bake
    const sun = world.getObjectByName(SKY_OBJECT_NAMES.sun) as THREE.DirectionalLight | undefined;
    if (sun) {
      this.key.color.copy(sun.color);
      this.key.intensity = sun.intensity * gain;
      this.sunWorld.copy(sun.position).normalize();
    }
    const hemisphere = world.getObjectByName(SKY_OBJECT_NAMES.hemisphere) as THREE.HemisphereLight | undefined;
    if (hemisphere) {
      this.hemisphere.color.copy(hemisphere.color);
      this.hemisphere.groundColor.copy(hemisphere.groundColor);
      this.hemisphere.intensity = hemisphere.intensity * gain;
    }
    this.fill.intensity = FILL_WORLD_SHARE * (sun ? sun.intensity : 1) * gain;
    this.flash?.setGain(bloom ? FLASH_HDR_GAIN : 1); // an HDR flash only makes sense where a bloom pass will take it
    this.worldLit = true;
    this.orient(this.viewInverse.identity());
    return true;
  }

  /**
   * The post chain was rebuilt (a quality change): tell the rifle whether the new one has a bloom pass. An HDR flash without
   * one is a white blob, so the gain drops back to 1; with one it is `FLASH_HDR_GAIN` again. Only in the world's light.
   */
  setFlashBloom(bloom: boolean): void {
    if (this.worldLit) this.flash?.setGain(bloom ? FLASH_HDR_GAIN : 1);
  }

  /** The muzzle flash's colour gain (1 on the direct path, `FLASH_HDR_GAIN` in the post chain; 0 for a suppressed rifle, which has no flash). */
  get flashGain(): number {
    return this.flash ? this.flash.gain : 0;
  }

  /** Whether `lightFrom` took the world's light. */
  get litByWorld(): boolean {
    return this.worldLit;
  }

  /**
   * Turn the rifle's light with the world camera's orientation `view` (a unit quaternion): the rifle scene's camera is fixed,
   * so the world's sun and sky, which stay put as the player turns, are rotated the opposite way. Allocation-free; does nothing
   * until `lightFrom` has taken the world's light.
   */
  orient(view: THREE.Quaternion): void {
    if (!this.worldLit) return;
    this.viewInverse.copy(view).invert();
    // A direction r of the rifle scene is the world direction q r, which the HDRI (turned by yaw) has at yaw^-1 q r: the
    // environment's rotation is q^-1 * yaw.
    this.scene.environmentRotation.setFromQuaternion(this.environmentTurn.copy(this.viewInverse).multiply(this.environmentYaw));
    this.key.position.copy(this.sunWorld).applyQuaternion(this.viewInverse).multiplyScalar(KEY_DISTANCE_M);
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
