import { describe, expect, it } from 'vitest';
import { RIFLES } from '../../src/ballistics/rifles';
import type { RifleId } from '../../src/ballistics/types';
import { DEFAULT_MISSION, MISSION_LIMITS, clampMission, decodeMission, encodeMission, randomMission, rifleMaxRange } from '../../src/mission/config';
import type { FiringPosition } from '../../src/mission/config';
import { generateLayout } from '../../src/mission/layout';
import { createRng } from '../../src/mission/random';
import { createTerrainField } from '../../src/scene/terrainField';

// What a rifle imposes on a mission: the subsonic 12.7x55's band cap and its integral suppressor.

const IDS = Object.keys(RIFLES) as RifleId[];

describe('clampMission: the rifle has its say', () => {
  it('caps the band at 250 m for the subsonic 12.7x55, and leaves every other rifle the full 1500 m', () => {
    expect(rifleMaxRange('127s')).toBe(250);
    for (const id of IDS) if (id !== '127s') expect(rifleMaxRange(id)).toBe(MISSION_LIMITS.rangeMax);
    const c = clampMission({ ...DEFAULT_MISSION, rifle: '127s' });
    expect(c.rangeMin).toBe(250);
    expect(c.rangeMax).toBe(250);
    const near = clampMission({ ...DEFAULT_MISSION, rifle: '127s', rangeMin: 120, rangeMax: 900 });
    expect([near.rangeMin, near.rangeMax]).toEqual([120, 250]);
    const fifty = clampMission({ ...DEFAULT_MISSION, rifle: '50', rangeMin: 900, rangeMax: 1500 });
    expect([fifty.rangeMin, fifty.rangeMax]).toEqual([900, 1500]);
  });

  it('always suppresses the 12.7x55, whatever the link says, and leaves the others to the switch', () => {
    expect(clampMission({ ...DEFAULT_MISSION, rifle: '127s', suppressed: false }).suppressed).toBe(true);
    expect(decodeMission('v5.d.200.250.3.0.45.9.127s.f.f.1.r.0.1.0.0.1.c')?.suppressed).toBe(true);
    for (const id of IDS) {
      if (RIFLES[id].integralSuppressor) continue;
      expect(clampMission({ ...DEFAULT_MISSION, rifle: id, suppressed: false }).suppressed).toBe(false);
      expect(clampMission({ ...DEFAULT_MISSION, rifle: id, suppressed: true }).suppressed).toBe(true);
    }
  });

  it('is idempotent and round-trips through the link for every rifle', () => {
    const rng = createRng(77);
    for (let i = 0; i < 200; i++) {
      const c = clampMission({ ...randomMission(rng), rifle: IDS[i % IDS.length] });
      expect(clampMission(c)).toEqual(c);
      expect(decodeMission(encodeMission(c))).toEqual(c);
      expect(c.rangeMin).toBeLessThanOrEqual(c.rangeMax);
      expect(c.rangeMax).toBeLessThanOrEqual(rifleMaxRange(c.rifle));
    }
  });
});

describe('a 12.7x55 mission can be laid out', () => {
  const positions: FiringPosition[] = ['valley', 'ridge', 'mountain'];
  it('the most crowded capped band (10 soldiers, 3 vehicles, 3 snipers at 250 m) still builds in every theme and position', () => {
    for (const theme of ['desert', 'arctic', 'valley'] as const) {
      for (const position of positions) {
        for (const seed of [1, 2]) {
          const config = clampMission({
            ...DEFAULT_MISSION,
            rifle: '127s',
            theme,
            position,
            seed,
            soldiers: 10,
            vehicleTargets: 3,
            enemySnipers: 3,
            buildings: 'many',
            vehicles: 'many',
          });
          const layout = generateLayout(config, createTerrainField(theme, seed, position));
          expect(layout.soldiers.length).toBe(10);
          for (const s of layout.soldiers) expect(s.range).toBeLessThanOrEqual(config.rangeMax + 1);
        }
      }
    }
  });
});
