import type { FiringPosition } from '../game/config';
import type { Vec3 } from '../ballistics/types';

// Pure terrain height field (no three.js): shared by the render mesh, the bullets and the tests.
// World frame: Y up, downrange = -Z. Layout, in plan view:
//   - a 12 m rise (smooth hill) with the shooter on top, at the origin;
//   - a flat-ish range lane along the -Z axis, so every line of sight down the lane is clear and
//     the target stands on level ground at any range;
//   - dunes (a few metres tall) outside the lane and a few rock outcrops beside it.

export const POSITIONS = {
  valley: { name: 'Valley floor', height: 1.5, radius: 24, description: 'Low sandbank. A near-level sightline across the dry wash.' },
  ridge: { name: 'Rocky ridge', height: 12, radius: 40, description: 'Elevated ridge. A clear view into the valley below.' },
  mountain: { name: 'Mountain overlook', height: 85, radius: 90, description: 'Steep rocky spur. A pronounced downhill shot into the basin.' },
} as const;
let activePosition: FiringPosition = 'ridge';
/** Set once before creating terrain, targets and ballistics. */
export function configurePosition(position: FiringPosition): Vec3 {
  activePosition = position;
  return { x: 0, y: terrainHeight(0, 0) + .4, z: 0 };
}

const SEED = 20260101;

/** Height of the rise the shooter lies on, m. */
export const RISE_HEIGHT = 12;
/** Radius of the rise, m. */
export const RISE_RADIUS = 40;

/** Half-width of the dune-free lane (full flat), m. Dunes fade in between this and LANE_BLEND_END. */
export const LANE_FLAT_HALF_WIDTH = 14;
export const LANE_BLEND_END = 50;

/** Eye height above the top of the rise (prone shooter), m. */
const EYE_ABOVE_RISE = 0.4;

export interface RockOutcrop {
  x: number;
  z: number;
  /** Footprint radius, m. */
  radius: number;
  /** Mound height, m. */
  height: number;
}

/** Hand-placed outcrops, all well off the lane (|x| > radius + 20 m). */
export const ROCK_OUTCROPS: ReadonlyArray<RockOutcrop> = [
  { x: -78, z: -230, radius: 7, height: 3.2 },
  { x: 96, z: -410, radius: 9, height: 4.0 },
  { x: -140, z: -640, radius: 8, height: 3.5 },
  { x: 72, z: -790, radius: 6, height: 2.6 },
  { x: -68, z: -1010, radius: 7, height: 3.0 },
  { x: 125, z: -1190, radius: 10, height: 4.4 },
  { x: -115, z: -1390, radius: 8, height: 3.4 },
  { x: 160, z: 140, radius: 7, height: 2.8 },
];

/** Deterministic hash of an integer lattice point to [0, 1). */
function hash2(ix: number, iy: number): number {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ Math.imul(SEED, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Smooth 2D value noise in [0, 1], one lattice cell per unit. */
function valueNoise(x: number, y: number): number {
  const fx = Math.floor(x);
  const fy = Math.floor(y);
  const tx = fade(x - fx);
  const ty = fade(y - fy);
  const a = hash2(fx, fy);
  const b = hash2(fx + 1, fy);
  const c = hash2(fx, fy + 1);
  const d = hash2(fx + 1, fy + 1);
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}

export function smoothstep(edge0: number, edge1: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Dunes, about +-4 m: long crests across the lane direction plus two finer octaves. */
function dunes(x: number, z: number): number {
  const big = (valueNoise(x / 420 + 11.3, z / 210 - 7.1) - 0.5) * 2; // [-1, 1]
  const mid = (valueNoise(x / 150 - 3.7, z / 90 + 19.2) - 0.5) * 2;
  const fine = (valueNoise(x / 48 + 5.1, z / 33 - 2.9) - 0.5) * 2;
  return 3.0 * big + 1.0 * mid + 0.3 * fine;
}

/** Ground height at (x, z), m. Deterministic and seeded; safe to call millions of times. */
export function terrainHeight(x: number, z: number): number {
  const r = Math.hypot(x, z);
  const site = POSITIONS[activePosition];
  const rise = activePosition === 'ridge' ? RISE_HEIGHT * (1 - smoothstep(0, RISE_RADIUS, r))
    : site.height * Math.pow(Math.max(0, 1 - r / site.radius), 2);

  // Outside the lane: full dunes. Inside it: only a faint hummock texture, faded out on the rise.
  const laneMask = smoothstep(LANE_FLAT_HALF_WIDTH, LANE_BLEND_END, Math.abs(x));
  const hummocks = (valueNoise(x / 9 + 2.2, z / 14 - 4.4) - 0.5) * 0.2 * smoothstep(5, 40, r);
  let h = rise + dunes(x, z) * laneMask + hummocks * (1 - laneMask);

  for (const rock of ROCK_OUTCROPS) {
    const dx = x - rock.x;
    const dz = z - rock.z;
    const d2 = (dx * dx + dz * dz) / (rock.radius * rock.radius);
    if (d2 >= 1) continue;
    const base = 1 - d2;
    const rough = 0.75 + 0.5 * valueNoise(x / 1.8 + 0.7, z / 1.8 + 3.1);
    h += rock.height * base * base * rough;
  }
  // Eroded ridgelines enclose the shooting valley, leaving its floor traversable.
  const flank = smoothstep(90, 650, Math.abs(x));
  const ridgeNoise = 1 - Math.abs(valueNoise(x / 320 + 4, z / 430 - 2) * 2 - 1);
  const strata = valueNoise(x / 85, z / 110) * 18;
  h += flank * (55 + ridgeNoise * 190 + strata);
  return h;
}

/** Prone eye position: the top of the rise at the origin plus 0.4 m. */
export const SHOOTER_POS: Vec3 = { x: 0, y: terrainHeight(0, 0) + EYE_ABOVE_RISE, z: 0 };
