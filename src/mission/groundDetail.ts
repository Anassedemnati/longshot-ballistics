import type { TerrainField } from '../scene/terrainField';
import type { MissionLayout } from './layout';
import { NEST_AREA_RADIUS } from './nestPlan';
import { propFootprintRadius } from './props';
import { createRng } from './random';
import type { Rng } from './random';
import type { ThemeId } from './themes';

// Where the small ground detail goes (pure, no three.js; the instanced meshes are in scene/detail.ts):
// pebbles and stones in every theme, grass tufts in the valley. Seeded and deterministic. Detail is
// visual only: it has no colliders, so it keeps off everything the player must see or shoot past:
//   - the lane: a corridor around the line of sight from the shooter to every target;
//   - the prone shooter's own spot, the whole firing nest's area (the eye is only 0.4 m above the ground);
//   - 2 m around every target, and every prop's footprint.
//   - ground that is too steep (the valley walls, the mountain spur, the flanks of an outcrop): a stone or a tuft stands
//     flat on its instance, so on a cliff face it would float edge-on;
//   - anything that would stick up to the shooter's eye level near him (the top of the rise he lies on).
// It stays inside the part of the map the fine terrain mesh covers, where mesh and height() agree.

/** At most this many pebbles per mission. */
export const MAX_PEBBLES = 1200;
/** At most this many grass tufts per mission (valley theme only). */
export const MAX_TUFTS = 1500;
/** No detail within this distance of a target, m (the brief asks for 2 m; the margin covers a stone's own size). */
export const TARGET_CLEARANCE = 2.5;
/** Half-width of the clear corridor along each shooter -> target line of sight, m. */
export const LANE_HALF_WIDTH = 2.5;
/** No detail within this distance of the shooter, m: the firing nest's area (nestPlan.ts), which the sandbags and rocks own. */
export const SHOOTER_CLEARANCE = NEST_AREA_RADIUS;
/** Extra clearance around a prop's footprint circle, m. */
const PROP_MARGIN = 0.6;
/** Detail stays off ground steeper than this (rise over run, about 27 degrees): wall faces, the mountain spur, outcrop flanks. */
export const MAX_DETAIL_SLOPE = 0.5;
/** Within this distance of the shooter (m) no detail reaches up to his eye. */
export const EYE_CLEAR_RADIUS = 60;
/** ... its top stays at least this far (m) below the eye's height. */
export const EYE_CLEARANCE = 0.25;
/** Detail only goes where the terrain mesh is fine (4 m grid): |x| <= 440, -1690 <= z <= 110. */
export const DETAIL_REGION = { xMin: -440, xMax: 440, zMin: -1690, zMax: 110 } as const;

export interface Pebble {
  x: number;
  y: number;
  z: number;
  /** Radius of the stone, m (it is squashed to about half that high). */
  size: number;
  yaw: number;
  tiltX: number;
  tiltZ: number;
  /** 0..1 along the theme's stone palette. */
  shade: number;
}

export interface Tuft {
  x: number;
  y: number;
  z: number;
  /** Width and height of the tuft, m. */
  size: number;
  yaw: number;
  /** 0..1: brightness variation. */
  shade: number;
}

export interface GroundDetailPlan {
  pebbles: Pebble[];
  tufts: Tuft[];
}

interface Circle {
  x: number;
  z: number;
  r: number;
}

/** What detail must keep off: circles (footprints, targets, the shooter) and corridors (lines of sight). */
export interface DetailExclusions {
  circles: Circle[];
  lanes: Array<{ x: number; z: number }>;
  shooter: { x: number; z: number };
}

/** Everything that must stay clear of detail for this layout; `extraTargets` are further targets (snipers, ...). */
export function detailExclusions(
  layout: MissionLayout,
  shooter: { x: number; z: number },
  extraTargets: ReadonlyArray<{ x: number; z: number }> = [],
): DetailExclusions {
  const circles: Circle[] = [{ x: shooter.x, z: shooter.z, r: SHOOTER_CLEARANCE }];
  const lanes: Array<{ x: number; z: number }> = [];
  for (const s of layout.soldiers) {
    circles.push({ x: s.x, z: s.z, r: TARGET_CLEARANCE });
    lanes.push({ x: s.x, z: s.z });
  }
  for (const v of layout.vehicleTargets) {
    circles.push({ x: v.x, z: v.z, r: Math.max(TARGET_CLEARANCE, propFootprintRadius(v.kind) + PROP_MARGIN) });
    lanes.push({ x: v.x, z: v.z });
  }
  for (const t of extraTargets) {
    circles.push({ x: t.x, z: t.z, r: TARGET_CLEARANCE });
    lanes.push({ x: t.x, z: t.z });
  }
  for (const p of layout.props) circles.push({ x: p.x, z: p.z, r: propFootprintRadius(p.kind) + PROP_MARGIN });
  return { circles, lanes, shooter: { x: shooter.x, z: shooter.z } };
}

/** Distance from (px, pz) to the segment a -> b. */
function distanceToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2)) : 0;
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

/** True when detail may stand at (x, z): inside the fine region and clear of every exclusion. */
export function detailClear(ex: DetailExclusions, x: number, z: number): boolean {
  const R = DETAIL_REGION;
  if (x < R.xMin || x > R.xMax || z < R.zMin || z > R.zMax) return false;
  for (const c of ex.circles) if (Math.hypot(x - c.x, z - c.z) < c.r) return false;
  for (const t of ex.lanes) {
    if (distanceToSegment(x, z, ex.shooter.x, ex.shooter.z, t.x, t.z) < LANE_HALF_WIDTH) return false;
  }
  return true;
}

/** The steepness of the ground at (x, z): rise over run by central differences over 2 m. */
export function groundSlope(field: Pick<TerrainField, 'height'>, x: number, z: number): number {
  const h = field.height;
  return Math.hypot(h(x + 1, z) - h(x - 1, z), h(x, z + 1) - h(x, z - 1)) / 2;
}

const DEG = Math.PI / 180;
/** Half-width of the sector in front of the shooter that gets most of the detail (the opening view is about +-46 deg), rad. */
const FRONT_HALF_ANGLE = 70 * DEG;

/** A point in the sector ahead of the shooter (mostly) or all round it, biased towards the shooter: radius = near + span * u^bias. */
function nearField(rng: Rng, shooter: { x: number; z: number }, near: number, span: number, bias: number, allRound: number): { x: number; z: number } {
  const theta = rng() < allRound ? rng() * 2 * Math.PI : (rng() * 2 - 1) * FRONT_HALF_ANGLE;
  const r = near + span * Math.pow(rng(), bias);
  // Bearing from straight downrange (-Z); the all-round draw spins the whole circle.
  return { x: shooter.x + r * Math.sin(theta), z: shooter.z - r * Math.cos(theta) };
}

/** A point around `anchor`: radius = near + span * u^bias, any direction. */
function around(rng: Rng, anchor: { x: number; z: number }, near: number, span: number, bias: number): { x: number; z: number } {
  const a = rng() * 2 * Math.PI;
  const r = near + span * Math.pow(rng(), bias);
  return { x: anchor.x + r * Math.cos(a), z: anchor.z + r * Math.sin(a) };
}

/**
 * Seeded placement of the pebbles (every theme) and grass tufts (valley only) of one mission.
 * Pebbles: about half in the near field ahead of the shooter, a good part around the targets and
 * props (so a scoped view has stones near the soldiers), the rest as scree at the foot of rock
 * outcrops. Tufts: mostly the near field, some around buildings. All of it is clear of `detailExclusions`
 * and of the outcrop mounds themselves. `extraTargets` are additional targets to keep clear.
 */
export function planGroundDetail(
  field: TerrainField,
  layout: MissionLayout,
  seed: number,
  extraTargets: ReadonlyArray<{ x: number; z: number }> = [],
): GroundDetailPlan {
  const theme: ThemeId = field.theme;
  const shooter = { x: field.shooter.x, z: field.shooter.z };
  const ex = detailExclusions(layout, shooter, extraTargets);
  const anchors: Array<{ x: number; z: number }> = [...layout.soldiers, ...layout.vehicleTargets, ...extraTargets, ...layout.props];
  const outcrops = field.outcrops;
  const onMound = (x: number, z: number, scale: number): boolean =>
    outcrops.some((o) => Math.hypot(x - o.x, z - o.z) < o.radius * scale);

  // How high detail may reach at (x, z): unlimited far from the shooter, below his eye near him.
  const eyeCeiling = (x: number, z: number): number =>
    Math.hypot(x - shooter.x, z - shooter.z) < EYE_CLEAR_RADIUS ? field.shooter.y - EYE_CLEARANCE : Infinity;

  const pebbleRng = createRng((Math.imul(seed, 0x2c1b3c6d) ^ 0x70656262) >>> 0);
  const pebbles: Pebble[] = [];
  for (let attempts = 0; pebbles.length < MAX_PEBBLES && attempts < MAX_PEBBLES * 30; attempts++) {
    const roll = pebbleRng();
    let p: { x: number; z: number };
    if (roll < 0.55 || (anchors.length === 0 && outcrops.length === 0)) {
      p = nearField(pebbleRng, shooter, 3.5, 110, 1.7, 0.15);
    } else if (roll < 0.9 && anchors.length > 0) {
      p = around(pebbleRng, anchors[Math.floor(pebbleRng() * anchors.length)], 2.2, 24, 1.6);
    } else if (outcrops.length > 0) {
      const o = outcrops[Math.floor(pebbleRng() * outcrops.length)];
      p = around(pebbleRng, o, o.radius * 0.95, o.radius * 0.7, 1);
    } else {
      continue;
    }
    if (!detailClear(ex, p.x, p.z) || onMound(p.x, p.z, 0.95)) continue;
    const ground = field.height(p.x, p.z);
    if (groundSlope(field, p.x, p.z) > MAX_DETAIL_SLOPE) continue;
    const u = pebbleRng();
    const size = 0.04 + u * u * u * 0.18; // mostly small stones, a few bigger ones
    if (ground + size * 0.05 + size > eyeCeiling(p.x, p.z)) continue; // a stone is under `size` high, tilt included
    pebbles.push({
      x: p.x,
      y: ground + size * 0.05,
      z: p.z,
      size,
      yaw: pebbleRng() * Math.PI * 2,
      tiltX: (pebbleRng() - 0.5) * 0.6,
      tiltZ: (pebbleRng() - 0.5) * 0.6,
      shade: pebbleRng(),
    });
  }

  const tufts: Tuft[] = [];
  if (theme === 'valley') {
    const tuftRng = createRng((Math.imul(seed, 0x1b873593) ^ 0x67726173) >>> 0);
    const buildings = layout.props.length > 0 ? layout.props : null;
    for (let attempts = 0; tufts.length < MAX_TUFTS && attempts < MAX_TUFTS * 30; attempts++) {
      const p =
        tuftRng() < 0.75 || !buildings
          ? nearField(tuftRng, shooter, 4, 90, 1.7, 0.1)
          : around(tuftRng, buildings[Math.floor(tuftRng() * buildings.length)], 3, 22, 1);
      if (!detailClear(ex, p.x, p.z) || onMound(p.x, p.z, 1.25)) continue;
      const ground = field.height(p.x, p.z);
      if (groundSlope(field, p.x, p.z) > MAX_DETAIL_SLOPE) continue;
      const size = 0.3 + tuftRng() * 0.3;
      if (ground - 0.02 + size > eyeCeiling(p.x, p.z)) continue;
      tufts.push({
        x: p.x,
        y: ground - 0.02,
        z: p.z,
        size,
        yaw: tuftRng() * Math.PI,
        shade: tuftRng(),
      });
    }
  }
  return { pebbles, tufts };
}
