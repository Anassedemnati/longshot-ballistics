import { RIFLES } from '../ballistics/rifles';
import type { Vec3 } from '../ballistics/types';
import { segmentBox } from '../game/hit';
import type { Box, Obstacle } from '../game/hit';
import { SECTOR_HALF_ANGLE_RAD, SECTOR_MAX_RANGE } from '../scene/terrainField';
import type { TerrainField } from '../scene/terrainField';
import { MISSION_LIMITS } from './config';
import type { Density, MissionConfig } from './config';
import { DUMMY_HEAD, DUMMY_UPRIGHT, LOWER_TORSO_CY, UPPER_TORSO_CY } from './dummyDims';
import { backdropScore, nearestCoverGap, pickHide, scoreHide } from './hide';
import { COMPOUND_AREA_M, COMPOUND_CLEAR_M, ROUTE_KEEP_OFF_M, finishHvt, planCompound, routeLegs } from './hvtLayout';
import type { CompoundDraft, HvtPlacement } from './hvtLayout';
import {
  propBoxes,
  propColliders,
  propFootprintRadius,
  rooftopSpot,
  vehicleEngineObstacle,
  vehicleTargetColliders,
} from './props';
import type { PropKind, PropPlacement } from './props';
import { createRng, randInt } from './random';
import type { Rng } from './random';
import { SNIPER_REACH, sniperAimPoints, sniperBoundsObstacle } from './sniperDims';

// Seeded, deterministic mission layout (pure, no three.js): where the props, the vehicle targets and
// the soldiers go. World frame: Y up, downrange = -Z, the shooter's eye is `field.shooter` near the origin.
//
// Order of work: props (clustered into 1-3 "sites"), then vehicle targets, then soldiers, then the enemy
// snipers. Every accepted soldier has a clear line of sight from the shooter to the head and upper-torso
// centres past the terrain, all colliders and the other soldiers; some stand behind low cover (see below).
// Snipers come last, so they never move anything else: every roof, ridge and open-ground spot that passes the same hard rules
// (a clear line of sight both ways) is scored for how well it hides him (see hide.ts) and one of the best is picked, so the hides
// differ from seed to seed (see `placeSniper`).

export interface SoldierPlacement {
  id: string;
  x: number;
  z: number;
  /** Rotation about +Y, rad; the dummy's front (+Z) points toward the shooter at yaw = atan2(-x, -z). */
  yaw: number;
  /** Horizontal distance from the shooter, m. */
  range: number;
  /** True when the cover predicate holds: lower torso hidden by a wall or vehicle, head and upper torso in view. */
  behindCover: boolean;
}

export interface VehicleTargetPlacement {
  id: string;
  kind: 'truck' | 'jeep';
  x: number;
  z: number;
  yaw: number;
  range: number;
}

/** Where an enemy sniper lies: on a roof, on high ground near the sector's edge, or in the open. */
export type SniperSite = 'roof' | 'ridge' | 'open';

export interface SniperPlacement {
  id: string;
  x: number;
  /** Height of the surface under his belly (the ground, or the top of a roof), m. */
  y: number;
  z: number;
  /** Rotation about +Y, rad; his head end (local +Z) points toward the shooter at yaw = facingYaw(x, z). */
  yaw: number;
  site: SniperSite;
  /** Horizontal distance from the shooter, m. */
  range: number;
}

export interface MissionLayout {
  soldiers: SoldierPlacement[];
  vehicleTargets: VehicleTargetPlacement[];
  /** Enemy snipers, `config.enemySnipers` of them: extra targets that shoot back (see game/encounter.ts). */
  snipers: SniperPlacement[];
  /** Scenery: houses, sheds, walls and parked vehicles (the vehicle targets are not in here). */
  props: PropPlacement[];
  /** An `hvt` mission: the officer's compound (its house and jeep are the first two props), his walk and his ways out. */
  hvt?: HvtPlacement;
}

const DEG = Math.PI / 180;

/** Yaw that turns a prop or dummy at (x, z) to face a shooter at the origin (its local +Z points at the origin). */
export function facingYaw(x: number, z: number): number {
  return Math.atan2(-x, -z);
}

/** Wrap an angle into (-pi, pi]. */
function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

// ---------------------------------------------------------------------------------------------
// Line of sight

/** Terrain is sampled this often along a line of sight, m. */
const TERRAIN_STEP = 2;
/** The ground must stay this far below the line of sight, m (a bullet leaves a few cm below the sight line). */
const TERRAIN_CLEARANCE = 0.1;
/** The last stretch before the end point is the target's own patch of ground and is not tested, m. */
const TARGET_PATCH = 2;

function hitsAny(a: Vec3, b: Vec3, obstacles: readonly Obstacle[]): boolean {
  for (let i = 0; i < obstacles.length; i++) {
    if (segmentBox(a, b, obstacles[i].box) !== null) return true;
  }
  return false;
}

/** True when the ground (sampled every 2 m, skipping the last 2 m) stays below the straight line from -> to. */
function terrainClear(from: Vec3, to: Vec3, field: TerrainField): boolean {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const horizontal = Math.hypot(dx, dz);
  const samples = Math.floor((horizontal - TARGET_PATCH) / TERRAIN_STEP);
  for (let i = 1; i <= samples; i++) {
    const u = (i * TERRAIN_STEP) / horizontal;
    const x = from.x + dx * u;
    const z = from.z + dz * u;
    if (field.height(x, z) >= from.y + (to.y - from.y) * u - TERRAIN_CLEARANCE) return false;
  }
  return true;
}

/**
 * True when the straight line from `from` to `to` is open: it touches none of the obstacles and
 * stays above the terrain (sampled every 2 m; the last 2 m before `to` are its own ground and are
 * not tested). Obstacles go first because they are the cheap test.
 */
export function lineOfSightClear(from: Vec3, to: Vec3, field: TerrainField, obstacles: Obstacle[]): boolean {
  return !hitsAny(from, to, obstacles) && terrainClear(from, to, field);
}

// ---------------------------------------------------------------------------------------------
// Soldier helpers

/** World points on a soldier the shooter aims at: the head, upper-torso and lower-torso centres. */
export function soldierAimPoints(
  s: SoldierPlacement,
  field: TerrainField,
): { head: Vec3; upperTorso: Vec3; lowerTorso: Vec3 } {
  const g = field.height(s.x, s.z);
  return {
    head: { x: s.x, y: g + DUMMY_HEAD.cy, z: s.z },
    upperTorso: { x: s.x, y: g + UPPER_TORSO_CY, z: s.z },
    lowerTorso: { x: s.x, y: g + LOWER_TORSO_CY, z: s.z },
  };
}

/**
 * A soldier's upright bounds as a collider-shaped box (arms and boots included), so line-of-sight
 * checks can tell when one soldier would hide another. The aim points lie inside it, so never test a
 * soldier's own bounds against its own aim points.
 */
export function soldierUprightBounds(s: SoldierPlacement, field: TerrainField): Obstacle {
  return {
    id: `${s.id}:bounds`,
    material: 'metal',
    box: {
      center: { x: s.x, y: field.height(s.x, s.z) + DUMMY_UPRIGHT.halfHeight, z: s.z },
      halfSize: { x: DUMMY_UPRIGHT.halfWidth, y: DUMMY_UPRIGHT.halfHeight, z: DUMMY_UPRIGHT.halfDepth },
      yaw: s.yaw,
    },
  };
}

/**
 * Every collider of the scenery and the vehicle-target bodies (the engine blocks are hit zones, not
 * colliders): what the bullets must stop on. Ground height is the terrain height at each placement.
 */
export function layoutColliders(layout: MissionLayout, field: TerrainField): Obstacle[] {
  const out: Obstacle[] = [];
  for (const p of layout.props) out.push(...propColliders(p, field.height(p.x, p.z)));
  for (const v of layout.vehicleTargets) out.push(...vehicleTargetColliders(v, field.height(v.x, v.z)).body);
  return out;
}

/**
 * The practice range of a legacy URL (`?range=...`): one soldier straight downrange at the range, no props.
 * Only the legacy route uses it (src/mission/run.ts picks it by route, never by the shape of the config):
 * a menu mission with one soldier and no props is a normal mission and goes through `generateLayout`.
 */
export function legacyLayout(config: MissionConfig): MissionLayout {
  const range = config.rangeMin;
  return {
    soldiers: [{ id: 'soldier-0', x: 0, z: -range, yaw: 0, range, behindCover: false }],
    vehicleTargets: [],
    snipers: [],
    props: [],
  };
}

// ---------------------------------------------------------------------------------------------
// Props

/** Buildings (houses + walls + sheds) per density, inclusive. */
const BUILDING_COUNTS: Record<Density, [number, number]> = { none: [0, 0], few: [3, 5], many: [8, 12] };
/** Scenery vehicles (trucks + jeeps) per density, inclusive. */
const VEHICLE_COUNTS: Record<Density, [number, number]> = { none: [0, 0], few: [2, 3], many: [5, 7] };

/** Props never stand nearer than this, m (the shooter's 40 m rise and open ground in front of it). */
const MIN_PROP_RANGE = 100;
/** Empty space kept between two prop footprints, m. */
const PROP_GAP = 1;
/** Sites lie this far outside the range band at most, m. */
const SITE_BAND_MARGIN = 150;
/** Site bearing limit, rad (inside the soldiers' own arena). */
const SITE_BEARING = 8 * DEG;
const PROP_ATTEMPTS = 200;
/** A band narrower than this (m) is thinner than a site, so the first site's low cover is lined up just in front of it. */
const NARROW_BAND = 60;
/** Share of the first site's walls and vehicles lined up in front of a narrow band. */
const FRONT_LINE_SHARE = 0.7;

/** Drop order when props have to go: tall blockers first, low cover last. */
const KEEP_PRIORITY: Record<PropKind, number> = { wall: 0, truck: 1, jeep: 1, shed: 2, house: 3 };

/** True when a footprint circle of radius `fr` around (x, z) lies fully inside the engagement sector, at least 100 m out. */
function propFitsSector(x: number, z: number, fr: number): boolean {
  if (z >= 0) return false;
  const r = Math.hypot(x, z);
  if (r < MIN_PROP_RANGE + fr || r > SECTOR_MAX_RANGE - fr) return false;
  const theta = Math.atan2(Math.abs(x), -z);
  return r * Math.sin(SECTOR_HALF_ANGLE_RAD - theta) >= fr + 1;
}

function propYaw(kind: PropKind, x: number, z: number, rng: Rng): number {
  const facing = facingYaw(x, z);
  switch (kind) {
    case 'wall':
      // Mostly across the line of fire (that is what makes a wall cover), sometimes at any angle.
      return wrapAngle(rng() < 0.75 ? facing + (rng() * 2 - 1) * 30 * DEG : rng() * 2 * Math.PI);
    case 'house':
      return wrapAngle(facing + randInt(rng, 0, 3) * 90 * DEG + (rng() * 2 - 1) * 20 * DEG);
    default:
      return wrapAngle(rng() * 2 * Math.PI);
  }
}

/**
 * Scenery in 1-3 sites (a compound or a camp), each a disc of ground inside the sector. Counts follow
 * the densities (buildings = houses + walls + sheds, vehicles = trucks + jeeps). The first site lies
 * inside the range band so there is cover where the soldiers are. Returned in keep-priority order.
 */
function planProps(config: MissionConfig, rng: Rng): PropPlacement[] {
  const [bLo, bHi] = BUILDING_COUNTS[config.buildings];
  const [vLo, vHi] = VEHICLE_COUNTS[config.vehicles];
  const buildings = randInt(rng, bLo, bHi);
  const vehicles = randInt(rng, vLo, vHi);
  const total = buildings + vehicles;
  if (total === 0) return [];

  const houses = buildings === 0 ? 0 : Math.max(1, Math.round(buildings * 0.3));
  const walls = buildings === 0 ? 0 : Math.max(1, Math.round(buildings * 0.45));
  const sheds = buildings - houses - walls;
  const kinds: PropKind[] = [
    ...Array<PropKind>(houses).fill('house'),
    ...Array<PropKind>(sheds).fill('shed'),
    ...Array<PropKind>(walls).fill('wall'),
  ];
  for (let i = 0; i < vehicles; i++) kinds.push(rng() < 0.5 ? 'truck' : 'jeep');

  const siteCount = Math.min(randInt(rng, 1, 3), total);
  const rangeLo = Math.max(MIN_PROP_RANGE + 40, config.rangeMin - SITE_BAND_MARGIN);
  const rangeHi = Math.min(SECTOR_MAX_RANGE - 80, config.rangeMax + SITE_BAND_MARGIN);
  const sites = Array.from({ length: siteCount }, (_, i) => {
    const lo = i === 0 ? Math.max(rangeLo, config.rangeMin) : rangeLo;
    const hi = i === 0 ? Math.min(rangeHi, config.rangeMax) : rangeHi;
    const range = lo + rng() * Math.max(0, hi - lo);
    const bearing = (rng() * 2 - 1) * SITE_BEARING;
    return { x: range * Math.sin(bearing), z: -range * Math.cos(bearing), range, bearing, members: 0 };
  });
  const assignment = kinds.map(() => {
    const site = siteCount === 1 || rng() < 0.5 ? 0 : randInt(rng, 1, siteCount - 1);
    sites[site].members++;
    return site;
  });

  const narrow = config.rangeMax - config.rangeMin < NARROW_BAND;
  const placed: PropPlacement[] = [];
  kinds.forEach((kind, i) => {
    const site = sites[assignment[i]];
    const radius = Math.max(22, 8.5 * Math.sqrt(site.members));
    const fr = propFootprintRadius(kind);
    const lowCover = kind === 'wall' || kind === 'truck' || kind === 'jeep';
    // Just in front of where a soldier of the band can stand: at most 3 m before the band's near edge
    // and 1 m before its far edge, but never nearer than props may be. Nothing fits in front of a band
    // that ends at about 100 m, so those props stay in the site disc.
    const frontLo = Math.max(config.rangeMin - 3, MIN_PROP_RANGE + fr + 0.5);
    const frontHi = config.rangeMax - 1;
    const frontLine = lowCover && assignment[i] === 0 && narrow && frontHi > frontLo && rng() < FRONT_LINE_SHARE;
    for (let attempt = 0; attempt < PROP_ATTEMPTS; attempt++) {
      // The disc grows with the attempt number, so a crowded site spills over rather than losing props.
      const grow = 1 + attempt / 100;
      let x: number;
      let z: number;
      if (frontLine) {
        // Spread sideways over the site.
        const range = frontLo + rng() * (frontHi - frontLo);
        const bearing = site.bearing + ((rng() * 2 - 1) * radius * grow) / site.range;
        x = range * Math.sin(bearing);
        z = -range * Math.cos(bearing);
      } else {
        const reach = radius * Math.sqrt(rng()) * grow;
        const angle = rng() * 2 * Math.PI;
        x = site.x + reach * Math.sin(angle);
        z = site.z + reach * Math.cos(angle);
      }
      if (!propFitsSector(x, z, fr)) continue;
      if (placed.some((q) => Math.hypot(q.x - x, q.z - z) < fr + propFootprintRadius(q.kind) + PROP_GAP)) continue;
      placed.push({ id: '', kind, x, z, yaw: propYaw(kind, x, z, rng) });
      break;
    }
  });
  return placed.sort((a, b) => KEEP_PRIORITY[a.kind] - KEEP_PRIORITY[b.kind]);
}

// ---------------------------------------------------------------------------------------------
// Placement of vehicle targets and soldiers

interface Stage {
  /** Minimum distance between two soldiers (vehicle targets: extra gap between footprints), m. */
  spacing: number;
  /** Largest bearing from straight downrange, rad. */
  bearing: number;
  attempts: number;
}

const STRICT_BEARING = 10 * DEG;
const MAX_BEARING = SECTOR_HALF_ANGLE_RAD;
/** Up to 200 attempts per soldier: relax the spacing first, then the bearing (never beyond 12 degrees). */
const SOLDIER_STAGES: readonly Stage[] = [
  { spacing: 6, bearing: STRICT_BEARING, attempts: 50 },
  { spacing: 3, bearing: STRICT_BEARING, attempts: 50 },
  { spacing: 1.5, bearing: STRICT_BEARING, attempts: 50 },
  { spacing: 1.5, bearing: MAX_BEARING, attempts: 50 },
];
const VEHICLE_STAGES: readonly Stage[] = [
  { spacing: 3, bearing: STRICT_BEARING, attempts: 150 },
  { spacing: 3, bearing: MAX_BEARING, attempts: 50 },
];
/**
 * The final pass (no props left) relaxes only the spacing between targets. Every other check stays:
 * line of sight to the head and upper torso (the engine centre for a vehicle), not inside any box
 * (engine blocks included), not hiding another target. If even this finds nothing, generateLayout
 * throws rather than hand out an invalid soldier or vehicle.
 */
const LAST_RESORT: Stage = { spacing: 0, bearing: MAX_BEARING, attempts: 400 };

/** Horizontal clearance a soldier keeps from every prop and vehicle box, m (arms and boots included). */
const SOLDIER_CLEARANCE = 0.3;
/** Soldiers yaw up to this far either side of facing the shooter, rad. */
const SOLDIER_YAW_JITTER = 15 * DEG;
/** Vehicle targets point their front up to this far either side of the shooter, rad. */
const VEHICLE_YAW_SPREAD = 100 * DEG;

/** Share of the soldiers tried behind cover. */
const COVER_FRACTION = 0.4;
/** Soldiers search behind cover in steps this long, m. */
const COVER_STEP = 0.25;
/** Distance behind the cover's footprint edge (plus the 0.3 m clearance) that is searched, m. */
const COVER_BEHIND_MIN = 0.25;
const COVER_BEHIND_MAX = 6;
/** Cover candidates are low boxes: their tops lie in this height window, m (lower torso 1.0, upper torso 1.35). */
const COVER_TOP_MIN = 1.1;
const COVER_TOP_MAX = 1.3;
/** Random points on cover tried per soldier, and per candidate. */
const COVER_PROBES = 60;
const COVER_PROBES_PER_CANDIDATE = 3;

/** An obstacle box as a footprint, inflated by the soldier clearance, for cheap point-inside tests. */
interface Solid {
  cx: number;
  cz: number;
  c: number;
  s: number;
  hx: number;
  hz: number;
  reach: number;
}

function toSolid(o: Obstacle): Solid {
  const hx = o.box.halfSize.x + SOLDIER_CLEARANCE;
  const hz = o.box.halfSize.z + SOLDIER_CLEARANCE;
  return {
    cx: o.box.center.x,
    cz: o.box.center.z,
    c: Math.cos(o.box.yaw),
    s: Math.sin(o.box.yaw),
    hx,
    hz,
    reach: Math.hypot(hx, hz),
  };
}

function insideSolids(x: number, z: number, solids: readonly Solid[]): boolean {
  for (let i = 0; i < solids.length; i++) {
    const q = solids[i];
    const dx = x - q.cx;
    const dz = z - q.cz;
    if (dx > q.reach || dx < -q.reach || dz > q.reach || dz < -q.reach) continue;
    const lx = q.c * dx - q.s * dz;
    const lz = q.s * dx + q.c * dz;
    if (Math.abs(lx) <= q.hx && Math.abs(lz) <= q.hz) return true;
  }
  return false;
}

interface PlacedSoldier {
  s: SoldierPlacement;
  aim: { head: Vec3; upperTorso: Vec3; lowerTorso: Vec3 };
  bounds: Obstacle;
}

/** One cover candidate: a prop or vehicle target with low boxes a soldier can crouch behind. */
interface CoverCandidate {
  kind: PropKind;
  x: number;
  z: number;
  yaw: number;
}

/** Everything the placement of one attempt shares. Grows as vehicle targets and soldiers are accepted. */
interface Ctx {
  field: TerrainField;
  eye: Vec3;
  config: MissionConfig;
  rng: Rng;
  props: PropPlacement[];
  vehicles: VehicleTargetPlacement[];
  /** Every collider the shooter's sight lines must clear: props, vehicle-target bodies and engine blocks. */
  staticObs: Obstacle[];
  /** What counts as cover: props and vehicle-target bodies (engine blocks excluded). */
  coverObs: Obstacle[];
  solids: Solid[];
  engineCenters: Vec3[];
  soldiers: PlacedSoldier[];
  /** Upright bounds of the soldiers placed so far. */
  bounds: Obstacle[];
  /** Enemy snipers placed so far, their body bounds, and the houses whose roof one of them already holds. */
  snipers: PlacedSniper[];
  sniperBounds: Obstacle[];
  usedRoofs: Set<string>;
  /** An `hvt` mission: the soldiers stand round the compound (`x`, `z`, within `r`), and off the officer's walk (legs x0, z0, x1, z1...). */
  area?: { x: number; z: number; r: number; legs: number[] };
}

interface PlacedSniper {
  s: SniperPlacement;
  aim: { head: Vec3; upperTorso: Vec3 };
  bounds: Obstacle;
}

function shuffle<T>(items: T[], rng: Rng): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/** Accept a vehicle target at (x, z) or return null. */
function evaluateVehicle(
  ctx: Ctx,
  v: VehicleTargetPlacement,
  stage: Stage,
): { body: Obstacle[]; engine: Obstacle; engineCenter: Vec3 } | null {
  const g = ctx.field.height(v.x, v.z);
  const { body, engineCenter } = vehicleTargetColliders(v, g);
  const engine = vehicleEngineObstacle(v, g);
  const fr = propFootprintRadius(v.kind);
  for (const p of ctx.props) {
    if (Math.hypot(p.x - v.x, p.z - v.z) < fr + propFootprintRadius(p.kind) + stage.spacing) return null;
  }
  for (const o of ctx.vehicles) {
    if (Math.hypot(o.x - v.x, o.z - v.z) < fr + propFootprintRadius(o.kind) + stage.spacing) return null;
  }
  // The shooter must see the engine block's centre past everything, this vehicle's own body included.
  if (hitsAny(ctx.eye, engineCenter, ctx.staticObs) || hitsAny(ctx.eye, engineCenter, body)) return null;
  if (!terrainClear(ctx.eye, engineCenter, ctx.field)) return null;
  // The new vehicle must not hide an engine that is already placed.
  for (const e of ctx.engineCenters) {
    if (hitsAny(ctx.eye, e, body) || segmentBox(ctx.eye, e, engine.box) !== null) return null;
  }
  return { body, engine, engineCenter };
}

function placeVehicleTarget(ctx: Ctx, final: boolean): VehicleTargetPlacement | null {
  const { rng, config } = ctx;
  const kind = rng() < 0.5 ? 'truck' : 'jeep';
  const id = `vehicle-${ctx.vehicles.length}`;
  const stages = final ? [...VEHICLE_STAGES, LAST_RESORT] : VEHICLE_STAGES;
  for (const stage of stages) {
    for (let attempt = 0; attempt < stage.attempts; attempt++) {
      const range = config.rangeMin + rng() * (config.rangeMax - config.rangeMin);
      const bearing = (rng() * 2 - 1) * stage.bearing;
      const x = range * Math.sin(bearing);
      const z = -range * Math.cos(bearing);
      const yaw = wrapAngle(facingYaw(x, z) + (rng() * 2 - 1) * VEHICLE_YAW_SPREAD);
      const v: VehicleTargetPlacement = { id, kind, x, z, yaw, range: Math.hypot(x, z) };
      const ok = evaluateVehicle(ctx, v, stage);
      if (!ok) continue;
      ctx.vehicles.push(v);
      ctx.staticObs.push(...ok.body, ok.engine);
      ctx.coverObs.push(...ok.body);
      for (const o of [...ok.body, ok.engine]) ctx.solids.push(toSolid(o));
      ctx.engineCenters.push(ok.engineCenter);
      return v;
    }
  }
  return null;
}

/**
 * A soldier at (x, z), or null if the spot is no good: too close to another soldier, inside a prop,
 * hidden from the shooter (head or upper torso) by terrain, a collider or another soldier, or hiding
 * another soldier or an engine block itself. With `requireCover` the lower torso must also be
 * hidden by a wall or vehicle body (the head and upper torso stay visible either way).
 */
function evaluateSoldier(ctx: Ctx, x: number, z: number, yaw: number, stage: Stage, requireCover: boolean): PlacedSoldier | null {
  for (const o of ctx.soldiers) {
    if (Math.hypot(o.s.x - x, o.s.z - z) < stage.spacing) return null;
  }
  const { field, eye } = ctx;
  if (ctx.area) {
    const legs = ctx.area.legs;
    for (let i = 0; i + 3 < legs.length; i += 4) {
      if (pointSegment2(x, z, legs[i], legs[i + 1], legs[i + 2], legs[i + 3]) < ROUTE_KEEP_OFF_M) return null;
    }
  }
  const s: SoldierPlacement = { id: `soldier-${ctx.soldiers.length}`, x, z, yaw, range: Math.hypot(x, z), behindCover: false };
  const aim = soldierAimPoints(s, field);
  const bounds = soldierUprightBounds(s, field);
  if (insideSolids(x, z, ctx.solids)) return null;
  if (requireCover && !hitsAny(eye, aim.lowerTorso, ctx.coverObs)) return null;
  if (hitsAny(eye, aim.head, ctx.staticObs) || hitsAny(eye, aim.upperTorso, ctx.staticObs)) return null;
  if (hitsAny(eye, aim.head, ctx.bounds) || hitsAny(eye, aim.upperTorso, ctx.bounds)) return null;
  // One target must not hide another: the new bounds must leave every earlier soldier and engine in view.
  for (const o of ctx.soldiers) {
    if (segmentBox(eye, o.aim.head, bounds.box) !== null || segmentBox(eye, o.aim.upperTorso, bounds.box) !== null) return null;
  }
  for (const e of ctx.engineCenters) {
    if (segmentBox(eye, e, bounds.box) !== null) return null;
  }
  if (!terrainClear(eye, aim.head, field) || !terrainClear(eye, aim.upperTorso, field)) return null;
  return { s, aim, bounds };
}

function acceptSoldier(ctx: Ctx, p: PlacedSoldier): void {
  ctx.soldiers.push(p);
  ctx.bounds.push(p.bounds);
}

/** Horizontal distance from (x, z) to the segment (ax, az) -> (bx, bz), m. */
function pointSegment2(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  const u = l2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
  return Math.hypot(ax + dx * u - x, az + dz * u - z);
}

/** A soldier in the open: range and bearing drawn uniformly (in an `hvt` mission: anywhere round the compound, except in the last resort). */
function placeOpen(ctx: Ctx, stage: Stage): PlacedSoldier | null {
  const { rng, config } = ctx;
  const area = stage === LAST_RESORT ? undefined : ctx.area;
  for (let attempt = 0; attempt < stage.attempts; attempt++) {
    let x: number;
    let z: number;
    if (area) {
      // Round the compound, but inside the band (it is a promise of the menu): the band's slice of the area's ring of ranges and bearings.
      const rc = Math.hypot(area.x, area.z);
      const lo = Math.max(config.rangeMin, rc - area.r);
      const hi = Math.min(config.rangeMax, rc + area.r);
      const range = lo <= hi ? lo + rng() * (hi - lo) : config.rangeMin + rng() * (config.rangeMax - config.rangeMin);
      const spread = Math.min(stage.bearing, area.r / Math.max(rc, 1));
      const bearing = Math.max(-stage.bearing, Math.min(stage.bearing, Math.atan2(area.x, -area.z) + (rng() * 2 - 1) * spread));
      x = range * Math.sin(bearing);
      z = -range * Math.cos(bearing);
    } else {
      const range = config.rangeMin + rng() * (config.rangeMax - config.rangeMin);
      const bearing = (rng() * 2 - 1) * stage.bearing;
      x = range * Math.sin(bearing);
      z = -range * Math.cos(bearing);
    }
    const yaw = wrapAngle(facingYaw(x, z) + (rng() * 2 - 1) * SOLDIER_YAW_JITTER);
    const placed = evaluateSoldier(ctx, x, z, yaw, stage, false);
    if (placed) return placed;
  }
  return null;
}

/**
 * A soldier behind a wall or vehicle along the shooter's line. Picks a random point on the cover,
 * walks the sight line out from there in 0.25 m steps through and past the cover, and keeps every
 * step 0.25-6 m behind its edge where the cover predicate holds (lower torso blocked, head and upper
 * torso clear). The shooter's eye is ~12 m above the floor, so at short range only a narrow strip
 * right behind the cover qualifies. Null when no probe finds a spot.
 */
function placeBehindCover(ctx: Ctx, candidates: CoverCandidate[], stage: Stage): PlacedSoldier | null {
  const { rng, config } = ctx;
  let probes = 0;
  for (const cand of shuffle([...candidates], rng)) {
    const fr = propFootprintRadius(cand.kind);
    const lowBoxes = propBoxes(cand.kind).filter(
      (b) => b.center.y + b.halfSize.y >= COVER_TOP_MIN && b.center.y + b.halfSize.y <= COVER_TOP_MAX,
    );
    if (lowBoxes.length === 0) continue;
    const c = Math.cos(cand.yaw);
    const sn = Math.sin(cand.yaw);
    for (let k = 0; k < COVER_PROBES_PER_CANDIDATE; k++) {
      if (++probes > COVER_PROBES) return null;
      const box = lowBoxes[randInt(rng, 0, lowBoxes.length - 1)];
      const lx = box.center.x + (rng() * 2 - 1) * box.halfSize.x * 0.9;
      const lz = box.center.z + (rng() * 2 - 1) * box.halfSize.z * 0.9;
      const px = cand.x + c * lx + sn * lz;
      const pz = cand.z - sn * lx + c * lz;
      const jitter = rng() * 2 - 1; // scaled by SOLDIER_YAW_JITTER once the position is known
      const r0 = Math.hypot(px, pz);
      const ux = px / r0;
      const uz = pz / r0;
      if (Math.abs(Math.atan2(ux, -uz)) > stage.bearing) continue;

      const found: PlacedSoldier[] = [];
      let lastInside: number | null = null;
      const sStart = Math.max(r0 - fr, 1);
      const sEnd = r0 + fr + COVER_BEHIND_MAX + 0.5;
      // Walk the sight line on a 0.25 m grid, plus the band's own edges (a band narrower than a step has no grid point in it).
      const radii: number[] = [];
      for (let r = sStart; r <= sEnd; r += COVER_STEP) radii.push(r);
      for (const edge of [config.rangeMin, config.rangeMax]) if (edge >= sStart && edge <= sEnd) radii.push(edge);
      radii.sort((a, b) => a - b);
      for (const r of radii) {
        const x = ux * r;
        const z = uz * r;
        if (insideSolids(x, z, ctx.solids)) {
          lastInside = r;
          continue;
        }
        if (lastInside === null) continue;
        const behind = r - lastInside;
        if (behind > COVER_BEHIND_MAX) break;
        if (behind < COVER_BEHIND_MIN || r < config.rangeMin || r > config.rangeMax) continue;
        const placed = evaluateSoldier(ctx, x, z, wrapAngle(facingYaw(x, z) + jitter * SOLDIER_YAW_JITTER), stage, true);
        if (placed) found.push(placed);
      }
      if (found.length > 0) return found[randInt(rng, 0, found.length - 1)];
    }
  }
  return null;
}

/** True when the soldier meets the cover predicate against everything now placed. */
function isBehindCover(ctx: Ctx, p: PlacedSoldier): boolean {
  const { eye, field } = ctx;
  if (!hitsAny(eye, p.aim.lowerTorso, ctx.coverObs)) return false;
  for (const target of [p.aim.head, p.aim.upperTorso]) {
    if (hitsAny(eye, target, ctx.staticObs)) return false;
    for (const b of ctx.bounds) {
      if (b !== p.bounds && segmentBox(eye, target, b.box) !== null) return false;
    }
    if (!terrainClear(eye, target, field)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Enemy snipers

/** Snipers lie this far outside the range band at most, m (like the props' sites). */
const SNIPER_BAND_MARGIN = 150;
/** Snipers never lie nearer than this, m. */
const MIN_SNIPER_RANGE = 100;
/** Ridge snipers lie in the outer strip of the sector: bearings from this to RIDGE_BEARING_MAX. */
const RIDGE_BEARING_MIN = 7 * DEG;
const RIDGE_BEARING_MAX = 11.5 * DEG;
/** Random spots drawn per ridge pass; the highest ground that is valid wins. */
const RIDGE_CANDIDATES = 40;
/** Snipers turn up to this far either side of facing the shooter, rad. */
const SNIPER_YAW_JITTER = 8 * DEG;
/** Random spots tried on each roof. */
const ROOF_PROBES = 8;
/** Minimum distance, m, between a roof sniper and any other target (a roof is high above them). */
const ROOF_SPACING = 5;
/** Ground passes, strictest first: spacing between targets, bearing limit of the open-ground draw, attempts. */
const SNIPER_STAGES: readonly Stage[] = [
  { spacing: 15, bearing: STRICT_BEARING, attempts: 40 },
  { spacing: 6, bearing: STRICT_BEARING, attempts: 40 },
  { spacing: 2, bearing: MAX_BEARING, attempts: 60 },
  { spacing: 0, bearing: MAX_BEARING, attempts: 300 },
];

/** True when two boxes (rotated about Y only) share any volume. */
function boxesOverlap(a: Box, b: Box): boolean {
  if (Math.abs(a.center.y - b.center.y) >= a.halfSize.y + b.halfSize.y) return false;
  const dx = b.center.x - a.center.x;
  const dz = b.center.z - a.center.z;
  // Local +X of a box is world (cos, -sin), local +Z is (sin, cos): four separating axes in the plane.
  for (const box of [a, b]) {
    const c = Math.cos(box.yaw);
    const s = Math.sin(box.yaw);
    for (const [ux, uz] of [[c, -s], [s, c]] as const) {
      const radius = (q: Box): number => {
        const qc = Math.cos(q.yaw);
        const qs = Math.sin(q.yaw);
        return Math.abs(ux * qc - uz * qs) * q.halfSize.x + Math.abs(ux * qs + uz * qc) * q.halfSize.z;
      };
      if (Math.abs(ux * dx + uz * dz) >= radius(a) + radius(b)) return false;
    }
  }
  return true;
}

/** True when the segment a -> b is stopped by a collider, a soldier's body or an earlier sniper's body. */
function sniperBlocked(ctx: Ctx, a: Vec3, b: Vec3): boolean {
  return hitsAny(a, b, ctx.staticObs) || hitsAny(a, b, ctx.bounds) || hitsAny(a, b, ctx.sniperBounds);
}

/**
 * A sniper lying at (x, z) on a surface at height y, or null if the spot is no good: outside the engagement
 * sector or the allowed range window, too close to another target, his body touching a collider or another
 * body, no clear line of sight both ways between the shooter's eye and his head (and eye -> upper torso)
 * past the terrain, every collider and every soldier, or his body hiding a soldier, an engine or another
 * sniper (head or upper torso) from the shooter.
 */
function evaluateSniper(
  ctx: Ctx,
  window: readonly [number, number],
  x: number,
  y: number,
  z: number,
  yaw: number,
  site: SniperSite,
  spacing: number,
): PlacedSniper | null {
  const range = Math.hypot(x, z);
  if (range < window[0] || range > window[1] || !propFitsSector(x, z, SNIPER_REACH)) return null;
  for (const o of ctx.soldiers) if (Math.hypot(o.s.x - x, o.s.z - z) < spacing) return null;
  for (const o of ctx.snipers) if (Math.hypot(o.s.x - x, o.s.z - z) < Math.max(spacing, ROOF_SPACING)) return null;
  for (const o of ctx.vehicles) if (Math.hypot(o.x - x, o.z - z) < spacing) return null;

  const s: SniperPlacement = { id: `sniper-${ctx.snipers.length}`, x, y, z, yaw, site, range };
  const bounds = sniperBoundsObstacle(s, s.id);
  for (const o of ctx.staticObs) if (boxesOverlap(bounds.box, o.box)) return null;
  for (const o of ctx.bounds) if (boxesOverlap(bounds.box, o.box)) return null;
  for (const o of ctx.sniperBounds) if (boxesOverlap(bounds.box, o.box)) return null;

  const { eye, field } = ctx;
  const aim = sniperAimPoints(s);
  if (sniperBlocked(ctx, eye, aim.head) || sniperBlocked(ctx, eye, aim.upperTorso)) return null;
  // He must not hide anything the shooter has to see.
  for (const o of ctx.soldiers) {
    if (segmentBox(eye, o.aim.head, bounds.box) !== null || segmentBox(eye, o.aim.upperTorso, bounds.box) !== null) return null;
  }
  for (const e of ctx.engineCenters) if (segmentBox(eye, e, bounds.box) !== null) return null;
  for (const o of ctx.snipers) {
    if (segmentBox(eye, o.aim.head, bounds.box) !== null || segmentBox(eye, o.aim.upperTorso, bounds.box) !== null) return null;
  }
  // Terrain, the dear test last: both ways for the head (the skipped last 2 m differ), one way for the chest.
  if (!terrainClear(eye, aim.head, field) || !terrainClear(aim.head, eye, field) || !terrainClear(eye, aim.upperTorso, field)) return null;
  return { s, aim, bounds };
}

/** On a house roof: random spots over the roofs of the houses in reach (each roof holds one sniper). */
function placeOnRoof(ctx: Ctx, window: readonly [number, number]): PlacedSniper | null {
  const spot = rooftopSpot('house', SNIPER_REACH);
  if (!spot) return null;
  const houses = shuffle(
    ctx.props.filter((p) => p.kind === 'house' && !ctx.usedRoofs.has(p.id)),
    ctx.rng,
  );
  for (const house of houses) {
    const c = Math.cos(house.yaw);
    const sn = Math.sin(house.yaw);
    const y = ctx.field.height(house.x, house.z) + spot.top;
    for (let probe = 0; probe < ROOF_PROBES; probe++) {
      const lx = spot.cx + (ctx.rng() * 2 - 1) * spot.halfX;
      const lz = spot.cz + (ctx.rng() * 2 - 1) * spot.halfZ;
      const x = house.x + c * lx + sn * lz;
      const z = house.z - sn * lx + c * lz;
      const yaw = wrapAngle(facingYaw(x, z) + (ctx.rng() * 2 - 1) * SNIPER_YAW_JITTER);
      const placed = evaluateSniper(ctx, window, x, y, z, yaw, 'roof', ROOF_SPACING);
      if (placed) {
        ctx.usedRoofs.add(house.id);
        return placed;
      }
    }
  }
  return null;
}

/** Random spots in the outer strip of the sector, the highest ground first. */
function ridgeSpots(ctx: Ctx, window: readonly [number, number]): Array<{ x: number; z: number; ground: number }> {
  const { field, rng } = ctx;
  const spots: Array<{ x: number; z: number; ground: number }> = [];
  for (let i = 0; i < RIDGE_CANDIDATES; i++) {
    const range = window[0] + rng() * (window[1] - window[0]);
    const bearing = (rng() < 0.5 ? -1 : 1) * (RIDGE_BEARING_MIN + rng() * (RIDGE_BEARING_MAX - RIDGE_BEARING_MIN));
    const x = range * Math.sin(bearing);
    const z = -range * Math.cos(bearing);
    spots.push({ x, z, ground: field.height(x, z) });
  }
  return spots.sort((a, b) => b.ground - a.ground);
}

/** On high ground near the sector's edge: draws spots in the outer strip and tries the highest ground first. */
function placeOnRidge(ctx: Ctx, window: readonly [number, number], stage: Stage): PlacedSniper | null {
  const { rng } = ctx;
  for (const spot of ridgeSpots(ctx, window)) {
    const yaw = wrapAngle(facingYaw(spot.x, spot.z) + (rng() * 2 - 1) * SNIPER_YAW_JITTER);
    const placed = evaluateSniper(ctx, window, spot.x, spot.ground, spot.z, yaw, 'ridge', stage.spacing);
    if (placed) return placed;
  }
  return null;
}

/** In the open: range and bearing drawn uniformly. */
function placeInOpen(ctx: Ctx, window: readonly [number, number], stage: Stage): PlacedSniper | null {
  const { field, rng } = ctx;
  for (let attempt = 0; attempt < stage.attempts; attempt++) {
    const range = window[0] + rng() * (window[1] - window[0]);
    const bearing = (rng() * 2 - 1) * stage.bearing;
    const x = range * Math.sin(bearing);
    const z = -range * Math.cos(bearing);
    const yaw = wrapAngle(facingYaw(x, z) + (rng() * 2 - 1) * SNIPER_YAW_JITTER);
    const placed = evaluateSniper(ctx, window, x, field.height(x, z), z, yaw, 'open', stage.spacing);
    if (placed) return placed;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Choosing a hide

/** A valid place for the next sniper and what it is worth (see hide.ts); `house` is the id of the house whose roof it is. */
interface Hide {
  placed: PlacedSniper;
  score: number;
  house?: string;
}

/** At most this many valid ridge spots, and this many valid open-ground spots, are scored per pass (a valid spot is the dear one to find: three long terrain traces). */
const HIDES_PER_GROUND_KIND = 6;

/** How well `p` hides him: height over the eye, backdrop, hard cover near, apart from the soldiers, off the centre line, the site (hide.ts). */
function hideScore(ctx: Ctx, p: PlacedSniper): number {
  const { s, aim } = p;
  let nearestSoldier = Infinity;
  for (const o of ctx.soldiers) nearestSoldier = Math.min(nearestSoldier, Math.hypot(o.s.x - s.x, o.s.z - s.z));
  return scoreHide({
    headAboveEyeM: aim.head.y - ctx.eye.y,
    backdrop: backdropScore(ctx.field, ctx.eye, aim.head),
    coverGapM: Math.min(nearestCoverGap(s.x, s.z, ctx.props), nearestCoverGap(s.x, s.z, ctx.vehicles)),
    nearestSoldierM: nearestSoldier,
    bearingRad: Math.atan2(s.x, -s.z),
    site: s.site,
  });
}

/** The best valid probe of each roof in reach (every probe is looked at; a house holds one sniper, so one hide per house). */
function roofHides(ctx: Ctx, window: readonly [number, number]): Hide[] {
  const spot = rooftopSpot('house', SNIPER_REACH);
  if (!spot) return [];
  const out: Hide[] = [];
  for (const house of ctx.props) {
    if (house.kind !== 'house' || ctx.usedRoofs.has(house.id)) continue;
    const c = Math.cos(house.yaw);
    const sn = Math.sin(house.yaw);
    const y = ctx.field.height(house.x, house.z) + spot.top;
    let best: Hide | null = null;
    for (let probe = 0; probe < ROOF_PROBES; probe++) {
      const lx = spot.cx + (ctx.rng() * 2 - 1) * spot.halfX;
      const lz = spot.cz + (ctx.rng() * 2 - 1) * spot.halfZ;
      const x = house.x + c * lx + sn * lz;
      const z = house.z - sn * lx + c * lz;
      const yaw = wrapAngle(facingYaw(x, z) + (ctx.rng() * 2 - 1) * SNIPER_YAW_JITTER);
      const placed = evaluateSniper(ctx, window, x, y, z, yaw, 'roof', ROOF_SPACING);
      if (!placed) continue;
      const score = hideScore(ctx, placed);
      if (!best || score > best.score) best = { placed, score, house: house.id };
    }
    if (best) out.push(best);
  }
  return out;
}

/** The valid ridge-strip spots of one ground pass, the highest ground first (at most `HIDES_PER_GROUND_KIND`), and the same number of valid open-ground draws. */
function groundHides(ctx: Ctx, window: readonly [number, number], stage: Stage): Hide[] {
  const { field, rng } = ctx;
  const out: Hide[] = [];
  let valid = 0;
  for (const spot of ridgeSpots(ctx, window)) {
    if (valid >= HIDES_PER_GROUND_KIND) break;
    const yaw = wrapAngle(facingYaw(spot.x, spot.z) + (rng() * 2 - 1) * SNIPER_YAW_JITTER);
    const placed = evaluateSniper(ctx, window, spot.x, spot.ground, spot.z, yaw, 'ridge', stage.spacing);
    if (!placed) continue;
    valid++;
    out.push({ placed, score: hideScore(ctx, placed) });
  }
  valid = 0;
  for (let attempt = 0; attempt < stage.attempts && valid < HIDES_PER_GROUND_KIND; attempt++) {
    const range = window[0] + rng() * (window[1] - window[0]);
    const bearing = (rng() * 2 - 1) * stage.bearing;
    const x = range * Math.sin(bearing);
    const z = -range * Math.cos(bearing);
    const yaw = wrapAngle(facingYaw(x, z) + (rng() * 2 - 1) * SNIPER_YAW_JITTER);
    const placed = evaluateSniper(ctx, window, x, field.height(x, z), z, yaw, 'open', stage.spacing);
    if (!placed) continue;
    valid++;
    out.push({ placed, score: hideScore(ctx, placed) });
  }
  return out;
}

/**
 * The next enemy sniper. Every place that passes `evaluateSniper` (its hard rules: a clear line of sight both ways, nothing
 * overlapping, the sector and range window) is a candidate: the best valid probe of each roof, the valid ridge-strip spots and the
 * valid open-ground draws. They are scored for how well they hide him (hide.ts) and one of the best few (the best of each kind of site
 * among them) is picked with the mission's rng, so a roof is a good site but not an automatic one, and another seed gives another hide. The spacing from the other targets
 * relaxes pass by pass (the line-of-sight rules never do), so the caller never drops props for a sniper it could have placed. If no
 * pass finds a candidate, the plain chain runs: a roof if a house is in reach, else high ground at the sector's edge, else the open.
 */
function placeSniper(ctx: Ctx): PlacedSniper | null {
  const { config } = ctx;
  // A short-range rifle (the 12.7x55 subsonic) caps the snipers at its reach too: past it the hold leaves the reticle's ladder.
  const reach = RIFLES[config.rifle].maxRangeM;
  const window = [
    Math.max(MIN_SNIPER_RANGE, Math.min(config.rangeMin - SNIPER_BAND_MARGIN, reach - SNIPER_BAND_MARGIN)),
    Math.min(SECTOR_MAX_RANGE, config.rangeMax + SNIPER_BAND_MARGIN, reach < MISSION_LIMITS.rangeMax ? reach : Infinity),
  ] as const;
  const roofs = roofHides(ctx, window);
  for (const stage of SNIPER_STAGES) {
    const hides = [...roofs, ...groundHides(ctx, window, stage)];
    const pick = pickHide(hides.map((h) => ({ score: h.score, site: h.placed.s.site })), ctx.rng);
    if (pick < 0) continue;
    const chosen = hides[pick];
    if (chosen.house !== undefined) ctx.usedRoofs.add(chosen.house);
    return chosen.placed;
  }
  return placeSniperPlain(ctx, window);
}

/** The plain chain, the fallback of `placeSniper`: on a roof if a house is in reach, else on high ground at the sector's edge, else in the open. */
function placeSniperPlain(ctx: Ctx, window: readonly [number, number]): PlacedSniper | null {
  const roof = placeOnRoof(ctx, window);
  if (roof) return roof;
  for (const stage of SNIPER_STAGES) {
    const placed = placeOnRidge(ctx, window, stage) ?? placeInOpen(ctx, window, stage);
    if (placed) return placed;
  }
  return null;
}

function describeBand(config: MissionConfig): string {
  return `${config.theme}, band ${config.rangeMin}-${config.rangeMax} m, seed ${config.seed}`;
}

/** One complete placement attempt with the given props; null when a target cannot be placed (the caller drops props). */
function solve(config: MissionConfig, field: TerrainField, rng: Rng, props: PropPlacement[], final: boolean, compound?: CompoundDraft): MissionLayout | null {
  const placedProps = props.map((p, i) => ({ ...p, id: `prop-${i}` }));
  const staticObs: Obstacle[] = [];
  const coverObs: Obstacle[] = [];
  const candidates: CoverCandidate[] = [];
  for (const p of placedProps) {
    const colliders = propColliders(p, field.height(p.x, p.z));
    staticObs.push(...colliders);
    // Houses and sheds are tall: they hide the whole soldier, so they are not cover (they only block sight).
    if (p.kind === 'wall' || p.kind === 'truck' || p.kind === 'jeep') {
      coverObs.push(...colliders);
      candidates.push({ kind: p.kind, x: p.x, z: p.z, yaw: p.yaw });
    }
  }
  const ctx: Ctx = {
    field,
    eye: field.shooter,
    config,
    rng,
    props: placedProps,
    vehicles: [],
    staticObs,
    coverObs,
    solids: staticObs.map(toSolid),
    engineCenters: [],
    soldiers: [],
    bounds: [],
    snipers: [],
    sniperBounds: [],
    usedRoofs: new Set(),
    area: compound && { x: compound.x, z: compound.z, r: COMPOUND_AREA_M, legs: routeLegs(compound) },
  };

  for (let i = 0; i < config.vehicleTargets; i++) {
    const v = placeVehicleTarget(ctx, final);
    if (!v) {
      if (final) throw new Error(`generateLayout: no valid spot for vehicle target ${i + 1} of ${config.vehicleTargets} (${describeBand(config)})`);
      return null;
    }
    candidates.push({ kind: v.kind, x: v.x, z: v.z, yaw: v.yaw });
  }

  // In an `hvt` mission only the cover round the compound is his soldiers' (the rest of the scenery is somebody else's).
  if (compound) {
    const near = candidates.filter((c) => Math.hypot(c.x - compound.x, c.z - compound.z) <= COMPOUND_AREA_M + 15);
    candidates.length = 0;
    candidates.push(...near);
  }
  // About 40 % of the soldiers are tried behind cover, placed first while the cover spots are free.
  const wantCover = candidates.length === 0 ? 0 : COVER_FRACTION * config.soldiers;
  const coverCount = Math.floor(wantCover) + (rng() < wantCover - Math.floor(wantCover) ? 1 : 0);
  const soldierStages = final ? [...SOLDIER_STAGES, LAST_RESORT] : SOLDIER_STAGES;
  for (let i = 0; i < config.soldiers; i++) {
    let placed = i < coverCount ? placeBehindCover(ctx, candidates, SOLDIER_STAGES[0]) : null;
    for (const stage of soldierStages) {
      if (placed) break;
      placed = placeOpen(ctx, stage);
    }
    if (!placed) {
      if (final) throw new Error(`generateLayout: no valid spot for soldier ${i + 1} of ${config.soldiers} (${describeBand(config)})`);
      return null;
    }
    acceptSoldier(ctx, placed);
  }

  // Enemy snipers last: they never move a soldier, a vehicle or a prop.
  for (let i = 0; i < config.enemySnipers; i++) {
    const sniper = placeSniper(ctx);
    if (!sniper) {
      if (final) throw new Error(`generateLayout: no valid spot for enemy sniper ${i + 1} of ${config.enemySnipers} (${describeBand(config)})`);
      return null;
    }
    ctx.snipers.push(sniper);
    ctx.sniperBounds.push(sniper.bounds);
  }

  const soldiers = ctx.soldiers.map((p) => ({ ...p.s, behindCover: isBehindCover(ctx, p) }));
  const layout: MissionLayout = { soldiers, vehicleTargets: ctx.vehicles, snipers: ctx.snipers.map((p) => p.s), props: placedProps };
  // The compound's house and jeep are the first two props (`generateLayout` puts them there and never drops them).
  if (compound) layout.hvt = finishHvt(compound, { houseId: placedProps[0].id, vehicleId: placedProps[1].id }, soldiers, field, staticObs);
  return layout;
}

/**
 * The layout of one mission. Deterministic: the same config (seed included) and field give the same
 * layout. Every target is always placed with its line-of-sight and not-inside-a-box checks intact;
 * if the scenery blocks too much, props are dropped (tall ones first) and the placement retried,
 * never the targets. If even the prop-free final pass finds no valid spot (it never has, in a fuzz of
 * 8000 soldiers) this throws a descriptive Error instead of returning an invalid layout.
 */
export function generateLayout(config: MissionConfig, field: TerrainField): MissionLayout {
  const rng = createRng((Math.imul(config.seed, 0x9e3779b1) ^ 0x4c41594f) >>> 0);
  let props = planProps(config, rng);
  // An `hvt` mission: the officer's compound, from its own rng (a `clear` mission's layout stays exactly as it was). Its house and jeep go
  // first and are never dropped; the rest of the scenery keeps out of it.
  let compound: CompoundDraft | undefined;
  if (config.objective === 'hvt') {
    compound = planCompound(config, field, createRng((Math.imul(config.seed, 0x85ebca6b) ^ 0x48565421) >>> 0));
    const c = compound;
    props = props.filter((p) => Math.hypot(p.x - c.x, p.z - c.z) > COMPOUND_CLEAR_M + propFootprintRadius(p.kind));
  }
  const own = compound ? compound.props : [];
  const keeps = [props.length, Math.floor((props.length * 2) / 3), Math.floor(props.length / 3), 0];
  const tried = new Set<number>();
  for (const keep of keeps) {
    if (tried.has(keep)) continue;
    tried.add(keep);
    const layout = solve(config, field, rng, [...own, ...props.slice(0, keep)], keep === 0, compound);
    if (layout) return layout;
  }
  // Unreachable: the last attempt (no props) either returns a layout or throws its own, specific error.
  throw new Error('generateLayout: no layout found');
}
