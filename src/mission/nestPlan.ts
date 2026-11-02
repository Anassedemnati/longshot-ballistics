import type { Vec3 } from '../ballistics/types';
import type { Box, Obstacle } from '../game/hit';
import type { FiringPosition } from './config';
import { BOULDER_UNIT } from './models';
import { createRng } from './random';
import type { Rng } from './random';
import type { ThemeId } from './themes';

// The firing nest (pure, no three.js; the meshes are in scene/nest.ts): a crescent of sandbags behind and beside the
// prone shooter, two to four boulders round it, and on the mountain a levelled rock platform to hold them on the
// summit's steep tip. World frame: downrange is -Z, "bearing" is the angle from straight downrange, positive to the
// right (+X). The nest is visual only (no colliders) and keeps the forward view clear:
//   - the sandbags stand on a ring 1.35 m round the eye and only from `crescentFrom` degrees either side of
//     downrange round to behind: nothing within 60 degrees of the line of sight, nothing nearer than 1.2 m;
//   - their tops stay below the eye (2 courses, 0.28 m), so even to the side the view over them is open;
//   - the rocks stand 2.2 m or more from the eye, to the sides and behind (bearing 95 degrees or more);
//   - the platform's surface in front of the shooter is the natural ground (the layout checked the lines of sight
//     over it); it is raised only behind and beside him.
// `nestBoxes` is the nest as oriented boxes, for the line-of-sight tests.

/** Nothing else (trees, boulders, grass) stands within this distance of the shooter, m: the nest owns it. */
export const NEST_AREA_RADIUS = 7;

/** Half sizes of a sandbag, m (about 52 x 30 x 16 cm). */
export const BAG_HALF = { x: 0.26, y: 0.08, z: 0.15 } as const;
/** The ring of the lower course, m from the eye. */
export const BAG_RING_RADIUS = 1.35;
/** Each upper course sits this much higher, m (the bags bed into the course below). */
export const COURSE_RISE = 0.135;
/** The crescent's open front: the lower course starts this many degrees from downrange (the mountain's starts later, where the platform is level). */
export const CRESCENT_FROM_DEG = { ground: 62, platform: 95 } as const;
/** Rocks stand at bearings of at least this many degrees. */
export const ROCK_BEARING_MIN_DEG = 95;

/** The mountain platform: flat to this radius from the eye, m, then falling to the natural ground by `PAD_EDGE_RADIUS`. */
export const PAD_FLAT_RADIUS = 2.9;
export const PAD_EDGE_RADIUS = 4.4;
/** The platform is natural ground (no raised surface) within this many degrees of downrange, and fully raised from `PAD_FULL_DEG`. */
export const PAD_OPEN_DEG = 62;
export const PAD_FULL_DEG = 95;
/** The platform's top lies this far below the ground at the eye, m (the prone body rests on it). */
const PAD_SINK = 0.02;

const DEG = Math.PI / 180;

export interface NestBag {
  /** Centre, m. */
  x: number;
  y: number;
  z: number;
  /** Rotation about +Y, rad (three.js convention: local +X is world (cos yaw, 0, -sin yaw)). */
  yaw: number;
  /** Half sizes of the bag along its local axes, m. */
  hx: number;
  hy: number;
  hz: number;
  /** 0 lower, 1 upper. */
  course: number;
}

export interface NestRock {
  /** Centre of its base, m. */
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Scale of the boulder model (`BOULDER_UNIT`). */
  sx: number;
  sy: number;
  sz: number;
  /** Half sizes of the box enclosing it (5 % slack), m, and the height of that box's centre. */
  hx: number;
  hy: number;
  hz: number;
  cy: number;
}

export interface NestPad {
  /** Height of the flat top, m. */
  top: number;
}

export interface NestPlan {
  /** The shooter's eye, m. */
  eye: Vec3;
  /** What the bags and rocks stand on: the platform on the mountain, the ground elsewhere. */
  surface: (x: number, z: number) => number;
  bags: NestBag[];
  rocks: NestRock[];
  /** The levelled platform (mountain only). */
  pad: NestPad | null;
  /** The nest as oriented boxes (every bag and every rock). */
  boxes: Box[];
}

export interface NestInputs {
  eye: Vec3;
  /** The drawn ground (the render mesh); bags and rocks stand on it. */
  ground: (x: number, z: number) => number;
  /** The exact terrain height field (the collider's ground), which the platform blends into. */
  terrain: (x: number, z: number) => number;
  position: FiringPosition;
  theme: ThemeId;
  seed: number;
}

const smooth = (edge0: number, edge1: number, v: number): number => {
  const t = Math.min(1, Math.max(0, (v - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

const THEME_SALT: Record<ThemeId, number> = { desert: 0x1d5e47, arctic: 0x7a3c19, valley: 0x35b2d1 };
const POSITION_SALT: Record<FiringPosition, number> = { valley: 0x51a1, ridge: 0x7b3d, mountain: 0x9c27 };

/** Bearing of (dx, dz) from straight downrange (-Z), positive to the right, rad in (-pi, pi]. */
export function bearingOf(dx: number, dz: number): number {
  return Math.atan2(dx, 0 - dz);
}

/** A point at `bearing` and `distance` from the eye. */
const at = (eye: Vec3, bearing: number, distance: number): { x: number; z: number } => ({
  x: eye.x + distance * Math.sin(bearing),
  z: eye.z - distance * Math.cos(bearing),
});

/** The surface of the mountain platform: the natural ground in front, raised behind and beside the eye. */
function padSurface(inputs: NestInputs, top: number): (x: number, z: number) => number {
  const { eye, terrain } = inputs;
  return (x, z) => {
    const dx = x - eye.x;
    const dz = z - eye.z;
    const r = Math.hypot(dx, dz);
    const natural = terrain(x, z);
    const flat = top + (natural - top) * smooth(PAD_FLAT_RADIUS, PAD_EDGE_RADIUS, r);
    const w = smooth(PAD_OPEN_DEG * DEG, PAD_FULL_DEG * DEG, Math.abs(bearingOf(dx, dz)));
    return natural + (Math.max(natural, flat) - natural) * w;
  };
}

/** The nest of one mission: deterministic for (seed, theme, position). */
export function planNest(inputs: NestInputs): NestPlan {
  const { eye, position, theme, seed } = inputs;
  const rng: Rng = createRng((Math.imul((seed | 0) ^ THEME_SALT[theme] ^ (POSITION_SALT[position] << 7), 0x9e3779b1) ^ 0x6e657374) >>> 0);
  const mountain = position === 'mountain';
  const groundAtEye = inputs.terrain(eye.x, eye.z);
  const top = groundAtEye - PAD_SINK;
  const surface = mountain ? padSurface(inputs, top) : inputs.ground;
  const bags: NestBag[] = [];
  const rocks: NestRock[] = [];

  // ---- the crescent: two courses of sandbags on a ring, open to the front
  const from = (mountain ? CRESCENT_FROM_DEG.platform : CRESCENT_FROM_DEG.ground) * DEG;
  for (let course = 0; course < 2; course++) {
    const start = from + course * 13 * DEG;
    const end = 2 * Math.PI - start;
    const ring = BAG_RING_RADIUS - course * 0.04;
    const n = Math.max(3, Math.round(((end - start) * ring) / 0.46));
    for (let k = 0; k < n; k++) {
      const a = start + ((k + 0.5) / n) * (end - start) + (rng() - 0.5) * 0.03;
      const p = at(eye, a, ring + (rng() - 0.5) * 0.04);
      const sx = 0.92 + 0.14 * rng();
      const sy = 0.92 + 0.16 * rng();
      const sz = 0.94 + 0.12 * rng();
      const hy = BAG_HALF.y * sy;
      bags.push({
        x: p.x,
        y: surface(p.x, p.z) - 0.015 + hy + course * COURSE_RISE,
        z: p.z,
        yaw: -a + (rng() - 0.5) * 0.12, // the long side along the ring
        hx: BAG_HALF.x * sx,
        hy,
        hz: BAG_HALF.z * sz,
        course,
      });
    }
  }

  // ---- the rocks: two to four, to the sides and behind
  const count = mountain ? 2 + Math.floor(rng() * 2) : 2 + Math.floor(rng() * 3);
  const slots: Array<[number, number]> = [
    [ROCK_BEARING_MIN_DEG, 130], // right
    [230, 360 - ROCK_BEARING_MIN_DEG], // left
    [160, 200], // behind
    [135, 225], // behind, either side
  ];
  for (let i = 0; i < count; i++) {
    const [lo, hi] = slots[i];
    const a = (lo + (hi - lo) * rng()) * DEG;
    const s = mountain ? 0.3 + 0.12 * rng() : 0.34 + 0.36 * rng();
    const sx = s * (0.9 + 0.2 * rng());
    const sy = s * (0.85 + 0.3 * rng());
    const sz = s * (0.9 + 0.2 * rng());
    const circum = 0.5 * Math.hypot(BOULDER_UNIT.lx * sx, BOULDER_UNIT.lz * sz) * 1.08;
    // Clear of the bags (their outer edge is 1.5 m out), and on the platform when there is one.
    const distance = Math.max(2.2, BAG_RING_RADIUS + BAG_HALF.z + circum + 0.1) + rng() * (mountain ? 0.3 : 0.9);
    const p = at(eye, a, distance);
    let base = -Infinity;
    for (const [ox, oz] of [[0, 0], [circum * 0.6, 0], [-circum * 0.6, 0], [0, circum * 0.6], [0, -circum * 0.6]] as const) {
      base = Math.max(base, surface(p.x + ox, p.z + oz));
    }
    const y = base - BOULDER_UNIT.ly * sy * 0.1;
    const hy = BOULDER_UNIT.ly * sy * 0.5 * 1.05;
    rocks.push({
      x: p.x,
      y,
      z: p.z,
      yaw: rng() * Math.PI * 2,
      sx,
      sy,
      sz,
      hx: BOULDER_UNIT.lx * sx * 0.5 * 1.05,
      hy,
      hz: BOULDER_UNIT.lz * sz * 0.5 * 1.05,
      cy: y + hy,
    });
  }

  const boxes: Box[] = [
    ...bags.map((b) => ({ center: { x: b.x, y: b.y, z: b.z }, halfSize: { x: b.hx, y: b.hy, z: b.hz }, yaw: b.yaw })),
    ...rocks.map((r) => ({ center: { x: r.x, y: r.cy, z: r.z }, halfSize: { x: r.hx, y: r.hy, z: r.hz }, yaw: r.yaw })),
  ];
  return { eye, surface, bags, rocks, pad: mountain ? { top } : null, boxes };
}

/** The nest as obstacles, for the same segment tests the layout uses for lines of sight (tests only). */
export function nestObstacles(plan: NestPlan): Obstacle[] {
  return plan.boxes.map((box, i) => ({ id: `nest-${i}`, material: 'wall' as const, box }));
}
