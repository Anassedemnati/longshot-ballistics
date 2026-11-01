import { describe, expect, it } from 'vitest';
import type { ThemeId } from '../../src/mission/themes';
import {
  SECTOR_HALF_ANGLE_RAD,
  SECTOR_MAX_RANGE,
  createTerrainField,
  sectorDistance,
} from '../../src/scene/terrainField';
import type { TerrainField } from '../../src/scene/terrainField';
import { ROCK_OUTCROPS, SHOOTER_POS, terrainHeight } from '../../src/scene/terrainHeight';

const THEME_IDS: ThemeId[] = ['desert', 'arctic', 'valley'];
const SEEDS = [1, 20261101, 987654321];
/** A wider sweep for the properties that must hold for every mission seed. */
const MANY_SEEDS = Array.from({ length: 40 }, (_, i) => 1000 + i * 7919);
const DEG = Math.PI / 180;

/** World point at `bearing` (rad, + = right of straight downrange) and horizontal `range`. */
function polar(bearing: number, range: number): { x: number; z: number } {
  return { x: range * Math.sin(bearing), z: -range * Math.cos(bearing) };
}

/** True when the straight line from the shooter to `aboveGround` metres over the ground at (bearing, range) clears the terrain. */
function lineOfSightClear(field: TerrainField, bearingDeg: number, range: number, aboveGround: number): boolean {
  const p = polar(bearingDeg * DEG, range);
  const end = { x: p.x, y: field.height(p.x, p.z) + aboveGround, z: p.z };
  const eye = field.shooter;
  const total = Math.hypot(end.x - eye.x, end.y - eye.y, end.z - eye.z);
  const samples = 200;
  for (let i = 1; i <= samples; i++) {
    const u = i / samples;
    if ((1 - u) * total <= 2) continue; // the last 2 m are the target's own patch of ground
    const x = eye.x + (end.x - eye.x) * u;
    const y = eye.y + (end.y - eye.y) * u;
    const z = eye.z + (end.z - eye.z) * u;
    // 15 cm of clearance: the bullet leaves 4 cm below the sight line.
    if (field.height(x, z) >= y - 0.15) return false;
  }
  return true;
}

describe('engagement sector constants', () => {
  it('is +-12 degrees out to 1600 m', () => {
    expect(SECTOR_HALF_ANGLE_RAD).toBeCloseTo(12 * DEG, 12);
    expect(SECTOR_MAX_RANGE).toBe(1600);
  });

  it('sectorDistance is 0 inside the wedge and the metric distance to it outside', () => {
    expect(sectorDistance(0, 0)).toBe(0);
    expect(sectorDistance(0, -500)).toBe(0);
    const edge = polar(11.9 * DEG, 800);
    expect(sectorDistance(edge.x, edge.z)).toBe(0);
    // Straight beyond the arc: distance is the range past 1600 m.
    expect(sectorDistance(0, -1700)).toBeCloseTo(100, 9);
    // 90 degrees to the right at 300 m: nearest point is on the right edge ray.
    expect(sectorDistance(300, 0)).toBeCloseTo(300 * Math.sin(78 * DEG), 9);
    // Behind the shooter: distance to the apex.
    expect(sectorDistance(30, 40)).toBeCloseTo(50, 9);
    expect(sectorDistance(0, 25)).toBeCloseTo(25, 9);
  });
});

describe('createTerrainField', () => {
  for (const theme of THEME_IDS) {
    describe(theme, () => {
      it('is deterministic per (theme, seed) and the seed changes the relief', () => {
        const pts: Array<[number, number]> = [
          [0, 0],
          [123.4, -567.8],
          [-900, -300],
          [1200, 200],
          [-1500, -2900],
          [37.25, 410],
          [-600, -1900],
        ];
        for (const seed of SEEDS) {
          const a = createTerrainField(theme, seed);
          const b = createTerrainField(theme, seed);
          expect(a.theme).toBe(theme);
          for (const [x, z] of pts) expect(a.height(x, z)).toBe(b.height(x, z));
          expect(a.shooter).toEqual(b.shooter);
          expect(a.outcrops).toEqual(b.outcrops);
        }
        const f1 = createTerrainField(theme, SEEDS[0]);
        const f2 = createTerrainField(theme, SEEDS[1]);
        const off = [-900, -300, 1200, -1900, -600, -1500].reduce(
          (diffs, x, i) => diffs + (f1.height(x, -400 - 150 * i) !== f2.height(x, -400 - 150 * i) ? 1 : 0),
          0,
        );
        expect(off).toBeGreaterThan(3);
      });

      it('puts the shooter on the 12 m rise at the origin, on the very top', () => {
        for (const seed of SEEDS) {
          const field = createTerrainField(theme, seed);
          expect(field.shooter.x).toBe(0);
          expect(field.shooter.z).toBe(0);
          expect(field.height(0, 0)).toBeGreaterThan(11);
          expect(field.height(0, 0)).toBeLessThan(13);
          expect(field.shooter.y).toBeCloseTo(field.height(0, 0) + 0.4, 9);
          for (const [x, z] of [
            [3, 0],
            [-3, 0],
            [0, 3],
            [0, -3],
          ]) {
            expect(field.height(x, z)).toBeLessThan(field.height(0, 0) + 0.05);
          }
        }
      });

      it('has a clear line of sight to chest and head at bearings -10, 0, +10 deg and ranges 100-1500 m', () => {
        for (const seed of SEEDS) {
          const field = createTerrainField(theme, seed);
          for (const bearing of [-10, 0, 10]) {
            for (let range = 100; range <= 1500; range += 100) {
              expect(lineOfSightClear(field, bearing, range, 1.6), `${theme} seed ${seed} ${bearing} deg ${range} m, head`).toBe(true);
              expect(lineOfSightClear(field, bearing, range, 1.35), `${theme} seed ${seed} ${bearing} deg ${range} m, chest`).toBe(true);
            }
          }
        }
      });

      it('keeps that line of sight for any bearing within +-10 deg, any range 100-1500, and many seeds', () => {
        for (const seed of MANY_SEEDS) {
          const field = createTerrainField(theme, seed);
          for (const bearing of [-10, -7.3, -3.1, 2.2, 6.6, 10]) {
            for (const range of [100, 137, 333, 618, 777, 1111, 1360, 1500]) {
              expect(lineOfSightClear(field, bearing, range, 1.35), `${theme} seed ${seed} ${bearing} deg ${range} m`).toBe(true);
            }
          }
        }
      });

      it('is gentle inside the sector: |h| <= 1.5 m and |h(p) - h(p + 6 m)| <= 0.5 m beyond the rise', () => {
        for (const seed of [...SEEDS, ...MANY_SEEDS.slice(0, 5)]) {
          const field = createTerrainField(theme, seed);
          let checked = 0;
          for (let range = 60; range <= 1594; range += 34) {
            for (let bearing = -11.9; bearing <= 11.9; bearing += 1.7) {
              const p = polar(bearing * DEG, range);
              for (const [dx, dz] of [
                [6, 0],
                [0, -6],
                [4.24, -4.24],
                [-6, 0],
              ]) {
                const qx = p.x + dx;
                const qz = p.z + dz;
                if (sectorDistance(qx, qz) > 0) continue; // the neighbour must be inside the sector too
                expect(Math.abs(field.height(p.x, p.z) - field.height(qx, qz))).toBeLessThanOrEqual(0.5);
                checked++;
              }
              expect(Math.abs(field.height(p.x, p.z))).toBeLessThanOrEqual(1.5);
            }
          }
          expect(checked).toBeGreaterThan(1000);
        }
      });

      it('has real relief and outcrops outside the sector, none inside', () => {
        for (const seed of SEEDS) {
          const field = createTerrainField(theme, seed);
          expect(field.outcrops.length).toBeGreaterThanOrEqual(3);
          for (const rock of field.outcrops) {
            // The whole footprint (and the rocky tint around it) is outside the wedge.
            expect(sectorDistance(rock.x, rock.z)).toBeGreaterThanOrEqual(rock.radius * 1.3 + 20 - 1e-9);
            for (let k = 0; k < 24; k++) {
              const a = (k / 24) * Math.PI * 2;
              expect(sectorDistance(rock.x + Math.cos(a) * rock.radius * 1.3, rock.z + Math.sin(a) * rock.radius * 1.3)).toBeGreaterThan(0);
            }
          }
          let min = Infinity;
          let max = -Infinity;
          for (let x = -1800; x <= 1800; x += 40) {
            for (let z = -2800; z <= 800; z += 40) {
              if (sectorDistance(x, z) < 300) continue;
              const h = field.height(x, z);
              min = Math.min(min, h);
              max = Math.max(max, h);
            }
          }
          expect(max - min).toBeGreaterThan(3);
        }
      });
    });
  }

  it('valley hills reach about 25 m, and only outside the sector', () => {
    for (const seed of SEEDS) {
      const field = createTerrainField('valley', seed);
      let max = -Infinity;
      for (let x = -1900; x <= 1900; x += 25) {
        for (let z = -2900; z <= 900; z += 25) max = Math.max(max, field.height(x, z));
      }
      expect(max).toBeGreaterThan(14);
      expect(max).toBeLessThan(32);
    }
  });

  it('the three themes differ at the same off-sector points', () => {
    const points: Array<[number, number]> = [
      [800, -300],
      [-900, -700],
      [1200, 200],
      [-500, -1900],
      [300, -2400],
    ];
    for (const seed of SEEDS) {
      const fields = THEME_IDS.map((t) => createTerrainField(t, seed));
      for (const [x, z] of points) {
        const heights = fields.map((f) => f.height(x, z));
        expect(new Set(heights).size, `(${x}, ${z}) seed ${seed}: ${heights.join(', ')}`).toBe(3);
      }
    }
  });
});

describe('legacy terrainHeight / SHOOTER_POS', () => {
  it('are thin wrappers over createTerrainField("desert", 1)', () => {
    const desert = createTerrainField('desert', 1);
    for (const [x, z] of [
      [0, 0],
      [250, -900],
      [-40, -10],
      [-1500, -2900],
      [0, -1000],
    ]) {
      expect(terrainHeight(x, z)).toBe(desert.height(x, z));
    }
    expect(SHOOTER_POS).toEqual(desert.shooter);
    expect(ROCK_OUTCROPS).toEqual(desert.outcrops);
  });

  it('keeps all desert outcrops outside the sector', () => {
    for (const rock of ROCK_OUTCROPS) expect(sectorDistance(rock.x, rock.z)).toBeGreaterThan(rock.radius);
  });
});
