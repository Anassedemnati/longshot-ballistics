import type { Obstacle } from '../game/hit';
import { SNOW_LINES } from '../scene/snowLine';
import { sectorDistance } from '../scene/terrainField';
import type { TerrainField } from '../scene/terrainField';
import type { FiringPosition } from './config';
import type { MissionLayout } from './layout';
import { BOULDER_UNIT, GRASS_UNIT, LOG_UNIT, SNAG_UNIT } from './models';
import { NEST_AREA_RADIUS } from './nestPlan';
import { propFootprintRadius } from './props';
import { createRng } from './random';
import type { Rng } from './random';
import type { ThemeId } from './themes';

// Where the vegetation and the boulders go (pure, no three.js; the instanced meshes are in scene/vegetation.ts):
//   - firs (arctic, valley) on the valley walls and around the map edges, denser the higher the ground (below the tree
//     line), in stands; dead trees (standing snags and fallen logs) and dry shrubs, sparse, in the desert;
//   - boulders in every theme, on the slopes, around the compounds and in the near field;
//   - grass clumps in the valley, near the shooter and along the floor.
// Seeded from (mission seed, theme, firing position), so a mission looks the same every time. Everything is visual
// only (no colliders), so it keeps off everything the player must see or shoot past:
//   - the lines of sight: a corridor around the ground line from the shooter's eye to every target (soldier, vehicle
//     target, enemy sniper) that no item's footprint may touch, whatever its height, plus, for trees, shrubs and logs
//     (the tall things), the whole engagement sector with a margin;
//   - 3 m around every target and every prop's footprint;
//   - the shooter's nest area (scene/nest.ts owns it);
//   - near the shooter, anything that would reach up to his eye (the prone view is not walled in).
// Items stand on `ground` (the render mesh's surface, which differs from `field.height` on a coarse grid).

/** Budgets: trees (firs, snags, logs), boulders, grass clumps, shrubs. */
export const MAX_TREES = 600;
export const MAX_BOULDERS = 300;
export const MAX_GRASS = 800;
export const MAX_SHRUBS = 300;
/** Of the boulders, at most this many use the detailed glTF model (the far ones use a light procedural rock). */
export const MAX_NEAR_BOULDERS = 60;
/** Boulders nearer than this (m) to the shooter get the detailed model. */
export const NEAR_BOULDER_RANGE = 140;

/**
 * The height above which no firs grow, m: the terrain's snow line (scene/snowLine.ts, the one the shader lays its snow caps
 * from), so the trees thin out below the snow and none stands in it.
 */
export const TREE_LINE_M: Readonly<Record<'arctic' | 'valley', number>> = { arctic: SNOW_LINES.arctic.line, valley: SNOW_LINES.valley.line };

/** Half-width of the clear corridor along every shooter -> target ground line, beyond the item's own radius, m. */
export const LANE_MARGIN = 2.5;
/** No item's edge comes within this distance of a target, m. */
export const TARGET_MARGIN = 3;
/** Extra clearance around a prop's footprint circle (beyond the item's radius), m. */
export const PROP_MARGIN = 1;
/** Trees, shrubs and logs keep this far (beyond their radius) outside the engagement sector, m. */
export const SECTOR_MARGIN = 6;
/** Within this distance of the shooter (m), no item reaches up to the eye... */
export const EYE_CLEAR_RADIUS = 60;
/** ... its top stays at least this far (m) below the eye. */
export const EYE_CLEARANCE = 0.25;
/** Inside the engagement sector a boulder is at most this scale (about a metre high). */
const SECTOR_BOULDER_SCALE = 1.0;
/** The shrubs round the compounds (which stand inside the sector) are at most this wide and high, m. */
export const LOW_SHRUB_WIDTH = 0.8;
export const LOW_SHRUB_HEIGHT = 0.8;
/** Items stay inside this part of the 4 km map (the map's own edge is 2000 / -3000 / 1000). */
export const SCATTER_BOUNDS = { xMin: -1950, xMax: 1950, zMin: -2950, zMax: 950 } as const;

const DEG = Math.PI / 180;

/** One thing standing on the ground: where, how big, how turned, and which variant of its model. */
export interface ScatterItem {
  x: number;
  /** Height of its base, m (already a little below the ground, so it sits in it). */
  y: number;
  z: number;
  yaw: number;
  /** Radius of the circle on the ground that encloses it at any turn, m. */
  radius: number;
  /** Height above `y`, m (tilt and the shape's bumps included). */
  height: number;
  /** Scale of the unit model along its x, y, z axes. */
  sx: number;
  sy: number;
  sz: number;
  tiltX: number;
  tiltZ: number;
  /** 0..1: brightness and hue variation. */
  shade: number;
  /** Which model: fir 0 slender / 1 full, boulder 0 detailed / 1 light, grass 0..2 (`GRASS_UNIT`). */
  variant: number;
}

export interface ScatterPlan {
  firs: ScatterItem[];
  snags: ScatterItem[];
  logs: ScatterItem[];
  shrubs: ScatterItem[];
  boulders: ScatterItem[];
  grass: ScatterItem[];
}

/** What a placement needs of a mission. */
export interface ScatterInputs {
  field: TerrainField;
  layout: MissionLayout;
  seed: number;
  position: FiringPosition;
  /** The render mesh's surface height; defaults to the field's own height. */
  ground?: (x: number, z: number) => number;
}

// ---------------------------------------------------------------------------------------------
// The surface the terrain mesh actually draws

/**
 * Height of the terrain *mesh* at (x, z): the triangles of `buildTerrainGeometry` over the grid `axes` (vertex
 * heights from `height`, each cell split along its b-c diagonal like the mesh's index buffer). The mesh only agrees
 * with `height` at its vertices: on the coarse grid of the valley walls (25 m) or at the sharp tip of the mountain
 * they differ by up to metres, and an item stands on what is drawn. Outside the grid it falls back to `height`.
 */
export function makeMeshGround(
  axes: { xs: ReadonlyArray<number>; zs: ReadonlyArray<number> },
  height: (x: number, z: number) => number,
): (x: number, z: number) => number {
  const { xs, zs } = axes;
  const nx = xs.length;
  const cache = new Map<number, number>();
  const vertex = (i: number, j: number): number => {
    const k = j * nx + i;
    let h = cache.get(k);
    if (h === undefined) {
      h = height(xs[i], zs[j]);
      cache.set(k, h);
    }
    return h;
  };
  /** Index of the grid line at or below `v`, the last cell for `v` on the final line; -1 outside. */
  const cellOf = (lines: ReadonlyArray<number>, v: number): number => {
    if (v < lines[0] || v > lines[lines.length - 1]) return -1;
    let lo = 0;
    let hi = lines.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (lines[mid] <= v) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  return (x, z) => {
    const i = cellOf(xs, x);
    const j = cellOf(zs, z);
    if (i < 0 || j < 0) return height(x, z);
    const u = (x - xs[i]) / (xs[i + 1] - xs[i]);
    const v = (z - zs[j]) / (zs[j + 1] - zs[j]);
    const ha = vertex(i, j);
    const hb = vertex(i + 1, j);
    const hc = vertex(i, j + 1);
    if (u + v <= 1) return ha + u * (hb - ha) + v * (hc - ha);
    const hd = vertex(i + 1, j + 1);
    return hd + (1 - u) * (hc - hd) + (1 - v) * (hb - hd);
  };
}

// ---------------------------------------------------------------------------------------------
// Small helpers

const smooth = (edge0: number, edge1: number, v: number): number => {
  const t = Math.min(1, Math.max(0, (v - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/** Hash of a lattice cell to [0, 1). */
function cellHash(ix: number, iz: number, salt: number): number {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1) ^ Math.imul(salt, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise in [0, 1], one lattice cell per unit. */
function valueNoise(x: number, z: number, salt: number): number {
  const fx = Math.floor(x);
  const fz = Math.floor(z);
  const tx = x - fx;
  const tz = z - fz;
  const sx = tx * tx * (3 - 2 * tx);
  const sz = tz * tz * (3 - 2 * tz);
  const a = cellHash(fx, fz, salt);
  const b = cellHash(fx + 1, fz, salt);
  const c = cellHash(fx, fz + 1, salt);
  const d = cellHash(fx + 1, fz + 1, salt);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

/** Distance from (px, pz) to the segment a -> b. */
function distanceToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2)) : 0;
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

const THEME_SALT: Record<ThemeId, number> = { desert: 0x1d5e47, arctic: 0x7a3c19, valley: 0x35b2d1 };
const POSITION_SALT: Record<FiringPosition, number> = { valley: 0x51a1, ridge: 0x7b3d, mountain: 0x9c27 };

/** The generator of one kind of item: the same (seed, theme, position, kind) always gives the same stream. */
function kindRng(seed: number, theme: ThemeId, position: FiringPosition, salt: number): Rng {
  return createRng((Math.imul((seed | 0) ^ THEME_SALT[theme] ^ (POSITION_SALT[position] << 7), 0x9e3779b1) ^ Math.imul(salt, 0x85ebca6b)) >>> 0);
}

/** A point at bearing `theta` from straight downrange (-Z) and distance `r` from (ox, oz). */
const polar = (ox: number, oz: number, theta: number, r: number): { x: number; z: number } => ({
  x: ox + r * Math.sin(theta),
  z: oz - r * Math.cos(theta),
});

// ---------------------------------------------------------------------------------------------
// The placer: what is excluded and what is already taken

interface Disc {
  x: number;
  z: number;
  r: number;
}

const CELL = 12;

class Placer {
  readonly eye: { x: number; y: number; z: number };
  private readonly discs: Disc[] = [];
  private readonly targets: Array<{ x: number; z: number }> = [];
  private readonly taken = new Map<number, Disc[]>();
  readonly outcrops: TerrainField['outcrops'];

  constructor(
    readonly field: TerrainField,
    readonly ground: (x: number, z: number) => number,
    layout: MissionLayout,
  ) {
    this.eye = field.shooter;
    this.outcrops = field.outcrops;
    for (const s of layout.soldiers) {
      this.targets.push(s);
      this.discs.push({ x: s.x, z: s.z, r: TARGET_MARGIN });
    }
    for (const v of layout.vehicleTargets) {
      this.targets.push(v);
      this.discs.push({ x: v.x, z: v.z, r: Math.max(TARGET_MARGIN, propFootprintRadius(v.kind) + PROP_MARGIN) });
    }
    for (const s of layout.snipers) {
      this.targets.push(s);
      this.discs.push({ x: s.x, z: s.z, r: TARGET_MARGIN });
    }
    for (const p of layout.props) this.discs.push({ x: p.x, z: p.z, r: propFootprintRadius(p.kind) + PROP_MARGIN });
  }

  private key(cx: number, cz: number): number {
    return (cx + 4096) * 8192 + (cz + 4096);
  }

  /** Slope of the drawn ground at (x, z): rise over run by central differences over 3 m. */
  slope(x: number, z: number): number {
    const g = this.ground;
    return Math.hypot(g(x + 1.5, z) - g(x - 1.5, z), g(x, z + 1.5) - g(x, z - 1.5)) / 3;
  }

  /** How high an item at (x, z) may reach: below the eye near the shooter, unlimited far from him. */
  ceiling(x: number, z: number): number {
    return Math.hypot(x - this.eye.x, z - this.eye.z) < EYE_CLEAR_RADIUS ? this.eye.y - EYE_CLEARANCE : Infinity;
  }

  onMound(x: number, z: number, r: number): boolean {
    return this.outcrops.some((o) => Math.hypot(x - o.x, z - o.z) < o.radius * 1.15 + r);
  }

  /**
   * True when an item of footprint radius `r` may stand at (x, z). `tall`: it is a tree, a shrub or a log, which also
   * stays out of the engagement sector. `spacing`: how close to its neighbours it may stand, as a share of their radii.
   */
  free(x: number, z: number, r: number, tall: boolean, spacing: number): boolean {
    const B = SCATTER_BOUNDS;
    if (x - r < B.xMin || x + r > B.xMax || z - r < B.zMin || z + r > B.zMax) return false;
    if (Math.hypot(x - this.eye.x, z - this.eye.z) < NEST_AREA_RADIUS + r) return false;
    for (const d of this.discs) if (Math.hypot(x - d.x, z - d.z) < d.r + r) return false;
    for (const t of this.targets) {
      if (distanceToSegment(x, z, this.eye.x, this.eye.z, t.x, t.z) < r + LANE_MARGIN) return false;
    }
    if (tall && sectorDistance(x, z) < r + SECTOR_MARGIN) return false;
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const list = this.taken.get(this.key(cx + i, cz + j));
        if (!list) continue;
        for (const o of list) if (Math.hypot(x - o.x, z - o.z) < (r + o.r) * spacing) return false;
      }
    }
    return true;
  }

  claim(x: number, z: number, r: number): void {
    const k = this.key(Math.floor(x / CELL), Math.floor(z / CELL));
    const list = this.taken.get(k);
    if (list) list.push({ x, z, r });
    else this.taken.set(k, [{ x, z, r }]);
  }
}

/** A point in the sector ahead of the shooter (mostly) or all round it, biased towards the shooter: radius = near + span * u^bias. */
function nearField(rng: Rng, near: number, span: number, bias: number, allRound: number, halfAngle = 70 * DEG): { x: number; z: number } {
  const theta = rng() < allRound ? rng() * 2 * Math.PI : (rng() * 2 - 1) * halfAngle;
  return polar(0, 0, theta, near + span * Math.pow(rng(), bias));
}

/** A point around `anchor`: radius = near + span * u^bias, any direction. */
function around(rng: Rng, anchor: { x: number; z: number }, near: number, span: number, bias: number): { x: number; z: number } {
  const a = rng() * 2 * Math.PI;
  const r = near + span * Math.pow(rng(), bias);
  return { x: anchor.x + r * Math.cos(a), z: anchor.z + r * Math.sin(a) };
}

// ---------------------------------------------------------------------------------------------
// Per-theme budgets

interface Budget {
  firs: number;
  snags: number;
  logs: number;
  shrubs: number;
  /** Boulders on the slopes, around the compounds, in the near field. */
  boulders: [number, number, number];
  grass: number;
}

const BUDGETS: Record<ThemeId, Budget> = {
  desert: { firs: 0, snags: 34, logs: 22, shrubs: 260, boulders: [110, 55, 55], grass: 0 },
  arctic: { firs: 430, snags: 6, logs: 5, shrubs: 60, boulders: [100, 45, 45], grass: 0 },
  valley: { firs: 500, snags: 5, logs: 12, shrubs: 200, boulders: [80, 40, 40], grass: 700 },
};

// ---------------------------------------------------------------------------------------------
// The plan

/** A boulder item from a scale and the unit model's size. */
function boulderItem(
  rng: Rng,
  placer: Placer,
  x: number,
  z: number,
  scale: number,
  variant: number,
): ScatterItem | null {
  const squash = 0.8 + 0.35 * rng();
  const sx = scale * (0.85 + 0.3 * rng());
  const sy = scale * squash;
  const sz = scale * (0.85 + 0.3 * rng());
  const tiltX = (rng() - 0.5) * 0.24;
  const tiltZ = (rng() - 0.5) * 0.24;
  // The footprint holds the rock at any turn and the lean of its top; its height holds the tilted rock's highest corner.
  const lean = Math.max(Math.abs(tiltX), Math.abs(tiltZ));
  const half = 0.5 * Math.hypot(BOULDER_UNIT.lx * sx, BOULDER_UNIT.lz * sz);
  const radius = half * 1.04 + BOULDER_UNIT.ly * sy * lean;
  const height = BOULDER_UNIT.ly * sy * 1.12 + half * lean;
  const yaw = rng() * Math.PI * 2;
  const shade = rng();
  const ground = placer.ground(x, z);
  // Sit in the ground: lower on a slope, where the downhill side would otherwise hang in the air.
  const sink = Math.min(BOULDER_UNIT.ly * sy * 0.14 + placer.slope(x, z) * radius * 0.35, height * 0.4);
  if (ground - sink + height > placer.ceiling(x, z)) return null;
  return { x, y: ground - sink, z, yaw, radius, height, sx, sy, sz, tiltX, tiltZ, shade, variant };
}

/**
 * Seeded placement of every tree, shrub, boulder and grass clump of a mission (counts per theme in `BUDGETS`;
 * always within the module's maxima). Deterministic for (seed, theme, position, layout).
 */
export function planScatter(inputs: ScatterInputs): ScatterPlan {
  const { field, layout, seed, position } = inputs;
  const theme = field.theme;
  const ground = inputs.ground ?? field.height;
  const placer = new Placer(field, ground, layout);
  const budget = BUDGETS[theme];
  const plan: ScatterPlan = { firs: [], snags: [], logs: [], shrubs: [], boulders: [], grass: [] };
  const mk = (salt: number): Rng => kindRng(seed, theme, position, salt);

  // ---- firs: the valley walls and the map's edges, denser with height, below the tree line, in stands
  if (budget.firs > 0 && (theme === 'arctic' || theme === 'valley')) {
    const rng = mk(1);
    const line = TREE_LINE_M[theme];
    const grove = (x: number, z: number): number => 0.65 * valueNoise(x / 130, z / 130, 11) + 0.35 * valueNoise(x / 45, z / 45, 12);
    for (let attempts = 0; plan.firs.length < budget.firs && attempts < budget.firs * 160; attempts++) {
      // 55 % near (the walls in view), 30 % mid, 15 % far (the map's edges)
      const roll = rng();
      const r = roll < 0.55 ? 90 + 620 * Math.pow(rng(), 1.3) : roll < 0.85 ? 500 + 800 * rng() : 1300 + 650 * rng();
      const p = polar(0, 0, rng() * 2 * Math.PI, r);
      const h = ground(p.x, p.z);
      const dens = (0.05 + 0.95 * smooth(1, 55, h)) * (1 - smooth(line - 30, line, h));
      if (dens <= 0.01) continue;
      const steep = placer.slope(p.x, p.z);
      const slopeOk = 1 - smooth(0.7, 1.05, steep);
      const stand = 0.2 + 1.6 * smooth(0.4, 0.62, grove(p.x, p.z));
      if (rng() >= dens * slopeOk * stand) continue;
      // Taller low down, stunted near the tree line.
      const stunt = 1 - 0.4 * smooth(line - 40, line, h);
      const height = (6 + 9 * Math.pow(rng(), 1.3)) * stunt;
      const variant = rng() < 0.5 ? 0 : 1;
      const canopy = height * (variant === 0 ? 0.17 : 0.24) * (0.9 + 0.2 * rng());
      const tiltX = (rng() - 0.5) * 0.08;
      const tiltZ = (rng() - 0.5) * 0.08;
      // The footprint holds the crown and the lean of the whole tree.
      const radius = canopy + height * Math.hypot(tiltX, tiltZ);
      if (!placer.free(p.x, p.z, radius, true, 0.7) || placer.onMound(p.x, p.z, radius)) continue;
      placer.claim(p.x, p.z, radius);
      plan.firs.push({
        x: p.x,
        y: ground(p.x, p.z) - 0.3,
        z: p.z,
        yaw: rng() * Math.PI * 2,
        radius,
        height,
        sx: canopy,
        sy: height,
        sz: canopy,
        tiltX,
        tiltZ,
        shade: rng(),
        variant,
      });
    }
  }

  // ---- dead trees: standing snags and fallen logs, sparse, on gentle slopes outside the sector
  const deadPlace = (list: ScatterItem[], count: number, salt: number, make: (rng: Rng, x: number, z: number, g: number) => ScatterItem): void => {
    const rng = mk(salt);
    for (let attempts = 0; list.length < count && attempts < count * 120; attempts++) {
      const p = polar(0, 0, rng() * 2 * Math.PI, 70 + 1100 * Math.pow(rng(), 1.5));
      const g = ground(p.x, p.z);
      if (g > 80 || placer.slope(p.x, p.z) > 0.45) continue;
      const item = make(rng, p.x, p.z, g);
      if (!placer.free(p.x, p.z, item.radius, true, 1) || placer.onMound(p.x, p.z, item.radius)) continue;
      if (item.y + item.height > placer.ceiling(p.x, p.z)) continue;
      placer.claim(p.x, p.z, item.radius);
      list.push(item);
    }
  };
  deadPlace(plan.snags, budget.snags, 2, (rng, x, z, g) => {
    const s = 0.8 + 0.8 * rng();
    return {
      x,
      y: g - 0.2,
      z,
      yaw: rng() * Math.PI * 2,
      radius: SNAG_UNIT.reach * s,
      height: SNAG_UNIT.height * s + 0.3,
      sx: s,
      sy: s,
      sz: s,
      tiltX: (rng() - 0.5) * 0.12,
      tiltZ: (rng() - 0.5) * 0.12,
      shade: rng(),
      variant: 0,
    };
  });
  deadPlace(plan.logs, budget.logs, 3, (rng, x, z, g) => {
    const s = 0.8 + rng() * 1.0;
    return {
      x,
      y: g - 0.02,
      z,
      yaw: rng() * Math.PI * 2,
      radius: LOG_UNIT.length * 0.5 * s,
      height: LOG_UNIT.radius * 2 * s + 0.12,
      sx: s,
      sy: s,
      sz: s,
      tiltX: (rng() - 0.5) * 0.1,
      tiltZ: (rng() - 0.5) * 0.1,
      shade: rng(),
      variant: 0,
    };
  });

  // ---- boulders: slopes, around the compounds, the near field
  {
    const rng = mk(4);
    const [onSlopes, atCompounds, nearBy] = budget.boulders;
    let near = 0;
    const add = (p: { x: number; z: number }, scale: number, slopeMax: number): boolean => {
      if (plan.boulders.length >= MAX_BOULDERS) return false;
      const dist = Math.hypot(p.x - field.shooter.x, p.z - field.shooter.z);
      const inSector = sectorDistance(p.x, p.z) === 0;
      const s = inSector ? Math.min(scale, SECTOR_BOULDER_SCALE) : scale;
      const wantNear = dist < NEAR_BOULDER_RANGE;
      if (wantNear && near >= MAX_NEAR_BOULDERS) return false;
      const radius = 0.5 * Math.hypot(BOULDER_UNIT.lx, BOULDER_UNIT.lz) * s * 1.2;
      if (!placer.free(p.x, p.z, radius, false, 0.9) || placer.slope(p.x, p.z) > slopeMax) return false;
      const item = boulderItem(rng, placer, p.x, p.z, s, wantNear ? 0 : 1);
      if (!item || !placer.free(p.x, p.z, item.radius, false, 0.9)) return false;
      placer.claim(p.x, p.z, item.radius);
      if (wantNear) near++;
      plan.boulders.push(item);
      return true;
    };
    // on the slopes (the walls and the hills), bigger with distance so they read from afar
    let placed = 0;
    for (let attempts = 0; placed < onSlopes && attempts < onSlopes * 120; attempts++) {
      const p = polar(0, 0, rng() * 2 * Math.PI, 60 + 1500 * Math.pow(rng(), 1.5));
      const h = ground(p.x, p.z);
      const steep = placer.slope(p.x, p.z);
      if (rng() >= (0.06 + 0.94 * smooth(0.12, 0.55, steep)) * (0.5 + 0.5 * smooth(0, 60, h))) continue;
      const dist = Math.hypot(p.x, p.z);
      const scale = Math.min(5, (0.9 + 2.4 * Math.pow(rng(), 2)) * (1 + Math.min(1.5, dist / 400)));
      if (add(p, scale, 1.2)) placed++;
    }
    // around the compounds, or (without props) the other targets
    const anchors: Array<{ x: number; z: number }> = layout.props.length > 0 ? layout.props : [...layout.soldiers, ...layout.vehicleTargets];
    placed = 0;
    for (let attempts = 0; anchors.length > 0 && placed < atCompounds && attempts < atCompounds * 120; attempts++) {
      const a = anchors[Math.floor(rng() * anchors.length)];
      const p = around(rng, a, 4, 30, 1.3);
      if (add(p, 0.4 + 1.1 * Math.pow(rng(), 2), 0.6)) placed++;
    }
    // the near field around the shooter, mostly ahead of him
    placed = 0;
    for (let attempts = 0; placed < nearBy && attempts < nearBy * 120; attempts++) {
      const p = nearField(rng, 10, 150, 1.5, 0.25);
      if (add(p, 0.35 + 0.9 * Math.pow(rng(), 2), 0.5)) placed++;
    }
  }

  // ---- shrubs: dry in the desert, green in the valley, bare and dark in the snow
  {
    const rng = mk(5);
    const compounds: Array<{ x: number; z: number }> = layout.props;
    for (let attempts = 0; plan.shrubs.length < budget.shrubs && attempts < budget.shrubs * 120; attempts++) {
      // a third of them round the compounds (low ones: the compounds stand inside the sector, where only low things may grow,
      // off the lines of sight), the rest over the slopes and the near field
      const atCompound = compounds.length > 0 && rng() < 0.3;
      const p = atCompound ? around(rng, compounds[Math.floor(rng() * compounds.length)], 4, 24, 1.2) : nearField(rng, 22, 900, 1.9, 0.6, 100 * DEG);
      const g = ground(p.x, p.z);
      if (placer.slope(p.x, p.z) > 0.75 || g > 90) continue;
      const w = Math.min(0.45 + 0.9 * Math.pow(rng(), 1.5), atCompound ? LOW_SHRUB_WIDTH : Infinity);
      const h = Math.min(w * (0.55 + 0.5 * rng()), atCompound ? LOW_SHRUB_HEIGHT : Infinity);
      const sz = w * (0.85 + 0.3 * rng());
      const radius = Math.max(w, sz); // the shrub's unit model has radius 1
      if (!placer.free(p.x, p.z, radius, !atCompound, 0.9) || placer.onMound(p.x, p.z, radius)) continue;
      if (g - 0.1 + h > placer.ceiling(p.x, p.z)) continue;
      placer.claim(p.x, p.z, radius);
      plan.shrubs.push({
        x: p.x,
        y: g - 0.1,
        z: p.z,
        yaw: rng() * Math.PI * 2,
        radius,
        height: h,
        sx: w,
        sy: h,
        sz,
        tiltX: 0,
        tiltZ: 0,
        shade: rng(),
        variant: 0,
      });
    }
  }

  // ---- grass clumps (valley): near the shooter and along the floor
  if (budget.grass > 0) {
    const rng = mk(6);
    for (let attempts = 0; plan.grass.length < budget.grass && attempts < budget.grass * 60; attempts++) {
      const far = rng() < 0.3;
      const p = far ? nearField(rng, 70, 230, 1.4, 0.3) : nearField(rng, 6, 70, 1.5, 0.15);
      const g = ground(p.x, p.z);
      if (placer.slope(p.x, p.z) > 0.5) continue;
      // mostly the light clumps (the glTF's three clumps have 340, 190 and 220 triangles)
      const pick = rng();
      const variant = pick < 0.45 ? 1 : pick < 0.8 ? 0 : 2;
      const unit = GRASS_UNIT[variant];
      const scale = 1.4 + 1.6 * rng();
      const radius = unit.radius * scale;
      const sy = scale * (0.8 + 0.4 * rng());
      if (!placer.free(p.x, p.z, radius, false, 0.8) || placer.onMound(p.x, p.z, radius)) continue;
      if (g - 0.02 + unit.height * sy > placer.ceiling(p.x, p.z)) continue;
      placer.claim(p.x, p.z, radius);
      plan.grass.push({
        x: p.x,
        y: g - 0.02,
        z: p.z,
        yaw: rng() * Math.PI * 2,
        radius,
        height: unit.height * sy,
        sx: scale,
        sy,
        sz: scale,
        tiltX: 0,
        tiltZ: 0,
        shade: rng(),
        variant,
      });
    }
  }

  return plan;
}

/** Every item of a plan. */
export function allItems(plan: ScatterPlan): ScatterItem[] {
  return [...plan.firs, ...plan.snags, ...plan.logs, ...plan.shrubs, ...plan.boulders, ...plan.grass];
}

/**
 * Every item as an axis-aligned box that encloses it (its footprint circle by its height), for checking the lines of
 * sight with the same segment tests the layout uses (tests only: the scatter is visual and has no colliders).
 */
export function scatterBounds(plan: ScatterPlan): Obstacle[] {
  return allItems(plan).map((it, i) => ({
    id: `scatter-${i}`,
    material: 'wall' as const,
    box: {
      center: { x: it.x, y: it.y + it.height / 2, z: it.z },
      halfSize: { x: it.radius, y: it.height / 2, z: it.radius },
      yaw: 0,
    },
  }));
}
