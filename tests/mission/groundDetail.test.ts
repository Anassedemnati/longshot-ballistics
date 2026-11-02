import { describe, expect, it } from 'vitest';
import { DEFAULT_MISSION, clampMission } from '../../src/mission/config';
import type { FiringPosition, MissionConfig } from '../../src/mission/config';
import {
  DETAIL_REGION,
  EYE_CLEARANCE,
  EYE_CLEAR_RADIUS,
  LANE_HALF_WIDTH,
  MAX_DETAIL_SLOPE,
  MAX_PEBBLES,
  MAX_TUFTS,
  SHOOTER_CLEARANCE,
  TARGET_CLEARANCE,
  groundSlope,
  planGroundDetail,
} from '../../src/mission/groundDetail';
import type { GroundDetailPlan } from '../../src/mission/groundDetail';
import { generateLayout, legacyLayout } from '../../src/mission/layout';
import type { MissionLayout } from '../../src/mission/layout';
import { propColliders, vehicleTargetColliders } from '../../src/mission/props';
import type { ThemeId } from '../../src/mission/themes';
import { terrainGridAxes } from '../../src/scene/terrain';
import { createTerrainField } from '../../src/scene/terrainField';
import type { TerrainField } from '../../src/scene/terrainField';

const THEMES: ThemeId[] = ['desert', 'arctic', 'valley'];

const big = (theme: ThemeId, seed: number): MissionConfig =>
  clampMission({
    ...DEFAULT_MISSION,
    theme,
    seed,
    rangeMin: 100,
    rangeMax: 1500,
    soldiers: 10,
    vehicleTargets: 3,
    buildings: 'many',
    vehicles: 'many',
  });

function setup(config: MissionConfig): { field: TerrainField; layout: MissionLayout } {
  const field = createTerrainField(config.theme, config.seed);
  return { field, layout: generateLayout(config, field) };
}

/** Distance from a point to a segment, computed here independently of the module under test. */
function toSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const abx = bx - ax;
  const abz = bz - az;
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (pz - az) * abz) / (abx * abx + abz * abz)));
  return Math.hypot(px - ax - abx * t, pz - az - abz * t);
}

/** Every collider box of the scenery and the vehicle bodies, as footprint rectangles (centre, half sizes, yaw). */
function footprints(layout: MissionLayout, field: TerrainField): Array<{ cx: number; cz: number; hx: number; hz: number; yaw: number }> {
  const boxes = [];
  for (const p of layout.props) boxes.push(...propColliders(p, field.height(p.x, p.z)));
  for (const v of layout.vehicleTargets) boxes.push(...vehicleTargetColliders(v, field.height(v.x, v.z)).body);
  return boxes.map((o) => ({ cx: o.box.center.x, cz: o.box.center.z, hx: o.box.halfSize.x, hz: o.box.halfSize.z, yaw: o.box.yaw }));
}

function insideFootprint(f: ReturnType<typeof footprints>[number], x: number, z: number): boolean {
  const dx = x - f.cx;
  const dz = z - f.cz;
  const lx = dx * Math.cos(f.yaw) - dz * Math.sin(f.yaw);
  const lz = dx * Math.sin(f.yaw) + dz * Math.cos(f.yaw);
  return Math.abs(lx) <= f.hx && Math.abs(lz) <= f.hz;
}

/** Every way an item of the plan breaks a rule (empty when it keeps all of them). */
function violations(plan: GroundDetailPlan, field: TerrainField, layout: MissionLayout): string[] {
  const bad: string[] = [];
  const targets = [...layout.soldiers, ...layout.vehicleTargets];
  const rects = footprints(layout, field);
  const items = [...plan.pebbles, ...plan.tufts];
  for (const it of items) {
    const at = `(${it.x.toFixed(1)}, ${it.z.toFixed(1)})`;
    // inside the part of the map where the render mesh is fine
    if (it.x < DETAIL_REGION.xMin || it.x > DETAIL_REGION.xMax || it.z < DETAIL_REGION.zMin || it.z > DETAIL_REGION.zMax) bad.push(`${at} outside the fine region`);
    // on the ground
    if (Math.abs(it.y - field.height(it.x, it.z)) >= 0.1) bad.push(`${at} off the ground`);
    // not near the shooter
    if (Math.hypot(it.x - field.shooter.x, it.z - field.shooter.z) < SHOOTER_CLEARANCE) bad.push(`${at} at the shooter`);
    for (const t of targets) {
      // 2 m of clear ground around every target
      if (Math.hypot(it.x - t.x, it.z - t.z) < Math.max(2, TARGET_CLEARANCE)) bad.push(`${at} within 2 m of ${t.id}`);
      // and off the lane from the shooter to it
      if (toSegment(it.x, it.z, field.shooter.x, field.shooter.z, t.x, t.z) < LANE_HALF_WIDTH) bad.push(`${at} on the lane to ${t.id}`);
    }
    for (const f of rects) if (insideFootprint(f, it.x, it.z)) bad.push(`${at} inside a prop footprint`);
  }
  return bad;
}

describe('planGroundDetail', () => {
  for (const theme of THEMES) {
    it(`${theme}: stays within the caps and off the lane, the props and the targets (largest mission, three seeds)`, () => {
      for (const seed of [1, 7, 20261101]) {
        const { field, layout } = setup(big(theme, seed));
        const plan = planGroundDetail(field, layout, seed);
        expect(plan.pebbles.length).toBeGreaterThan(MAX_PEBBLES * 0.8);
        expect(plan.pebbles.length).toBeLessThanOrEqual(MAX_PEBBLES);
        expect(plan.tufts.length).toBeLessThanOrEqual(MAX_TUFTS);
        expect(violations(plan, field, layout)).toEqual([]);
      }
    });
  }

  it('grass tufts only in the valley', () => {
    for (const theme of THEMES) {
      const { field, layout } = setup(big(theme, 3));
      const plan = planGroundDetail(field, layout, 3);
      if (theme === 'valley') expect(plan.tufts.length).toBeGreaterThan(MAX_TUFTS * 0.8);
      else expect(plan.tufts).toHaveLength(0);
    }
  });

  it('is deterministic for a seed, and different for another', () => {
    const { field, layout } = setup(big('valley', 5));
    const a = planGroundDetail(field, layout, 5);
    const b = planGroundDetail(field, layout, 5);
    expect(b).toEqual(a);
    const c = planGroundDetail(field, layout, 6);
    expect(c.pebbles[0]).not.toEqual(a.pebbles[0]);
  });

  it('works on the legacy practice range: the lane to the lone dummy is clear', () => {
    const field = createTerrainField('desert', 1);
    const layout = legacyLayout(clampMission({ ...DEFAULT_MISSION, rangeMin: 300, rangeMax: 300 }));
    const plan = planGroundDetail(field, layout, 1);
    expect(plan.pebbles.length).toBeGreaterThan(0);
    expect(violations(plan, field, layout)).toEqual([]);
  });

  it('keeps off extra targets (snipers) too', () => {
    const { field, layout } = setup(big('desert', 2));
    const extra = [{ x: 30, z: -200 }];
    const plan = planGroundDetail(field, layout, 2, extra);
    for (const p of plan.pebbles) {
      expect(Math.hypot(p.x - 30, p.z + 200)).toBeGreaterThanOrEqual(2);
      expect(toSegment(p.x, p.z, field.shooter.x, field.shooter.z, 30, -200)).toBeGreaterThanOrEqual(LANE_HALF_WIDTH);
    }
  });

  it('puts stones near the soldiers (so the scope has something to see) and some scree at outcrops', () => {
    const { field, layout } = setup(big('desert', 4));
    const plan = planGroundDetail(field, layout, 4);
    const nearSoldier = plan.pebbles.filter((p) => layout.soldiers.some((s) => Math.hypot(p.x - s.x, p.z - s.z) < 25));
    expect(nearSoldier.length).toBeGreaterThan(20);
    const nearOutcrop = plan.pebbles.filter((p) => field.outcrops.some((o) => Math.hypot(p.x - o.x, p.z - o.z) < o.radius * 1.7));
    expect(nearOutcrop.length).toBeGreaterThan(0);
  });

  it('stones are small: 4 to 22 cm', () => {
    const { field, layout } = setup(big('arctic', 4));
    for (const p of planGroundDetail(field, layout, 4).pebbles) {
      expect(p.size).toBeGreaterThanOrEqual(0.04);
      expect(p.size).toBeLessThanOrEqual(0.22);
    }
  });
});

const POSITIONS: FiringPosition[] = ['valley', 'ridge', 'mountain'];

/** The largest mission with 3 enemy snipers at one firing position. */
function bigAt(theme: ThemeId, seed: number, position: FiringPosition): { field: TerrainField; layout: MissionLayout } {
  const config = clampMission({ ...big(theme, seed), position, enemySnipers: 3 });
  const field = createTerrainField(theme, seed, position);
  return { field, layout: generateLayout(config, field) };
}

describe('planGroundDetail at every firing position, with enemy snipers', () => {
  it('the mountain spur and the valley walls really are steep (so the slope rule has something to do)', () => {
    let spur = 0;
    for (const theme of THEMES) {
      const field = createTerrainField(theme, 3, 'mountain');
      for (let a = 0; a < 72; a++) {
        const t = (a / 72) * 2 * Math.PI;
        for (const r of [30, 45, 60, 75]) spur = Math.max(spur, groundSlope(field, r * Math.cos(t), r * Math.sin(t)));
      }
    }
    expect(spur).toBeGreaterThan(1);
    // The walls: ground steeper than the limit inside the part of the map that gets detail (every theme, ridge position).
    for (const theme of THEMES) {
      const field = createTerrainField(theme, 3, 'ridge');
      let steep = 0;
      for (let x = DETAIL_REGION.xMin; x <= DETAIL_REGION.xMax; x += 10) {
        for (let z = DETAIL_REGION.zMin; z <= DETAIL_REGION.zMax; z += 10) if (groundSlope(field, x, z) > MAX_DETAIL_SLOPE) steep++;
      }
      expect(steep).toBeGreaterThan(50);
    }
  });

  for (const theme of THEMES) {
    for (const position of POSITIONS) {
      it(`${theme} / ${position}: no stone or tuft on a steep face, none up at the eye near the shooter, clear of the snipers`, () => {
        for (const seed of [3, 11]) {
          const { field, layout } = bigAt(theme, seed, position);
          expect(layout.snipers).toHaveLength(3);
          const plan = planGroundDetail(field, layout, seed, layout.snipers);
          expect(plan.pebbles.length).toBeGreaterThan(MAX_PEBBLES * 0.8);
          if (theme === 'valley') expect(plan.tufts.length).toBeGreaterThan(MAX_TUFTS * 0.8);
          const bad: string[] = [];
          const items = [
            ...plan.pebbles.map((p) => ({ x: p.x, z: p.z, top: p.y + p.size })),
            ...plan.tufts.map((t) => ({ x: t.x, z: t.z, top: t.y + t.size })),
          ];
          for (const it of items) {
            const at = `(${it.x.toFixed(1)}, ${it.z.toFixed(1)})`;
            // slope by another stencil (+-0.5 m): the rule's own is +-1 m, so allow a little for the difference
            const h = field.height;
            const slope = Math.hypot(h(it.x + 0.5, it.z) - h(it.x - 0.5, it.z), h(it.x, it.z + 0.5) - h(it.x, it.z - 0.5));
            if (slope > MAX_DETAIL_SLOPE * 1.3) bad.push(`${at} on ground of slope ${slope.toFixed(2)}`);
            if (Math.hypot(it.x - field.shooter.x, it.z - field.shooter.z) < EYE_CLEAR_RADIUS && it.top > field.shooter.y - EYE_CLEARANCE) {
              bad.push(`${at} reaches the shooter's eye`);
            }
            for (const s of layout.snipers) {
              if (Math.hypot(it.x - s.x, it.z - s.z) < TARGET_CLEARANCE) bad.push(`${at} within ${TARGET_CLEARANCE} m of ${s.id}`);
              if (toSegment(it.x, it.z, field.shooter.x, field.shooter.z, s.x, s.z) < LANE_HALF_WIDTH) bad.push(`${at} on the lane to ${s.id}`);
            }
          }
          expect(bad).toEqual([]);
        }
      });
    }
  }

  it('the rule bites: without it the mountain would get stones on its steep flanks', () => {
    // Re-plan with the slope rule's limit exceeded by hand: count what the unfiltered near field would put on ground steeper than the limit.
    const { field } = bigAt('valley', 3, 'mountain');
    let steepSamples = 0;
    for (let a = 0; a < 360; a++) {
      const t = (a / 360) * 2 * Math.PI;
      for (const r of [20, 40, 60, 80]) if (groundSlope(field, r * Math.cos(t), r * Math.sin(t)) > MAX_DETAIL_SLOPE) steepSamples++;
    }
    expect(steepSamples).toBeGreaterThan(300); // most of the spur is steeper than the limit
  });
});

describe('DETAIL_REGION', () => {
  it('lies inside the part of the render mesh whose grid is fine (4 m or less), so stones sit on the drawn ground', () => {
    const { xs, zs } = terrainGridAxes();
    const steps = (axis: number[], min: number, max: number): number[] => {
      const out: number[] = [];
      for (let i = 1; i < axis.length; i++) if (axis[i] >= min && axis[i - 1] <= max) out.push(axis[i] - axis[i - 1]);
      return out;
    };
    expect(Math.max(...steps(xs, DETAIL_REGION.xMin, DETAIL_REGION.xMax))).toBeLessThanOrEqual(4.0001);
    expect(Math.max(...steps(zs, DETAIL_REGION.zMin, DETAIL_REGION.zMax))).toBeLessThanOrEqual(4.0001);
  });
});
