import type { Vec3 } from '../ballistics/types';
import { segmentBox } from '../game/hit';
import type { Obstacle } from '../game/hit';
import type { EscapePoint, RoutePoint } from '../game/hvt';
import { SECTOR_HALF_ANGLE_RAD, SECTOR_MAX_RANGE } from '../scene/terrainField';
import type { TerrainField } from '../scene/terrainField';
import type { MissionConfig } from './config';
import { propColliders, propFootprintRadius } from './props';
import type { PropPlacement } from './props';
import { randInt } from './random';
import type { Rng } from './random';

// Where the high-value target lives (pure, no three.js): the compound of an `hvt` mission. Seeded, inside the mission's range band: a house
// (its door is one way out) and a parked jeep (the other: it drives off with him), set some 20 m apart across the line of fire, whatever the
// building and vehicle densities say. His walk goes from the door, out in front of the compound, past one of his soldiers (he stops to talk),
// to the jeep and round behind; it is chosen, among a dozen seeded candidates, so the shooter sees most of it but not all (the house hides
// a stretch). mission/layout.ts calls it before the soldiers are placed (they are then placed round the compound) and finishes the route
// once they are.

/** Head height of the walking officer, m: what the shooter has to see. */
const HEAD_M = 1.62;
/** A crouched man's head, m: an escape point is covered when that is hidden from the shooter. */
const CROUCH_HEAD_M = 1.0;
/** The house and the jeep stand this far either side of the compound's centre, across the line of fire, m. */
const SPREAD_M: readonly [number, number] = [8.5, 12];
/** The route's open stretch in front of the compound (toward the shooter), and the one behind it, m from the centre. */
const FRONT_M: readonly [number, number] = [5, 9];
const BACK_M: readonly [number, number] = [8, 12];
/** Points along the walk are tested for sight this far apart, m. */
const SAMPLE_M = 2;
/** The walk's share in view the candidates aim at, and how many are tried. */
const VISIBLE_MIN = 0.55;
const VISIBLE_MAX = 0.92;
const CANDIDATES = 12;
/** His soldiers stand round the compound within this, m, and keep this far off his walk. */
export const COMPOUND_AREA_M = 40;
export const ROUTE_KEEP_OFF_M = 2.5;
/** Other props keep this far from the compound's centre (plus their own footprint), m. */
export const COMPOUND_CLEAR_M = 26;
/** A soldier within this of the centre may be the one he stops to talk to, m. */
const TALK_REACH_M = 45;

/** The compound and the officer's part of the layout. */
export interface HvtPlacement {
  /** The compound's centre, m. */
  x: number;
  z: number;
  /** Ids of the house and of the jeep in `layout.props` (the jeep is drawn movable: it drives off). */
  houseId: string;
  vehicleId: string;
  /** His walk, a closed loop: he starts at the first point (the door). */
  route: RoutePoint[];
  escapes: EscapePoint[];
  /** The way the jeep drives out of the area (unit, x and z). */
  road: { x: number; z: number };
  /** Bodyguards, 2-4. */
  guards: number;
  /** Share of the walk (straight legs, sampled every 2 m) the shooter sees his head on, 0..1. */
  visibleShare: number;
}

/** The compound before the soldiers are placed: its two props, and the route without its talk stop. */
export interface CompoundDraft {
  x: number;
  z: number;
  props: PropPlacement[];
  door: { x: number; z: number };
  carDoor: { x: number; z: number };
  front: { x: number; z: number };
  back: { x: number; z: number };
  road: { x: number; z: number };
  guards: number;
  waits: { door: number; car: number; front: number; back: number };
}

const between = (rng: Rng, r: readonly [number, number]): number => r[0] + rng() * (r[1] - r[0]);

/** A point of a prop's local frame (x, z) in the world (the props' convention: local +X is (cos yaw, -sin yaw), +Z is (sin yaw, cos yaw)). */
function local(p: PropPlacement, lx: number, lz: number): { x: number; z: number } {
  const c = Math.cos(p.yaw);
  const s = Math.sin(p.yaw);
  return { x: p.x + c * lx + s * lz, z: p.z - s * lx + c * lz };
}

/** True when a footprint of radius `fr` at (x, z) lies inside the engagement sector, 100 m out or more. */
function fitsSector(x: number, z: number, fr: number): boolean {
  if (z >= 0) return false;
  const r = Math.hypot(x, z);
  if (r < 100 + fr || r > SECTOR_MAX_RANGE - fr) return false;
  return r * Math.sin(SECTOR_HALF_ANGLE_RAD - Math.atan2(Math.abs(x), -z)) >= fr + 1;
}

/** The loop of the walk as (x, z) corners: door, front, car, back. */
function corners(d: CompoundDraft): Array<{ x: number; z: number }> {
  return [d.door, d.front, d.carDoor, d.back];
}

/** The straight from `a` to `b` is clear of the terrain (sampled every 2 m, the last 2 m skipped) and of every obstacle. */
function seen(eye: Vec3, to: Vec3, field: TerrainField, obstacles: readonly Obstacle[]): boolean {
  for (const o of obstacles) if (segmentBox(eye, to, o.box) !== null) return false;
  const dx = to.x - eye.x;
  const dz = to.z - eye.z;
  const h = Math.hypot(dx, dz);
  for (let s = 2; s < h - 2; s += 2) {
    const u = s / h;
    if (field.height(eye.x + dx * u, eye.z + dz * u) >= eye.y + (to.y - eye.y) * u - 0.1) return false;
  }
  return true;
}

/** Share of the closed walk through `points` on which the shooter sees a walking man's head, 0..1. */
export function visibleShare(points: ReadonlyArray<{ x: number; z: number }>, field: TerrainField, obstacles: readonly Obstacle[]): number {
  let total = 0;
  let inView = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.round(len / SAMPLE_M));
    for (let k = 0; k < n; k++) {
      const x = a.x + ((b.x - a.x) * k) / n;
      const z = a.z + ((b.z - a.z) * k) / n;
      total++;
      if (seen(field.shooter, { x, y: field.height(x, z) + HEAD_M, z }, field, obstacles)) inView++;
    }
  }
  return total > 0 ? inView / total : 0;
}

/** One candidate compound at range `range`, bearing `bear`, the house on side `side` (+1: right of the jeep from the shooter), its door facing `doorTo`. */
function candidate(rng: Rng, range: number, bear: number, side: 1 | -1, doorTo: 'jeep' | 'away' | 'shooter'): CompoundDraft {
  const ux = Math.sin(bear); // downrange
  const uz = -Math.cos(bear);
  const lx = Math.cos(bear); // to the shooter's right
  const lz = Math.sin(bear);
  const x = range * ux;
  const z = range * uz;
  const sh = between(rng, SPREAD_M);
  const sj = between(rng, SPREAD_M);
  const hx = x + lx * side * sh;
  const hz = z + lz * side * sh;
  const jx = x - lx * side * sj;
  const jz = z - lz * side * sj;
  // The door faces the jeep (the walk is across the open, in view), away from the shooter (he comes out unseen) or toward him.
  const jitter = (rng() * 2 - 1) * 0.25;
  const dir = doorTo === 'jeep' ? { x: -lx * side, z: -lz * side } : doorTo === 'away' ? { x: ux, z: uz } : { x: -ux, z: -uz };
  const house: PropPlacement = { id: '', kind: 'house', x: hx, z: hz, yaw: Math.atan2(dir.x, dir.z) + jitter };
  // The jeep points out of the area: away from the shooter and out on its own side.
  const rx = ux * 0.6 - lx * side * 0.8;
  const rz = uz * 0.6 - lz * side * 0.8;
  const rl = Math.hypot(rx, rz);
  const road = { x: rx / rl, z: rz / rl };
  const jeep: PropPlacement = { id: '', kind: 'jeep', x: jx, z: jz, yaw: Math.atan2(road.x, road.z) };
  const door = local(house, 0, 3.05 + 0.9);
  // The side of the jeep away from the shooter: the doors he gets in by, in its cover.
  const left = local(jeep, 1.75, -0.4);
  const right = local(jeep, -1.75, -0.4);
  const carDoor = Math.hypot(left.x, left.z) > Math.hypot(right.x, right.z) ? left : right;
  const f = between(rng, FRONT_M);
  const bk = between(rng, BACK_M);
  const lateral = (rng() * 2 - 1) * 3;
  return {
    x,
    z,
    props: [house, jeep],
    door,
    carDoor,
    front: { x: x - ux * f + lx * lateral, z: z - uz * f + lz * lateral },
    back: { x: x + ux * bk - lx * lateral, z: z + uz * bk - lz * lateral },
    road,
    guards: randInt(rng, 2, 4),
    waits: { door: between(rng, [3, 7]), car: between(rng, [3, 6]), front: rng() < 0.5 ? between(rng, [2.5, 5]) : 0, back: rng() < 0.4 ? between(rng, [2, 4]) : 0 },
  };
}

/**
 * The compound of an `hvt` mission: a dozen seeded candidates inside the range band (bearing within 6 degrees of straight downrange), the first
 * whose walk the shooter sees 55-92 % of, else the one nearest 75 %. Its own rng (`rng`), so a `clear` mission's layout is not touched.
 */
export function planCompound(config: MissionConfig, field: TerrainField, rng: Rng): CompoundDraft {
  const lo = Math.max(config.rangeMin, 125);
  const hi = Math.max(lo, Math.min(config.rangeMax, SECTOR_MAX_RANGE - 120));
  const doors = ['jeep', 'away', 'jeep', 'shooter'] as const;
  let best: CompoundDraft | null = null;
  let bestScore = Infinity;
  // Up to a dozen that fit the sector (three dozen draws at most), stopping at the first whose share is in the window.
  let tried = 0;
  for (let i = 0; i < CANDIDATES * 3 && tried < CANDIDATES && bestScore > 0; i++) {
    const range = lo + rng() * (hi - lo);
    const bear = (rng() * 2 - 1) * ((6 * Math.PI) / 180);
    const draft = candidate(rng, range, bear, rng() < 0.5 ? 1 : -1, doors[i % doors.length]);
    if (!draft.props.every((p) => fitsSector(p.x, p.z, propFootprintRadius(p.kind)))) continue;
    tried++;
    const obstacles = draft.props.flatMap((p) => propColliders(p, field.height(p.x, p.z)));
    const share = visibleShare(corners(draft), field, obstacles);
    const score = share >= VISIBLE_MIN && share <= VISIBLE_MAX ? 0 : Math.abs(share - 0.75);
    if (score < bestScore) {
      bestScore = score;
      best = draft;
    }
  }
  if (!best) throw new Error(`planCompound: no room for the HVT's compound (band ${config.rangeMin}-${config.rangeMax} m, seed ${config.seed})`);
  return best;
}

/** The walk's legs, as (x0, z0, x1, z1) per leg: what the soldiers keep off. */
export function routeLegs(d: CompoundDraft): number[] {
  const c = corners(d);
  const out: number[] = [];
  for (let i = 0; i < c.length; i++) {
    const a = c[i];
    const b = c[(i + 1) % c.length];
    out.push(a.x, a.z, b.x, b.z);
  }
  return out;
}

/**
 * The HVT's placement once the soldiers stand: the talk stop (in front of the nearest soldier of the compound, facing him), the escape points
 * (covered when a crouched man there is hidden from the shooter by the props), and the share of the walk in view.
 */
export function finishHvt(
  d: CompoundDraft,
  ids: { houseId: string; vehicleId: string },
  soldiers: ReadonlyArray<{ x: number; z: number }>,
  field: TerrainField,
  obstacles: readonly Obstacle[],
): HvtPlacement {
  const route: RoutePoint[] = [
    { x: d.door.x, z: d.door.z, waitS: d.waits.door },
    { x: d.front.x, z: d.front.z, waitS: d.waits.front },
  ];
  let talkTo: { x: number; z: number } | null = null;
  let nearest = TALK_REACH_M;
  for (const s of soldiers) {
    const r = Math.hypot(s.x - d.x, s.z - d.z);
    if (r < nearest) {
      nearest = r;
      talkTo = s;
    }
  }
  if (talkTo) {
    const dx = d.x - talkTo.x;
    const dz = d.z - talkTo.z;
    const l = Math.hypot(dx, dz) || 1;
    route.push({ x: talkTo.x + (dx / l) * 1.5, z: talkTo.z + (dz / l) * 1.5, waitS: 5, face: { x: talkTo.x, z: talkTo.z } });
  }
  route.push({ x: d.carDoor.x, z: d.carDoor.z, waitS: d.waits.car }, { x: d.back.x, z: d.back.z, waitS: d.waits.back });
  const covered = (p: { x: number; z: number }): boolean => !seen(field.shooter, { x: p.x, y: field.height(p.x, p.z) + CROUCH_HEAD_M, z: p.z }, field, obstacles);
  const escapes: EscapePoint[] = [
    { kind: 'vehicle', x: d.carDoor.x, z: d.carDoor.z, covered: covered(d.carDoor) },
    { kind: 'door', x: d.door.x, z: d.door.z, covered: covered(d.door) },
  ];
  return {
    x: d.x,
    z: d.z,
    houseId: ids.houseId,
    vehicleId: ids.vehicleId,
    route,
    escapes,
    road: d.road,
    guards: d.guards,
    visibleShare: visibleShare(route, field, obstacles),
  };
}

/** Points along the closed walk, about every `stepM` metres: what the vegetation keeps clear of, like a target's lane. */
export function routeSamples(route: ReadonlyArray<{ x: number; z: number }>, stepM = 6): Array<{ x: number; z: number }> {
  const out: Array<{ x: number; z: number }> = [];
  for (let i = 0; i < route.length; i++) {
    const a = route[i];
    const b = route[(i + 1) % route.length];
    const n = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.z - a.z) / stepM));
    for (let k = 0; k < n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
  }
  return out;
}
