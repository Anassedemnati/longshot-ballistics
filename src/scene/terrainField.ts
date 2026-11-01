import type { Vec3 } from '../ballistics/types';
import type { ThemeId } from '../mission/themes';
import { createRng } from '../mission/random';

// Pure per-theme terrain height field (no three.js): shared by the render mesh, the bullets, the
// mission layout and the tests. World frame: Y up, downrange = -Z, shooter's right = +X.
//
// Plan view, the same for every theme:
//   - a 12 m rise (smooth hill) with the shooter on top, at the origin;
//   - an "engagement sector" in front of the shooter (|bearing| <= 12 deg, range <= 1600 m) where the
//     ground is gentle (<= 0.45 m high, features >= 70 m wide), so every line of sight to a target
//     in the sector is clear and the target stands on level ground;
//   - outside the sector the theme's own relief fades in (desert dunes, arctic drifts, valley hills)
//     together with rock outcrops, which are never placed inside the sector.

/** Half-angle of the engagement sector, rad (12 degrees either side of straight downrange). */
export const SECTOR_HALF_ANGLE_RAD = (12 * Math.PI) / 180;
/** Range limit of the engagement sector, m. */
export const SECTOR_MAX_RANGE = 1600;

/** Height of the rise the shooter lies on, m. */
export const RISE_HEIGHT = 12;
/** Radius of the rise, m. */
export const RISE_RADIUS = 40;

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

export interface TerrainField {
  theme: ThemeId;
  /** Ground height at (x, z), m. Deterministic; safe to call millions of times. */
  height(x: number, z: number): number;
  /** Prone eye position: the top of the rise at the origin plus 0.4 m. */
  shooter: Vec3;
  /** Rock outcrops standing on the ground, all outside the engagement sector. */
  outcrops: ReadonlyArray<RockOutcrop>;
}

export function smoothstep(edge0: number, edge1: number, v: number): number {
  const t = Math.min(1, Math.max(0, (v - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Distance in metres from (x, z) to the engagement sector (the 12 degree wedge, capped by the
 * 1600 m arc): 0 anywhere inside it, the distance to its nearest edge outside it. Behind the
 * shooter that is the distance to the apex.
 */
export function sectorDistance(x: number, z: number): number {
  const r = Math.hypot(x, z);
  if (r === 0) return 0;
  // Bearing measured from straight downrange (-Z); `0 - z` keeps the sign of zero out of atan2.
  const theta = Math.atan2(Math.abs(x), 0 - z);
  if (theta <= SECTOR_HALF_ANGLE_RAD) return Math.max(0, r - SECTOR_MAX_RANGE);
  const d = theta - SECTOR_HALF_ANGLE_RAD;
  const along = r * Math.cos(d); // position along the nearest edge ray
  if (along <= 0) return r;
  const across = r * Math.sin(d);
  if (along >= SECTOR_MAX_RANGE) return Math.hypot(across, along - SECTOR_MAX_RANGE);
  return across;
}

// ---------------------------------------------------------------------------------------------
// Seeded noise

type Noise = (x: number, y: number) => number;

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Smooth 2D value noise in [0, 1], one lattice cell per unit, hashed from `salt`. */
function createNoise(salt: number): Noise {
  const hash2 = (ix: number, iy: number): number => {
    let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ Math.imul(salt, 0x9e3779b1);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
  return (x, y) => {
    const fx = Math.floor(x);
    const fy = Math.floor(y);
    const tx = fade(x - fx);
    const ty = fade(y - fy);
    const a = hash2(fx, fy);
    const b = hash2(fx + 1, fy);
    const c = hash2(fx, fy + 1);
    const d = hash2(fx + 1, fy + 1);
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  };
}

// ---------------------------------------------------------------------------------------------
// Per-theme shape

interface ThemeShape {
  /** Mixed into the seed so the same seed gives different ground per theme. */
  salt: number;
  /** Width over which the relief fades in beyond the sector edge, m (wider = gentler hill flanks). */
  blendWidth: number;
  /** Relief outside the sector, m, before the near-shooter and sector fades. */
  relief(noise: Noise, x: number, z: number): number;
  outcrops: { count: number; minRadius: number; maxRadius: number; minHeight: number; maxHeight: number };
}

const signed = (n: number): number => (n - 0.5) * 2; // [0, 1] -> [-1, 1]

const THEME_SHAPES: Record<ThemeId, ThemeShape> = {
  desert: {
    salt: 0x1d5e47,
    blendWidth: 140,
    // Dunes, about +-4 m: long crests across the lane direction plus two finer octaves.
    relief: (n, x, z) =>
      3.0 * signed(n(x / 420 + 11.3, z / 210 - 7.1)) +
      1.0 * signed(n(x / 150 - 3.7, z / 90 + 19.2)) +
      0.3 * signed(n(x / 48 + 5.1, z / 33 - 2.9)),
    outcrops: { count: 8, minRadius: 6, maxRadius: 10, minHeight: 2.6, maxHeight: 4.4 },
  },
  arctic: {
    salt: 0x7a3c19,
    blendWidth: 180,
    // Smooth wind-packed drifts, +-3.5 m, long and rounded.
    relief: (n, x, z) =>
      2.6 * signed(n(x / 520 + 4.4, z / 360 - 9.7)) +
      0.8 * signed(n(x / 230 - 6.1, z / 150 + 2.3)) +
      0.12 * signed(n(x / 70 + 1.7, z / 52 - 8.8)),
    outcrops: { count: 10, minRadius: 5, maxRadius: 9, minHeight: 2.2, maxHeight: 4.0 },
  },
  valley: {
    salt: 0x35b2d1,
    blendWidth: 320,
    // Rolling hills: broad humps up to ~25 m on a gently undulating floor.
    relief: (n, x, z) =>
      23 * smoothstep(0.3, 0.9, n(x / 640 + 7.7, z / 520 - 3.3)) +
      2.4 * signed(n(x / 260 - 1.9, z / 210 + 6.4)) +
      0.6 * signed(n(x / 80 + 3.1, z / 70 - 5.5)),
    outcrops: { count: 12, minRadius: 4, maxRadius: 8, minHeight: 1.6, maxHeight: 3.2 },
  },
};

/** Gentle ground inside the sector: at most 0.45 m in height (<= 0.9 m peak to peak), features >= 70 m wide. */
function gentle(n: Noise, x: number, z: number): number {
  return (
    0.3 * signed(n(x / 320 + 2.9, z / 320 - 6.2)) +
    0.12 * signed(n(x / 130 - 8.1, z / 130 + 3.7)) +
    0.03 * signed(n(x / 70 + 5.3, z / 70 - 1.1))
  );
}

/** Seeded rock outcrops, every footprint (plus the rocky tint around it) clear of the sector. */
function placeOutcrops(shape: ThemeShape, seed: number): RockOutcrop[] {
  const rng = createRng(Math.imul(seed, 0x2545f491) ^ shape.salt);
  const spec = shape.outcrops;
  const placed: RockOutcrop[] = [];
  for (let i = 0; i < spec.count; i++) {
    for (let attempt = 0; attempt < 400; attempt++) {
      const side = rng() < 0.5 ? -1 : 1;
      // Bearing from straight downrange: mostly within the opening view (about +-46 deg at 60 deg vertical FOV, 16:9)
      // so the rocks read as scenery, a few further round to the side.
      const wide = rng() < 0.2;
      const theta = (14 + rng() * (wide ? 86 : 31)) * (Math.PI / 180);
      const range = 150 + 1500 * rng() * rng(); // biased towards the near half
      const radius = spec.minRadius + rng() * (spec.maxRadius - spec.minRadius);
      const height = spec.minHeight + rng() * (spec.maxHeight - spec.minHeight);
      const x = side * range * Math.sin(theta);
      const z = -range * Math.cos(theta);
      if (sectorDistance(x, z) < radius * 1.3 + 20) continue;
      if (placed.some((o) => Math.hypot(o.x - x, o.z - z) < o.radius + radius + 12)) continue;
      placed.push({ x, z, radius, height });
      break;
    }
  }
  return placed;
}

/** The ground of one mission: deterministic for a (theme, seed) pair. */
export function createTerrainField(theme: ThemeId, seed: number): TerrainField {
  const shape = THEME_SHAPES[theme];
  const noise = createNoise(Math.imul(seed | 0, 0x9e3779b1) ^ shape.salt);
  const outcrops = placeOutcrops(shape, seed);

  const height = (x: number, z: number): number => {
    const r = Math.hypot(x, z);
    let h = RISE_HEIGHT * (1 - smoothstep(0, RISE_RADIUS, r));

    // 0 inside the sector (gentle ground only), 1 well outside it (full relief). The blend starts
    // at the sector edge and runs outward, so the sector itself is never touched by relief.
    const outside = smoothstep(0, shape.blendWidth, sectorDistance(x, z));
    if (outside < 1) h += (1 - outside) * gentle(noise, x, z) * smoothstep(5, 40, r);
    if (outside > 0) h += outside * shape.relief(noise, x, z) * smoothstep(RISE_RADIUS, 200, r);

    for (const rock of outcrops) {
      const dx = x - rock.x;
      const dz = z - rock.z;
      const d2 = (dx * dx + dz * dz) / (rock.radius * rock.radius);
      if (d2 >= 1) continue;
      const base = 1 - d2;
      const rough = 0.75 + 0.5 * noise(x / 1.8 + 0.7, z / 1.8 + 3.1);
      h += rock.height * base * base * rough;
    }
    return h;
  };

  return { theme, height, shooter: { x: 0, y: height(0, 0) + EYE_ABOVE_RISE, z: 0 }, outcrops };
}
