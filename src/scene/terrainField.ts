import type { Vec3 } from '../ballistics/types';
import type { FiringPosition } from '../mission/config';
import type { ThemeId } from '../mission/themes';
import { createRng } from '../mission/random';

// Pure per-theme terrain height field (no three.js): shared by the render mesh, the bullets, the
// mission layout and the tests. World frame: Y up, downrange = -Z, shooter's right = +X.
//
// Plan view, the same for every theme:
//   - the firing position under the shooter, at the origin: the valley floor (a 1.5 m sandbank), the
//     rocky ridge (a 12 m smooth hill) or the mountain overlook (an 85 m rocky spur);
//   - an "engagement sector" in front of the shooter (|bearing| <= 12 deg, range <= 1600 m) where the
//     ground is gentle (<= 0.45 m high, features >= 70 m wide), so every line of sight to a target
//     in the sector is clear and the target stands on level ground;
//   - outside the sector the theme's own relief fades in (desert dunes, arctic drifts, valley hills)
//     together with rock outcrops, which are never placed inside the sector;
//   - beyond WALL_START metres from the sector, high eroded ridgelines (the valley walls) rise on
//     both sides, behind the shooter and behind the far end of the sector, enclosing the battlefield.
//     They never touch the sector or its 60 m margin, so no line of sight to a target is blocked.

/** Half-angle of the engagement sector, rad (12 degrees either side of straight downrange). */
export const SECTOR_HALF_ANGLE_RAD = (12 * Math.PI) / 180;
/** Range limit of the engagement sector, m. */
export const SECTOR_MAX_RANGE = 1600;

/** Height of the rise the shooter lies on (the ridge position), m. */
export const RISE_HEIGHT = 12;
/** Radius of the rise (the ridge position), m. */
export const RISE_RADIUS = 40;

/** The landform under the shooter for each firing position (spec B.2): top height above the plain and footprint radius, m. */
export const FIRING_POSITIONS: Record<FiringPosition, { height: number; radius: number }> = {
  valley: { height: 1.5, radius: 24 },
  ridge: { height: RISE_HEIGHT, radius: RISE_RADIUS },
  mountain: { height: 85, radius: 90 },
};

/** The mountain's summit pad: the prone shooter's patch, free of rocky roughness out to this radius, m. */
export const MOUNTAIN_PAD_RADIUS = 6;
/** The mountain's roughness is full this far out from the centre, m (it ramps in from the pad's edge). */
const MOUNTAIN_ROUGH_FULL = 16;

/** The valley walls start this far outside the sector edge (zero height up to here), m. */
export const WALL_START = 60;
/** ... and are fully risen this far outside it, m. */
export const WALL_FULL = 560;

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
  /** Prone eye position: the top of the firing position at the origin plus 0.4 m. */
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
  /** The valley walls: eroded ridgelines on both sides of the battlefield. */
  wall: WallShape;
}

interface WallShape {
  /** Height of the lowest part of a fully risen wall, m. */
  base: number;
  /** Extra height along the ridgelines, m. */
  ridge: number;
  /** Size of one ridge-noise cell (x, z), m: the spacing of the ridgelines. */
  ridgeCell: readonly [number, number];
  /** Crest exponent: above 1 the ridges are sharper with deeper saddles, below 1 broader and rounder. */
  crest: number;
  /** Height of the fine layering on the walls (strata, bumps), m, and its cell size (x, z), m. */
  strata: number;
  strataCell: readonly [number, number];
  /** Eroded gullies: channels cut into the ridges (depth, m, at most; cell size (x, z), m, sets their spacing). Never cut below the wall's base. */
  gully: { depth: number; cell: readonly [number, number] };
  /** Rocky crags: sharp ribs standing on the ridges (height, m, at most; cell size (x, z), m). */
  crag: { height: number; cell: readonly [number, number] };
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
    // Sandstone ridgelines with horizontal strata: 55-248 m.
    wall: {
      base: 55,
      ridge: 175,
      ridgeCell: [320, 430],
      crest: 1,
      strata: 18,
      strataCell: [85, 110],
      gully: { depth: 18, cell: [130, 170] },
      crag: { height: 14, cell: [95, 115] },
    },
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
    // Broad snowy ridges, sharper crests and smoother flanks than the desert's: 55-213 m.
    wall: {
      base: 55,
      ridge: 150,
      ridgeCell: [440, 560],
      crest: 1.4,
      strata: 8,
      strataCell: [170, 210],
      gully: { depth: 12, cell: [170, 210] },
      crag: { height: 9, cell: [130, 150] },
    },
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
    // Rounded green hills that grow into mountains: 55-172 m.
    wall: {
      base: 55,
      ridge: 105,
      ridgeCell: [380, 460],
      crest: 0.8,
      strata: 12,
      strataCell: [130, 150],
      gully: { depth: 9, cell: [200, 240] },
      crag: { height: 6, cell: [140, 160] },
    },
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

/** 1 along the noise's mid-level contour (n = 0.5), falling to 0 at its extremes (n = 0 or 1): crest lines where the noise crosses 0.5. */
const ridged = (n: number): number => 1 - Math.abs(2 * n - 1);

/** Rocky roughness of the mountain's flanks, about +-5 m before the ramp: crags (ridged noise) and fine chips. */
function mountainRoughness(noise: Noise, x: number, z: number): number {
  return (
    3.2 * (2 * ridged(noise(x / 26 + 7.7, z / 26 - 2.3)) - 1) +
    1.3 * (2 * ridged(noise(x / 10.5 - 4.1, z / 10.5 + 6.9)) - 1) +
    0.4 * signed(noise(x / 3.9 + 1.3, z / 3.9 - 5.7))
  );
}

/**
 * Height of the valley walls at a point `sd` metres outside the sector: eroded ridgelines with strata, risen by `sd`.
 * On top of the ridges, domain-warped ridged noise cuts gullies down their flanks and stands crags on them. Both
 * are 100 m or more across (the render mesh is 25 m out here, so finer relief would be lost or alias); the finer
 * rock detail comes from the terrain shader. The gullies never cut below the wall's base, the crags stay inside the 275 m cap.
 */
function wallHeight(wall: WallShape, noise: Noise, detail: Noise, x: number, z: number, sd: number): number {
  const ridge = Math.pow(ridged(noise(x / wall.ridgeCell[0] + 4, z / wall.ridgeCell[1] - 2)), wall.crest);
  const strata = wall.strata * noise(x / wall.strataCell[0] + 9.1, z / wall.strataCell[1] - 3.7);
  // Domain warp, so the gullies and ribs wander instead of following the lattice.
  const wx = x + 60 * signed(detail(x / 240 + 3.3, z / 240 - 8.1));
  const wz = z + 60 * signed(detail(x / 240 - 5.7, z / 240 + 1.9));
  const ridgeHeight = wall.ridge * ridge;
  const higher = 0.3 + 0.7 * ridge; // the deepest gullies and the tallest crags are on the high ridges
  const gully = Math.pow(ridged(detail(wx / wall.gully.cell[0] + 1.7, wz / wall.gully.cell[1] - 6.3)), 2);
  const cut = Math.min(wall.gully.depth * gully * higher, ridgeHeight + strata);
  const crag = wall.crag.height * Math.pow(ridged(detail(wx / wall.crag.cell[0] + 8.9, wz / wall.crag.cell[1] + 2.2)), 3) * higher;
  return smoothstep(WALL_START, WALL_FULL, sd) * (wall.base + ridgeHeight + strata - cut + crag);
}

/**
 * The ground of one mission: deterministic for a (theme, seed, position) triple. The firing position
 * only changes the landform under the shooter (and so the eye height); the sector, relief, outcrops
 * and walls are those of the (theme, seed).
 */
export function createTerrainField(theme: ThemeId, seed: number, position: FiringPosition = 'ridge'): TerrainField {
  const shape = THEME_SHAPES[theme];
  const mix = Math.imul(seed | 0, 0x9e3779b1) ^ shape.salt;
  const noise = createNoise(mix);
  // Their own lattices, so the walls and the crags do not echo the dunes.
  const wallNoise = createNoise(mix ^ 0x68e31da4);
  const rockNoise = createNoise(mix ^ 0x2c1b3c6d);
  const detailNoise = createNoise(mix ^ 0x4b1d9e07); // the gullies and crags on the walls
  const outcrops = placeOutcrops(shape, seed);
  const site = FIRING_POSITIONS[position];
  const smoothRise = position === 'ridge';
  const rocky = position === 'mountain';

  const height = (x: number, z: number): number => {
    const r = Math.hypot(x, z);
    const sd = sectorDistance(x, z);

    // The landform under the shooter. The ridge is a smooth hill; the valley sandbank and the mountain
    // spur have a (1 - r / radius)^2 profile, steepest at the top, so a downhill sight line from the
    // eye (0.4 m above the top) always clears the ground, whatever the roughness on the flanks.
    let h: number;
    if (smoothRise) {
      h = RISE_HEIGHT * (1 - smoothstep(0, RISE_RADIUS, r));
    } else if (r < site.radius) {
      const k = 1 - r / site.radius;
      h = site.height * k * k;
      // Rocky flanks of the mountain: none on the summit pad, fully developed by 16 m, gone at the foot.
      if (rocky && r > MOUNTAIN_PAD_RADIUS) {
        h += mountainRoughness(rockNoise, x, z) * smoothstep(MOUNTAIN_PAD_RADIUS, MOUNTAIN_ROUGH_FULL, r) * k;
      }
    } else {
      h = 0;
    }

    // 0 inside the sector (gentle ground only), 1 well outside it (full relief). The blend starts
    // at the sector edge and runs outward, so the sector itself is never touched by relief.
    const outside = smoothstep(0, shape.blendWidth, sd);
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

    // The valley walls: nothing within WALL_START of the sector (the early-out keeps the bullets' and
    // the layout's calls inside the sector as cheap as before).
    if (sd > WALL_START) h += wallHeight(shape.wall, wallNoise, detailNoise, x, z, sd);
    return h;
  };

  return { theme, height, shooter: { x: 0, y: height(0, 0) + EYE_ABOVE_RISE, z: 0 }, outcrops };
}
