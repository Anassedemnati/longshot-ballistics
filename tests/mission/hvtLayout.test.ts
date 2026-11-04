import { describe, expect, it } from 'vitest';
import { DEFAULT_MISSION, clampMission } from '../../src/mission/config';
import type { MissionConfig } from '../../src/mission/config';
import { COMPOUND_AREA_M } from '../../src/mission/hvtLayout';
import { generateLayout } from '../../src/mission/layout';
import { createTerrainField } from '../../src/scene/terrainField';
import { POSITIONS, THEMES } from '../helpers/missions';

// The HVT's compound (mission/hvtLayout.ts, through generateLayout): always a house and a jeep inside the band, whatever the densities, his
// soldiers round it, and a walk the shooter sees most of but not all.

function hvt(partial: Partial<MissionConfig>) {
  const config = clampMission({ ...DEFAULT_MISSION, objective: 'hvt', ...partial });
  const field = createTerrainField(config.theme, config.seed, config.position);
  return { config, field, layout: generateLayout(config, field) };
}

describe('the HVT compound', () => {
  it('a clear-the-area mission has none, and its layout does not depend on the HVT code at all', () => {
    const config = clampMission({ ...DEFAULT_MISSION, seed: 7 });
    const field = createTerrainField(config.theme, config.seed, config.position);
    const layout = generateLayout(config, field);
    expect(layout.hvt).toBeUndefined();
    expect(generateLayout(config, field)).toEqual(layout);
  });

  it('is a house and a jeep (the first two props) inside the range band, even with no buildings and no vehicles', () => {
    for (const density of ['none', 'few', 'many'] as const) {
      for (const seed of [1, 2, 3, 4, 5]) {
        const { config, layout } = hvt({ seed, buildings: density, vehicles: density, rangeMin: 400, rangeMax: 700, soldiers: 4 });
        const h = layout.hvt;
        expect(h, `${density} ${seed}`).toBeDefined();
        if (!h) continue;
        expect(layout.props[0].kind).toBe('house');
        expect(layout.props[1].kind).toBe('jeep');
        expect(h.houseId).toBe(layout.props[0].id);
        expect(h.vehicleId).toBe(layout.props[1].id);
        const range = Math.hypot(h.x, h.z);
        expect(range).toBeGreaterThanOrEqual(config.rangeMin - 1);
        expect(range).toBeLessThanOrEqual(config.rangeMax + 1);
        expect(h.guards).toBeGreaterThanOrEqual(2);
        expect(h.guards).toBeLessThanOrEqual(4);
        expect(h.escapes.map((e) => e.kind).sort()).toEqual(['door', 'vehicle']);
        expect(h.route.length).toBeGreaterThanOrEqual(4);
        // The rest of the scenery keeps out of the compound.
        for (const p of layout.props.slice(2)) expect(Math.hypot(p.x - h.x, p.z - h.z)).toBeGreaterThan(20);
      }
    }
  });

  it('places his soldiers round the compound, off his walk, with a talk stop in front of one of them', () => {
    let talks = 0;
    let near = 0;
    let total = 0;
    for (const seed of [11, 12, 13, 14, 15, 16]) {
      const { layout } = hvt({ seed, rangeMin: 500, rangeMax: 800, soldiers: 5 });
      const h = layout.hvt;
      if (!h) throw new Error('no hvt');
      for (const s of layout.soldiers) {
        total++;
        if (Math.hypot(s.x - h.x, s.z - h.z) <= COMPOUND_AREA_M + 1) near++;
      }
      if (h.route.some((p) => p.face !== undefined)) talks++;
    }
    expect(near / total).toBeGreaterThan(0.8);
    expect(talks).toBeGreaterThanOrEqual(5);
  });

  it('gives the shooter a view of most of his walk, but not all of it, on most seeds', () => {
    const shares: number[] = [];
    for (const theme of THEMES) {
      for (const position of POSITIONS) {
        for (const seed of [21, 22, 23]) {
          const { layout } = hvt({ theme, position, seed, rangeMin: 400, rangeMax: 800 });
          shares.push(layout.hvt?.visibleShare ?? 0);
        }
      }
    }
    const good = shares.filter((s) => s >= 0.5 && s < 0.99).length;
    expect(good / shares.length, shares.map((s) => s.toFixed(2)).join(' ')).toBeGreaterThan(0.75);
    expect(shares.filter((s) => s >= 0.999).length / shares.length).toBeLessThan(0.25);
  });

  it('is the same for the same seed', () => {
    const a = hvt({ seed: 99 }).layout;
    const b = hvt({ seed: 99 }).layout;
    expect(b).toEqual(a);
  });
});
