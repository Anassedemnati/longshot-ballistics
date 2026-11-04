import type { Vec3 } from '../ballistics/types';
import type { Material } from '../game/hit';
import type { BoxLook, BoxPart, LocalBox } from './props';

// Pure dimensions of the military-base hardware (no three.js): tanks, towed guns, trucks, a helicopter, sandbag
// emplacements, barriers, towers and camp kit. Same rules as the village props in props.ts, which this file
// feeds (`propBoxes` reads BASE_BOXES): the meshes (scene/baseProps.ts) and the bullet colliders are built from
// these boxes, so a mesh and its collider cannot drift apart.
//
// Local frame: ground at y = 0, origin at the footprint centre, +Z is the front (a gun's muzzle, a vehicle's nose,
// the outward side of a sandbag nest or a tower). Shapes a box cannot be are drawn inside their box by a `look`
// (props.ts `BoxLook`): round prisms (wheels, drums, barrels), tilted tube segments (raised barrels, tripod legs,
// tower braces: one short box per segment, so the empty corners of each box stay small), sandbags filling a box,
// a tent's vault, a ladder. Thin things (rotor blades, antennas, masts, a flag) get thin boxes of their own.
// Every kind is 'metal' unless listed in BASE_MATERIAL; boxes of another material carry their own `material`.

export type BaseKind =
  | 'tank'
  | 'artillery'
  | 'cargoTruck'
  | 'fuelTruck'
  | 'helicopter'
  | 'helipad'
  | 'ammoCrates'
  | 'mgNest'
  | 'radar'
  | 'aaGun'
  | 'watchTower'
  | 'hesco'
  | 'sandbags'
  | 'jersey'
  | 'gate'
  | 'booth'
  | 'tent'
  | 'generator'
  | 'fuelDrums'
  | 'flagPole'
  | 'floodlight'
  | 'camoNet'
  | 'commsMast';

export const BASE_KINDS: readonly BaseKind[] = [
  'tank',
  'artillery',
  'cargoTruck',
  'fuelTruck',
  'helicopter',
  'helipad',
  'ammoCrates',
  'mgNest',
  'radar',
  'aaGun',
  'watchTower',
  'hesco',
  'sandbags',
  'jersey',
  'gate',
  'booth',
  'tent',
  'generator',
  'fuelDrums',
  'flagPole',
  'floodlight',
  'camoNet',
  'commsMast',
];

const BASE_KIND_SET: ReadonlySet<string> = new Set(BASE_KINDS);

export function isBaseKind(kind: string): kind is BaseKind {
  return BASE_KIND_SET.has(kind);
}

// ---------------------------------------------------------------------------------------------
// Box helpers

interface Extra {
  look?: BoxLook;
  yaw?: number;
  sides?: number;
  material?: Material;
}

/** A box from its corners (local frame, m). */
function B(part: BoxPart, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, extra: Extra = {}): LocalBox {
  return {
    center: { x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: (z0 + z1) / 2 },
    halfSize: { x: Math.abs(x1 - x0) / 2, y: Math.abs(y1 - y0) / 2, z: Math.abs(z1 - z0) / 2 },
    part,
    ...extra,
  };
}

/** A box from its centre and half sizes, turned by `yaw` about its own centre. */
function BC(part: BoxPart, cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, extra: Extra = {}): LocalBox {
  return { center: { x: cx, y: cy, z: cz }, halfSize: { x: hx, y: hy, z: hz }, part, ...extra };
}

/** A round prism along `axis` through (cx, cy, cz): radius `r`, half length `hl`, m. */
function round(part: BoxPart, axis: 'x' | 'y' | 'z', cx: number, cy: number, cz: number, r: number, hl: number, extra: Extra = {}): LocalBox {
  const look: BoxLook = axis === 'x' ? 'roundX' : axis === 'y' ? 'roundY' : 'roundZ';
  return BC(part, cx, cy, cz, axis === 'x' ? hl : r, axis === 'y' ? hl : r, axis === 'z' ? hl : r, { look, ...extra });
}

/** A straight tube from `a` to `b` of radius `r`: its box is the tube's exact bounding box. */
export function tubeBox(part: BoxPart, a: Vec3, b: Vec3, r: number, extra: Extra = {}): LocalBox {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dy, dz);
  const half = (d: number): number => Math.abs(d) / 2 + r * Math.sqrt(Math.max(0, 1 - (d / len) ** 2));
  return {
    center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 },
    halfSize: { x: half(dx), y: half(dy), z: half(dz) },
    part,
    look: 'tube',
    tube: { from: { ...a }, to: { ...b }, radius: r },
    ...extra,
  };
}

/** A tube from `a` to `b` cut into `n` equal segments, one box each (a long tilted tube would fill a big empty box). */
function tubeChain(part: BoxPart, a: Vec3, b: Vec3, r: number, n: number, extra: Extra = {}): LocalBox[] {
  const at = (t: number): Vec3 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
  return Array.from({ length: n }, (_, i) => tubeBox(part, at(i / n), at((i + 1) / n), r, extra));
}

/** A point `d` m from `p` along the direction raised `pitch` rad above local +Z (turned `yaw` rad about +Y). */
function along(p: Vec3, pitch: number, d: number, yaw = 0): Vec3 {
  const h = Math.cos(pitch) * d;
  return { x: p.x + Math.sin(yaw) * h, y: p.y + Math.sin(pitch) * d, z: p.z + Math.cos(yaw) * h };
}

/** Sandbag wall segment: `len` m long (along its own x), `depth` m thick, `height` m tall, centred at (x, z), turned by `yaw`. */
function bags(x: number, z: number, len: number, depth: number, height: number, yaw: number): LocalBox {
  return BC('bags', x, height / 2, z, len / 2, height / 2, depth / 2, { look: 'bags', yaw, material: 'wall' });
}

/** Sandbag segments round a ring of radius `r` (to the wall's centre line) at the polar angles `deg` (0 = +Z, 90 = +X). */
function bagRing(r: number, deg: readonly number[], len: number, depth: number, height: number): LocalBox[] {
  return deg.map((d) => {
    const a = (d * Math.PI) / 180;
    // A segment at polar angle a runs along the tangent (cos a, -sin a): exactly a box's +X turned by yaw = a.
    return bags(r * Math.sin(a), r * Math.cos(a), len, depth, height, a);
  });
}

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------------------------
// Armour and guns
//   tank        ~7.1 m hull (10.2 m with the gun), 3.6 m wide over the tracks, 2.6 m to the cupola
//   artillery   towed 155 mm-class howitzer: two 1.1 m wheels, a gun shield, split trails, barrel raised 25 deg
//   aaGun       twin 23 mm-class AA gun on a turntable, barrels raised 55 deg, inside a low sandbag ring

/** The tank's antenna stops below a camouflage net (3.3 m) so the tank can park under one. */
const TANK: LocalBox[] = [
  B('hull', -1.25, 1.25, 0.55, 1.6, -3.5, 3.3),
  B('track', -1.8, -1.25, 0, 1.05, -3.6, 3.5),
  B('track', 1.25, 1.8, 0, 1.05, -3.6, 3.5),
  B('turret', -1.55, 1.55, 1.6, 2.35, -1.7, 1.3),
  B('turret', -1.25, 1.25, 1.65, 2.3, -2.8, -1.7), // bustle
  B('gun', -0.42, 0.42, 1.72, 2.22, 1.3, 1.75), // mantlet
  round('gun', 'z', 0, 1.97, 4.175, 0.085, 2.425), // barrel z 1.75..6.6
  round('gun', 'z', 0, 1.97, 3.95, 0.15, 0.35), // fume extractor z 3.6..4.3
  round('hatch', 'y', -0.6, 2.485, -0.7, 0.36, 0.135, { sides: 16 }), // commander's cupola y 2.35..2.62
  B('antenna', 1.05, 1.08, 2.3, 3.2, -2.6, -2.57),
];

/** Howitzer trunnion (where the barrel pivots), local frame, m, and the barrel's elevation, rad. */
const HOWITZER_PIVOT: Vec3 = { x: 0, y: 1.35, z: 0.3 };
const HOWITZER_PITCH = 25 * DEG;
/** Splay of each trail from the gun's axis, rad. */
const TRAIL_SPLAY = 0.22;

function trail(side: -1 | 1): LocalBox[] {
  const yaw = -side * TRAIL_SPLAY; // the left trail (side -1) turns toward -x as it runs back
  const back = { x: -Math.sin(yaw), z: -Math.cos(yaw) };
  const start = { x: side * 0.3, z: -0.6 };
  const at = (d: number): { x: number; z: number } => ({ x: start.x + back.x * d, z: start.z + back.z * d });
  const mid = at(2.0);
  const end = at(4.0);
  return [BC('frame', mid.x, 0.27, mid.z, 0.09, 0.15, 2.0, { yaw }), BC('frame', end.x, 0.25, end.z, 0.32, 0.25, 0.06, { yaw })];
}

const ARTILLERY: LocalBox[] = [
  round('wheel', 'x', -1.05, 0.55, 0, 0.55, 0.16, { sides: 28 }),
  round('wheel', 'x', 1.05, 0.55, 0, 0.55, 0.16, { sides: 28 }),
  round('frame', 'x', 0, 0.55, 0, 0.05, 0.89), // axle
  B('frame', -0.45, 0.45, 0.55, 1.05, -0.6, 0.7), // carriage
  B('panel', -1.15, 1.15, 0.65, 1.85, 0.75, 0.8), // gun shield
  B('gun', -0.22, 0.22, 1.05, 1.55, -0.7, 0.5), // cradle and breech
  ...tubeChain('gun', HOWITZER_PIVOT, along(HOWITZER_PIVOT, HOWITZER_PITCH, 1.5), 0.15, 3), // recoil cylinders
  ...tubeChain('gun', along(HOWITZER_PIVOT, HOWITZER_PITCH, 1.5), along(HOWITZER_PIVOT, HOWITZER_PITCH, 5.0), 0.08, 7), // barrel
  tubeBox('gun', along(HOWITZER_PIVOT, HOWITZER_PITCH, 5.0), along(HOWITZER_PIVOT, HOWITZER_PITCH, 5.4), 0.13), // muzzle brake
  ...trail(-1),
  ...trail(1),
];

const AA_PITCH = 55 * DEG;

function aaBarrel(x: number): LocalBox[] {
  const p0 = { x, y: 1.25, z: 0.55 };
  return [...tubeChain('gun', p0, along(p0, AA_PITCH, 2.4), 0.035, 5), tubeBox('gun', along(p0, AA_PITCH, 2.4), along(p0, AA_PITCH, 2.7), 0.052)];
}

const AA_GUN: LocalBox[] = [
  B('frame', -0.95, 0.95, 0.28, 0.5, -1.3, 1.3), // platform
  round('wheel', 'x', -1.06, 0.38, -0.2, 0.38, 0.11, { sides: 28 }),
  round('wheel', 'x', 1.06, 0.38, -0.2, 0.38, 0.11, { sides: 28 }),
  round('frame', 'y', 0, 0.6, 0, 0.7, 0.1, { sides: 20 }), // turntable
  B('gun', -0.6, 0.6, 0.7, 1.35, -0.6, 0.45), // mount and seats
  B('gun', -0.4, 0.4, 1.0, 1.42, 0.45, 0.8), // gun housing
  B('crate', -0.92, -0.6, 0.75, 1.15, -0.3, 0.3), // magazines
  B('crate', 0.6, 0.92, 0.75, 1.15, -0.3, 0.3),
  ...aaBarrel(-0.22),
  ...aaBarrel(0.22),
  // A low sandbag ring, open at the back.
  ...bagRing(2.6, [-125, -75, -25, 25, 75, 125], 2.3, 0.5, 0.8),
];

// ---------------------------------------------------------------------------------------------
// Trucks: a 6x6 cargo truck with a canvas tilt, and the same chassis with a fuel tank. 9.2 m long, 2.6 m wide.

const TRUCK_CHASSIS: LocalBox[] = [
  B('frame', -0.55, 0.55, 0.6, 1.0, -4.0, 4.4), // chassis rails
  B('engine', -0.85, 0.85, 1.0, 2.05, 3.2, 4.6), // bonnet
  B('cab', -1.2, 1.2, 1.0, 2.85, 1.6, 3.2),
  round('wheel', 'x', -1.08, 0.55, 3.5, 0.55, 0.2, { sides: 28 }),
  round('wheel', 'x', 1.08, 0.55, 3.5, 0.55, 0.2, { sides: 28 }),
  round('wheel', 'x', -1.08, 0.55, -1.5, 0.55, 0.2, { sides: 28 }),
  round('wheel', 'x', 1.08, 0.55, -1.5, 0.55, 0.2, { sides: 28 }),
  round('wheel', 'x', -1.08, 0.55, -2.75, 0.55, 0.2, { sides: 28 }),
  round('wheel', 'x', 1.08, 0.55, -2.75, 0.55, 0.2, { sides: 28 }),
];

const CARGO_TRUCK: LocalBox[] = [
  ...TRUCK_CHASSIS,
  B('hull', -1.28, 1.28, 1.1, 1.75, -4.0, 1.5), // cargo bed with drop sides
  B('fabric', -1.28, 1.28, 1.75, 2.75, -4.0, 1.5), // canvas tilt walls
  B('fabric', -1.28, 1.28, 2.75, 3.2, -4.0, 1.5, { look: 'arch' }), // canvas roof
];

const FUEL_TRUCK: LocalBox[] = [
  ...TRUCK_CHASSIS,
  B('frame', -1.1, 1.1, 1.0, 1.15, -4.0, 1.5), // tank cradle
  round('tank', 'z', 0, 1.95, -1.25, 0.8, 2.55, { sides: 24 }), // tank y 1.15..2.75, z -3.8..1.3
  B('crate', 1.1, 1.3, 1.0, 1.6, -3.4, -2.0), // hose locker
];

// ---------------------------------------------------------------------------------------------
// Helicopter: a medium transport, 14.2 m rotor, fuselage nose at +Z, skids.

/** Rotor hub height (top of the blades), m. */
const ROTOR_Y = 3.8;
const BLADE = { r0: 0.3, r1: 7.1, w: 0.28, t: 0.025 };

const HELICOPTER: LocalBox[] = [
  B('hull', -1.1, 1.1, 0.65, 2.6, -1.8, 2.2), // cabin
  B('hull', -0.9, 0.9, 0.7, 1.6, 2.2, 3.9), // nose
  B('glass', -0.88, 0.88, 1.6, 2.45, 2.2, 3.55), // cockpit glazing
  B('engine', -0.75, 0.75, 2.6, 3.25, -1.6, 1.4), // engine cowling
  round('frame', 'y', 0, 3.45, 0, 0.14, 0.2), // rotor mast y 3.25..3.65
  round('frame', 'y', 0, ROTOR_Y - 0.075, 0, 0.36, 0.075, { sides: 16 }), // hub y 3.65..3.8
  B('blade', BLADE.r0, BLADE.r1, ROTOR_Y - BLADE.t * 2, ROTOR_Y - BLADE.t, -BLADE.w, BLADE.w),
  B('blade', -BLADE.r1, -BLADE.r0, ROTOR_Y - BLADE.t * 2, ROTOR_Y - BLADE.t, -BLADE.w, BLADE.w),
  B('blade', -BLADE.w, BLADE.w, ROTOR_Y - BLADE.t * 2, ROTOR_Y - BLADE.t, BLADE.r0, BLADE.r1),
  B('blade', -BLADE.w, BLADE.w, ROTOR_Y - BLADE.t * 2, ROTOR_Y - BLADE.t, -BLADE.r1, -BLADE.r0),
  B('hull', -0.5, 0.5, 1.8, 2.7, -5.0, -1.8), // tail boom, thick end
  B('hull', -0.3, 0.3, 2.0, 2.6, -9.2, -5.0), // tail boom, thin end
  B('panel', -0.1, 0.1, 2.6, 4.2, -9.8, -8.8), // fin
  B('panel', -1.5, 1.5, 2.15, 2.25, -8.7, -8.1), // tailplane
  round('frame', 'x', 0.16, 3.4, -9.3, 0.12, 0.06, { sides: 12 }), // tail rotor hub
  B('blade', 0.12, 0.15, 2.6, 4.2, -9.38, -9.22), // tail rotor blades (a cross in the y-z plane)
  B('blade', 0.12, 0.15, 3.32, 3.48, -10.1, -8.5),
  B('panel', -2.4, 2.4, 1.55, 1.7, 0.1, 0.9), // stub wings
  round('frame', 'z', -2.05, 1.32, 0.5, 0.18, 0.75), // rocket pods
  round('frame', 'z', 2.05, 1.32, 0.5, 0.18, 0.75),
  round('frame', 'z', -1.25, 0.06, 0.4, 0.06, 2.4), // skids
  round('frame', 'z', 1.25, 0.06, 0.4, 0.06, 2.4),
  B('frame', -1.3, -1.2, 0.12, 0.7, 1.2, 1.32), // skid struts
  B('frame', 1.2, 1.3, 0.12, 0.7, 1.2, 1.32),
  B('frame', -1.3, -1.2, 0.12, 0.7, -1.2, -1.08),
  B('frame', 1.2, 1.3, 0.12, 0.7, -1.2, -1.08),
];

/** A concrete landing pad, 14 x 14 m, 3 cm proud of the ground (the markings lie on it). */
const HELIPAD: LocalBox[] = [B('deck', -7, 7, 0, 0.03, -7, 7, { material: 'wall' })];

// ---------------------------------------------------------------------------------------------
// Emplacements, barriers, camp

const MG_NEST: LocalBox[] = [
  // A half ring of sandbags (1.1 m: the hull-height cover rule) round the gun, open at the back.
  ...bagRing(1.5, [-90, -45, 0, 45, 90], 1.25, 0.5, 1.1),
  B('gun', -0.06, 0.06, 1.12, 1.28, 0.2, 0.85), // receiver
  round('gun', 'z', 0, 1.2, 1.375, 0.022, 0.525), // barrel z 0.85..1.9, above the front bags
  B('crate', 0.08, 0.3, 1.05, 1.22, 0.35, 0.6), // ammunition box
  B('frame', -0.05, 0.05, 0.9, 1.12, 0.45, 0.6), // tripod head
  // Tripod legs (feet 2.5 cm up: a tube's box must not reach below the ground).
  ...tubeChain('frame', { x: 0, y: 0.95, z: 0.55 }, { x: 0, y: 0.025, z: 1.05 }, 0.02, 2),
  ...tubeChain('frame', { x: 0, y: 0.95, z: 0.5 }, { x: -0.45, y: 0.025, z: 0.15 }, 0.02, 2),
  ...tubeChain('frame', { x: 0, y: 0.95, z: 0.5 }, { x: 0.45, y: 0.025, z: 0.15 }, 0.02, 2),
].map((b) => (b.part === 'bags' ? b : { ...b, material: 'metal' as const }));

/** Watch tower: deck floor top at TOWER_DECK m, 2.9 m square; a 1 m plank parapet; a roof 2.2 m above the deck. */
export const TOWER_DECK = 4.15;
const TOWER_LEG = 1.125;

function towerBraces(): LocalBox[] {
  const L = TOWER_LEG;
  const out: LocalBox[] = [];
  // One diagonal per side and level, zig-zagging: (side, from, to) in the side's plane.
  for (const [face, sign] of [
    ['z', 1],
    ['z', -1],
    ['x', 1],
    ['x', -1],
  ] as const) {
    for (const [y0, y1, flip] of [
      [0.2, 2.0, 1],
      [2.0, 3.9, -1],
    ] as const) {
      const a = face === 'z' ? { x: -L * flip, y: y0, z: sign * L } : { x: sign * L, y: y0, z: -L * flip };
      const b = face === 'z' ? { x: L * flip, y: y1, z: sign * L } : { x: sign * L, y: y1, z: L * flip };
      out.push(...tubeChain('frame', a, b, 0.045, 2));
    }
  }
  return out;
}

const WATCH_TOWER: LocalBox[] = [
  ...[-1, 1].flatMap((sx) => [-1, 1].map((sz) => BC('post', sx * TOWER_LEG, TOWER_DECK / 2 - 0.075, sz * TOWER_LEG, 0.08, TOWER_DECK / 2 - 0.075, 0.08))),
  ...towerBraces(),
  B('roof', -1.45, 1.45, TOWER_DECK - 0.15, TOWER_DECK, -1.45, 1.45), // deck (the only 'roof' box: rooftopSpot finds it)
  B('wall', -1.45, 1.45, TOWER_DECK, TOWER_DECK + 1.0, 1.39, 1.45), // parapet front
  B('wall', -1.45, 1.45, TOWER_DECK, TOWER_DECK + 1.0, -1.45, -1.39), // back
  B('wall', 1.39, 1.45, TOWER_DECK, TOWER_DECK + 1.0, -1.39, 1.39), // sides
  B('wall', -1.45, -1.39, TOWER_DECK, TOWER_DECK + 1.0, -1.39, 1.39),
  ...[-1, 1].flatMap((sx) => [-1, 1].map((sz) => BC('post', sx * 1.39, TOWER_DECK + 1.6, sz * 1.39, 0.06, 0.6, 0.06))), // roof posts
  B('canopy', -1.7, 1.7, TOWER_DECK + 2.2, TOWER_DECK + 2.35, -1.7, 1.7),
  B('frame', -0.3, 0.3, 0, TOWER_DECK, -1.62, -1.5, { look: 'ladder' }),
  round('lamp', 'z', 0.95, TOWER_DECK + 1.15, 1.32, 0.15, 0.17, { material: 'metal', sides: 16 }), // searchlight
].map((b) => (b.material ? b : { ...b, material: 'wall' as const }));

const HESCO: LocalBox[] = [B('wall', -2.75, 2.75, 0, 1.4, -0.55, 0.55)];
const SANDBAGS: LocalBox[] = [bags(0, 0, 3, 0.6, 1.0, 0)];
const JERSEY: LocalBox[] = [B('wall', -1.5, 1.5, 0, 0.3, -0.38, 0.38), B('wall', -1.5, 1.5, 0.3, 0.85, -0.2, 0.2)];

/** Gate: two concrete blocks 7.2 m apart and a striped barrier arm across the road, closed. */
const GATE: LocalBox[] = [
  B('wall', -4.2, -3.6, 0, 1.3, -0.3, 0.3),
  B('wall', 3.6, 4.2, 0, 1.3, -0.3, 0.3),
  B('frame', -3.6, 3.6, 1.0, 1.12, -0.05, 0.05, { material: 'metal' }), // arm
  B('frame', -4.15, -3.65, 1.3, 1.55, -0.18, 0.18, { material: 'metal' }), // pivot housing
];

const BOOTH: LocalBox[] = [B('wall', -0.9, 0.9, 0, 2.3, -0.9, 0.9), B('roof', -1.1, 1.1, 2.3, 2.45, -1.1, 1.1)];

/** A big canvas tent: 5.2 x 8 m, 1.6 m walls under a 1.4 m vault, a stove pipe through it. */
const TENT: LocalBox[] = [
  B('fabric', -2.6, 2.6, 0, 1.6, -4, 4),
  B('fabric', -2.6, 2.6, 1.6, 3.0, -4, 4, { look: 'arch' }),
  round('frame', 'y', 1.3, 2.9, -2.5, 0.07, 0.5, { material: 'metal' }), // stove pipe
];

const GENERATOR: LocalBox[] = [
  B('hull', -0.65, 0.65, 0.45, 1.55, -1.2, 1.2),
  round('wheel', 'x', -0.75, 0.3, -0.2, 0.3, 0.1, { sides: 24 }),
  round('wheel', 'x', 0.75, 0.3, -0.2, 0.3, 0.1, { sides: 24 }),
  B('frame', -0.06, 0.06, 0.35, 0.45, 1.2, 2.0), // drawbar
  round('frame', 'y', 0.4, 1.8, -0.8, 0.06, 0.25), // exhaust stack
];

const DRUM_R = 0.29;
const FUEL_DRUMS: LocalBox[] = [
  ...[
    [0, 0],
    [0.62, 0],
    [-0.62, 0],
    [0.31, 0.54],
    [-0.31, 0.54],
    [0.31, -0.54],
    [-0.31, -0.54],
  ].map(([x, z]) => round('tank', 'y', x, 0.44, z, DRUM_R, 0.44, { sides: 20 })),
  round('tank', 'z', 1.4, DRUM_R, 0.1, DRUM_R, 0.44, { sides: 20 }), // one lying on its side
];

const FLAG_POLE: LocalBox[] = [
  B('wall', -0.3, 0.3, 0, 0.3, -0.3, 0.3, { material: 'wall' }),
  round('post', 'y', 0, 4.15, 0, 0.05, 3.85),
  round('post', 'y', 0, 8.08, 0, 0.08, 0.08),
  B('fabric', 0.05, 1.65, 6.9, 7.9, -0.012, 0.012, { material: 'wall' }),
];

const FLOODLIGHT: LocalBox[] = [
  B('hull', -0.55, 0.55, 0.4, 0.95, -1.0, 1.0),
  round('wheel', 'x', -0.65, 0.3, 0.1, 0.3, 0.1, { sides: 24 }),
  round('wheel', 'x', 0.65, 0.3, 0.1, 0.3, 0.1, { sides: 24 }),
  round('post', 'y', 0, 3.475, -0.3, 0.07, 2.525), // mast y 0.95..6.0
  B('frame', -0.8, 0.8, 6.0, 6.12, -0.38, -0.22), // lamp bar
  B('lamp', -0.78, -0.42, 6.12, 6.44, -0.36, -0.18),
  B('lamp', -0.36, 0.0, 6.12, 6.44, -0.36, -0.18),
  B('lamp', 0.06, 0.42, 6.12, 6.44, -0.36, -0.18),
  B('lamp', 0.48, 0.78, 6.12, 6.44, -0.36, -0.18),
];

/** Camouflage net on four poles, 7.4 x 10 m, 3.3 m up: a tank or truck parks under it. */
export const NET_HEIGHT = 3.3;
const CAMO_NET: LocalBox[] = [
  ...[-1, 1].flatMap((sx) => [-1, 1].map((sz) => BC('post', sx * 3.4, NET_HEIGHT / 2, sz * 4.6, 0.05, NET_HEIGHT / 2, 0.05))),
  B('net', -3.7, 3.7, NET_HEIGHT, NET_HEIGHT + 0.08, -5.0, 5.0, { material: 'wall' }),
];

const COMMS_MAST: LocalBox[] = [
  B('cab', -1.2, 1.2, 0, 2.3, -1.2, 1.2), // radio shelter
  round('post', 'y', 1.9, 6.5, 0, 0.11, 6.5), // mast y 0..13
  round('antenna', 'y', 1.9, 13.75, 0, 0.025, 0.75), // whip on top
  B('antenna', 1.1, 2.7, 12.0, 12.06, -0.03, 0.03), // dipole arms
  B('antenna', 1.87, 1.93, 11.0, 11.06, -0.8, 0.8),
  round('panel', 'z', 1.9, 9.5, 0.26, 0.45, 0.1, { sides: 20 }), // microwave dish, facing +z
];

const AMMO_CRATES: LocalBox[] = [
  B('crate', -1.3, -0.1, 0, 0.14, -0.5, 0.5), // pallets
  B('crate', 0.1, 1.3, 0, 0.14, -0.5, 0.5),
  B('crate', -1.25, -0.15, 0.14, 0.64, -0.45, 0.45), // big crate
  B('crate', -1.2, -0.62, 0.64, 1.0, -0.4, 0.38),
  B('crate', -0.58, -0.2, 0.64, 0.92, -0.35, 0.3),
  B('crate', 0.15, 1.25, 0.14, 0.44, -0.45, -0.02), // long rifle crates
  B('crate', 0.15, 1.25, 0.14, 0.44, 0.02, 0.45),
  B('crate', 0.2, 1.2, 0.44, 0.74, -0.3, 0.3),
  B('crate', 0.3, 0.6, 0.74, 0.92, -0.12, 0.08, { material: 'metal' }), // ammo cans
  B('crate', 0.65, 0.95, 0.74, 0.92, -0.12, 0.08, { material: 'metal' }),
  B('crate', -0.45, 0.45, 0, 0.45, 0.62, 1.12), // a loose crate in front
];

const RADAR: LocalBox[] = [
  B('hull', -1.1, 1.1, 0.75, 1.1, -2.4, 2.2), // trailer bed
  round('wheel', 'x', -1.25, 0.4, -0.4, 0.4, 0.13, { sides: 28 }),
  round('wheel', 'x', 1.25, 0.4, -0.4, 0.4, 0.13, { sides: 28 }),
  B('frame', -0.08, 0.08, 0.6, 0.75, 2.2, 3.4), // drawbar
  ...[-1, 1].flatMap((sx) => [-1, 1].map((sz) => BC('post', sx * 0.95, 0.375, sz * 2.05, 0.06, 0.375, 0.06))), // levelling jacks
  B('cab', -1.0, 1.0, 1.1, 2.4, -2.4, -0.5), // equipment cabin
  round('post', 'y', 0, 2.85, 0.9, 0.14, 1.75), // mast y 1.1..4.6
  round('frame', 'y', 0, 4.75, 0.9, 0.32, 0.15, { sides: 16 }), // rotator
  B('panel', -1.9, 1.9, 4.9, 6.3, 0.8, 1.0), // phased-array face, toward +z
  B('panel', -1.7, 1.7, 6.3, 6.45, 0.83, 0.97), // IFF bar
  B('frame', -0.5, 0.5, 4.9, 5.4, 0.55, 0.8), // panel back frame
];

export const BASE_BOXES: Record<BaseKind, readonly LocalBox[]> = {
  tank: TANK,
  artillery: ARTILLERY,
  cargoTruck: CARGO_TRUCK,
  fuelTruck: FUEL_TRUCK,
  helicopter: HELICOPTER,
  helipad: HELIPAD,
  ammoCrates: AMMO_CRATES,
  mgNest: MG_NEST,
  radar: RADAR,
  aaGun: AA_GUN,
  watchTower: WATCH_TOWER,
  hesco: HESCO,
  sandbags: SANDBAGS,
  jersey: JERSEY,
  gate: GATE,
  booth: BOOTH,
  tent: TENT,
  generator: GENERATOR,
  fuelDrums: FUEL_DRUMS,
  flagPole: FLAG_POLE,
  floodlight: FLOODLIGHT,
  camoNet: CAMO_NET,
  commsMast: COMMS_MAST,
};

/**
 * Collider material of a kind (a box's own `material` wins): soft cover (sandbags, earth-filled barriers, concrete,
 * timber, canvas) is 'wall'; vehicles, guns and masts are 'metal'.
 */
export const BASE_MATERIAL: Record<BaseKind, Material> = {
  tank: 'metal',
  artillery: 'metal',
  cargoTruck: 'metal',
  fuelTruck: 'metal',
  helicopter: 'metal',
  helipad: 'wall',
  ammoCrates: 'wall',
  mgNest: 'wall',
  radar: 'metal',
  aaGun: 'metal',
  watchTower: 'wall',
  hesco: 'wall',
  sandbags: 'wall',
  jersey: 'wall',
  gate: 'wall',
  booth: 'wall',
  tent: 'wall',
  generator: 'metal',
  fuelDrums: 'metal',
  flagPole: 'metal',
  floodlight: 'metal',
  camoNet: 'metal',
  commsMast: 'metal',
};

/** Where a guard stands on a watch tower, in the tower's frame: the deck's top height and the rectangle he may stand in, m. */
export function towerStandSpot(): { y: number; cx: number; cz: number; halfX: number; halfZ: number } {
  return { y: TOWER_DECK, cx: 0, cz: 0.2, halfX: 0.9, halfZ: 0.9 };
}
