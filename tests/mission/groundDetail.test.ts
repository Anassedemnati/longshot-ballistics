import { describe, expect, it } from 'vitest';
import { DEFAULT_MISSION, clampMission } from '../../src/mission/config';
import type { MissionConfig } from '../../src/mission/config';
import {
  DETAIL_REGION,
  LANE_HALF_WIDTH,
  MAX_PEBBLES,
  MAX_TUFTS,
  SHOOTER_CLEARANCE,
  TARGET_CLEARANCE,
  planGroundDetail,
} from '../../src/mission/groundDetail';
import type { GroundDetailPlan } from '../../src/mission/groundDetail';
import { generateLayout, legacyLayout } from '../../src/mission/layout';
import type { MissionLayout } from '../../src/mission/layout';
import { propColliders, vehicleTargetColliders } from '../../src/mission/props';
import type { ThemeId } from '../../src/mission/themes';
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
