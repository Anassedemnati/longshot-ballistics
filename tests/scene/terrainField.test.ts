import { describe, expect, it } from 'vitest';
import type { FiringPosition } from '../../src/mission/config';
import type { ThemeId } from '../../src/mission/themes';
import {
  FIRING_POSITIONS,
  MOUNTAIN_PAD_RADIUS,
  SECTOR_HALF_ANGLE_RAD,
  SECTOR_MAX_RANGE,
  WALL_START,
  createTerrainField,
  sectorDistance,
} from '../../src/scene/terrainField';
import type { TerrainField } from '../../src/scene/terrainField';
import { ROCK_OUTCROPS, SHOOTER_POS, terrainHeight } from '../../src/scene/terrainHeight';

const THEME_IDS: ThemeId[] = ['desert', 'arctic', 'valley'];
const POSITION_IDS: FiringPosition[] = ['valley', 'ridge', 'mountain'];
/** Prone eye height at the origin: the top of the landform plus 0.4 m (spec B.2). */
const EYE_Y: Record<FiringPosition, number> = { valley: 1.9, ridge: 12.4, mountain: 85.4 };
const SEEDS = [1, 20261101, 987654321];
/** A wider sweep for the properties that must hold for every mission seed. */
const MANY_SEEDS = Array.from({ length: 40 }, (_, i) => 1000 + i * 7919);
const DEG = Math.PI / 180;

/** World point at `bearing` (rad, + = right of straight downrange) and horizontal `range`. */
function polar(bearing: number, range: number): { x: number; z: number } {
  return { x: range * Math.sin(bearing), z: -range * Math.cos(bearing) };
}

/**
 * True when the straight line from the shooter to `aboveGround` metres over the ground at (bearing, range) clears the terrain.
 * Sampled at least every metre: a coarser step would jump over the mountain spur's crags.
 */
function lineOfSightClear(field: TerrainField, bearingDeg: number, range: number, aboveGround: number): boolean {
  const p = polar(bearingDeg * DEG, range);
  const end = { x: p.x, y: field.height(p.x, p.z) + aboveGround, z: p.z };
  const eye = field.shooter;
  const total = Math.hypot(end.x - eye.x, end.y - eye.y, end.z - eye.z);
  const samples = Math.max(200, Math.ceil(total));
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

      for (const position of POSITION_IDS) {
        const riseHeight = FIRING_POSITIONS[position].height;

        it(`${position}: puts the shooter on the ${riseHeight} m landform at the origin, on the very top, eye 0.4 m above it`, () => {
          for (const seed of SEEDS) {
            const field = createTerrainField(theme, seed, position);
            expect(field.shooter.x).toBe(0);
            expect(field.shooter.z).toBe(0);
            expect(field.height(0, 0)).toBeCloseTo(riseHeight, 9);
            expect(field.shooter.y).toBeCloseTo(EYE_Y[position], 9);
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

        it(`${position}: has a clear line of sight to chest and head at bearings -10, 0, +10 deg and ranges 100-1500 m`, () => {
          for (const seed of SEEDS) {
            const field = createTerrainField(theme, seed, position);
            for (const bearing of [-10, 0, 10]) {
              for (let range = 100; range <= 1500; range += 100) {
                expect(lineOfSightClear(field, bearing, range, 1.6), `${theme} ${position} seed ${seed} ${bearing} deg ${range} m, head`).toBe(true);
                expect(lineOfSightClear(field, bearing, range, 1.35), `${theme} ${position} seed ${seed} ${bearing} deg ${range} m, chest`).toBe(true);
              }
            }
          }
        });

        it(`${position}: keeps that line of sight for any bearing within +-10 deg, any range 100-1500, and many seeds`, () => {
          for (const seed of MANY_SEEDS) {
            const field = createTerrainField(theme, seed, position);
            for (const bearing of [-10, -7.3, -3.1, 2.2, 6.6, 10]) {
              for (const range of [100, 137, 333, 618, 777, 1111, 1360, 1500]) {
                expect(lineOfSightClear(field, bearing, range, 1.35), `${theme} ${position} seed ${seed} ${bearing} deg ${range} m`).toBe(true);
              }
            }
          }
        });

        it(`${position}: is gentle inside the sector: |h| <= 1.5 m and |h(p) - h(p + 6 m)| <= 0.5 m beyond the landform`, () => {
          const from = position === 'mountain' ? 100 : 60; // the spur is 90 m wide
          for (const seed of [...SEEDS, ...MANY_SEEDS.slice(0, 5)]) {
            const field = createTerrainField(theme, seed, position);
            let checked = 0;
            for (let range = from; range <= 1594; range += 34) {
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
      }

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

describe('firing positions', () => {
  it('are the spec B.2 landforms: valley 1.5 m / 24 m, ridge 12 m / 40 m, mountain 85 m / 90 m', () => {
    expect(FIRING_POSITIONS).toEqual({
      valley: { height: 1.5, radius: 24 },
      ridge: { height: 12, radius: 40 },
      mountain: { height: 85, radius: 90 },
    });
    expect(MOUNTAIN_PAD_RADIUS).toBe(6);
  });

  it("default to 'ridge'", () => {
    for (const theme of THEME_IDS) {
      const a = createTerrainField(theme, 5);
      const b = createTerrainField(theme, 5, 'ridge');
      expect(a.shooter).toEqual(b.shooter);
      for (const [x, z] of [[0, 0], [20, -10], [-700, -400], [900, 300]]) expect(a.height(x, z)).toBe(b.height(x, z));
    }
  });

  it('are deterministic per (theme, seed, position), and only change the ground under the shooter', () => {
    for (const theme of THEME_IDS) {
      for (const seed of SEEDS) {
        const fields = POSITION_IDS.map((position) => createTerrainField(theme, seed, position));
        const again = POSITION_IDS.map((position) => createTerrainField(theme, seed, position));
        const far: Array<[number, number]> = [
          [800, -300],
          [-900, -700],
          [0, -1000],
          [1200, 200],
          [-500, -1900],
          [0, 300],
          [120, -100],
          [-130, 20],
        ];
        far.forEach(([x, z]) => {
          for (let i = 0; i < fields.length; i++) expect(fields[i].height(x, z)).toBe(again[i].height(x, z));
          // 100 m and more from the origin nothing depends on the position (the mountain ends at 90 m).
          expect(fields[0].height(x, z)).toBe(fields[1].height(x, z));
          expect(fields[1].height(x, z)).toBe(fields[2].height(x, z));
        });
        expect(fields.map((f) => f.outcrops)).toEqual(again.map((f) => f.outcrops));
        expect(fields[0].outcrops).toEqual(fields[2].outcrops);
      }
    }
  });

  it('valley and mountain follow height * (1 - r / radius)^2 around the shooter, the ridge its smooth hill', () => {
    for (const theme of THEME_IDS) {
      for (const seed of SEEDS) {
        const ringMean = (field: TerrainField, r: number): number => {
          let sum = 0;
          for (let k = 0; k < 72; k++) sum += field.height(r * Math.cos((k / 72) * 2 * Math.PI), r * Math.sin((k / 72) * 2 * Math.PI));
          return sum / 72;
        };
        const valley = createTerrainField(theme, seed, 'valley');
        const mountain = createTerrainField(theme, seed, 'mountain');
        const ridge = createTerrainField(theme, seed, 'ridge');
        expect(Math.abs(ringMean(valley, 12) - 0.375)).toBeLessThan(0.35);
        expect(Math.abs(ringMean(mountain, 45) - 21.25), `${theme} ${seed} mountain ring at 45 m`).toBeLessThan(1.5);
        expect(Math.abs(ringMean(mountain, 20) - 85 * (70 / 90) ** 2), `${theme} ${seed} mountain ring at 20 m`).toBeLessThan(2.5);
        expect(Math.abs(ringMean(ridge, 20) - 6)).toBeLessThan(0.5); // smoothstep: half way up at half the radius
        // Beyond the landform the plain: the valley sandbank ends at 24 m, the mountain at 90 m.
        for (let bearing = -11; bearing <= 11; bearing += 2) {
          const p = polar(bearing * DEG, 30);
          expect(Math.abs(valley.height(p.x, p.z))).toBeLessThan(0.6);
        }
        // (the mountain's foot, seen inside the sector where no relief or wall can reach it)
        for (let bearing = -11; bearing <= 11; bearing += 2) {
          const p = polar(bearing * DEG, 96);
          expect(Math.abs(mountain.height(p.x, p.z))).toBeLessThan(0.6);
        }
      }
    }
  });

  it('the mountain is a rocky spur: bare crags on the flanks, an untouched 6 m pad on top', () => {
    for (const theme of THEME_IDS) {
      for (const seed of [...SEEDS, ...MANY_SEEDS.slice(0, 6)]) {
        const field = createTerrainField(theme, seed, 'mountain');
        const profile = (r: number): number => 85 * (1 - r / 90) ** 2;
        // The pad: the pure profile (plus at most a few millimetres of ground swell).
        for (let k = 0; k < 24; k++) {
          const a = (k / 24) * 2 * Math.PI;
          const r = MOUNTAIN_PAD_RADIUS;
          expect(Math.abs(field.height(r * Math.cos(a), r * Math.sin(a)) - profile(r)), `${theme} ${seed} pad`).toBeLessThan(0.01);
        }
        // The flanks: crags of a couple of metres at least, never wild (the eye sees past them).
        let worst = 0;
        for (let r = 16; r <= 60; r += 4) {
          for (let k = 0; k < 48; k++) {
            const a = (k / 48) * 2 * Math.PI;
            worst = Math.max(worst, Math.abs(field.height(r * Math.cos(a), r * Math.sin(a)) - profile(r)));
          }
        }
        expect(worst, `${theme} ${seed} roughness`).toBeGreaterThan(2);
        expect(worst, `${theme} ${seed} roughness`).toBeLessThan(8);
        // Gone at the foot.
        expect(Math.abs(field.height(0, -92))).toBeLessThan(1);
      }
    }
  });

  it('the mountain keeps a clear line of sight to the foot of the spur and to near targets, at every bearing in the sector', () => {
    for (const theme of THEME_IDS) {
      for (const seed of MANY_SEEDS.slice(0, 10)) {
        const field = createTerrainField(theme, seed, 'mountain');
        for (let bearing = -12; bearing <= 12; bearing += 1) {
          for (const range of [100, 101, 105, 120, 160]) {
            expect(lineOfSightClear(field, bearing, range, 1.6), `${theme} ${seed} ${bearing} deg ${range} m`).toBe(true);
          }
        }
      }
    }
  });
});

describe('valley walls', () => {
  const wallAt = (field: TerrainField, bearingDeg: number, range: number): number => {
    const p = polar(bearingDeg * DEG, range);
    return field.height(p.x, p.z);
  };

  for (const theme of THEME_IDS) {
    it(`${theme}: reach 80 m or more somewhere at |bearing| >= 30 deg, range 600 m, for every seed and position`, () => {
      for (const seed of [...SEEDS, ...MANY_SEEDS]) {
        for (const position of seed === SEEDS[0] ? POSITION_IDS : (['ridge'] as const)) {
          const field = createTerrainField(theme, seed, position);
          let best = -Infinity;
          for (let bearing = 30; bearing <= 150; bearing += 1) {
            best = Math.max(best, wallAt(field, bearing, 600), wallAt(field, -bearing, 600));
          }
          expect(best, `${theme} ${position} seed ${seed}`).toBeGreaterThanOrEqual(80);
        }
      }
    });

    it(`${theme}: are 55 m or more once fully risen, never above 275 m, and also close the far end and the back`, () => {
      for (const seed of SEEDS) {
        const field = createTerrainField(theme, seed);
        let min = Infinity;
        let max = -Infinity;
        for (let x = -1950; x <= 1950; x += 50) {
          for (let z = -2950; z <= 950; z += 50) {
            const sd = sectorDistance(x, z);
            const h = field.height(x, z);
            max = Math.max(max, h);
            if (sd >= 600) min = Math.min(min, h);
          }
        }
        // Relief and outcrops add or take a few metres around the wall's own 55-250 m.
        expect(min, `${theme} seed ${seed} lowest full wall`).toBeGreaterThanOrEqual(48);
        expect(max, `${theme} seed ${seed} highest ground`).toBeLessThanOrEqual(275);
        expect(max, `${theme} seed ${seed} highest ground`).toBeGreaterThan(120);
        // Straight downrange beyond the sector's arc, and behind the shooter.
        expect(field.height(0, -2900)).toBeGreaterThanOrEqual(48);
        expect(field.height(0, 900)).toBeGreaterThanOrEqual(48);
      }
    });

    it(`${theme}: keep clear of the sector and a ${WALL_START} m margin around it`, () => {
      for (const seed of SEEDS) {
        for (const position of POSITION_IDS) {
          const field = createTerrainField(theme, seed, position);
          let checked = 0;
          for (let x = -1950; x <= 1950; x += 15) {
            for (let z = -2950; z <= 950; z += 15) {
              if (sectorDistance(x, z) > WALL_START || Math.hypot(x, z) < 100) continue;
              // The theme's own relief (dunes, drifts, hills) fades in over the first 140-320 m; walls would be 55 m+.
              expect(field.height(x, z), `${theme} ${position} seed ${seed} (${x}, ${z})`).toBeLessThan(14);
              checked++;
            }
          }
          expect(checked).toBeGreaterThan(2500);
        }
      }
    });
  }

  it('differ per theme: the desert is the highest and sharpest, the valley the lowest and roundest', () => {
    const max = (theme: ThemeId): number => {
      const field = createTerrainField(theme, 1);
      let best = 0;
      for (let x = -1950; x <= 1950; x += 30) for (let z = -2950; z <= 950; z += 30) best = Math.max(best, field.height(x, z));
      return best;
    };
    expect(max('desert')).toBeGreaterThan(max('arctic'));
    expect(max('arctic')).toBeGreaterThan(max('valley'));
  });
});

describe('ridge position: the sector is unchanged by firing positions and walls', () => {
  // Heights recorded from the stage-1b field (before positions and walls), at polar points (bearing deg, range m)
  // inside the sector: (0, 3) (0, 45) (0, 100) (5, 250) (-8, 400) (11.5, 650) (-11.9, 900) (3, 1200) (-10, 1500) (0, 1599) (9, 77) (-6, 333).
  const POINTS: Array<[number, number]> = [[0, 3], [0, 45], [0, 100], [5, 250], [-8, 400], [11.5, 650], [-11.9, 900], [3, 1200], [-10, 1500], [0, 1599], [9, 77], [-6, 333]];
  const GOLDEN: Record<string, number[]> = {
  'desert/1': [11.807625, 0.07786816459247659, 0.10183987056672572, 0.16018612910071583, 0.051424307885115136, -0.20520283647673365, 0.11705452332452837, 0.17066294480723407, -0.01883972217125214, 0.0885541384730732, 0.09896822796584645, 0.14792309236231815],
  'desert/20261101': [11.807625, -0.1748130801196276, -0.08221666702020328, -0.23277713196694938, -0.11161996409456713, -0.1292270584938481, 0.009505038232691672, -0.18149124123181448, -0.326292996136439, -0.03296462554487528, -0.11967113439773036, -0.1567434775974821],
  'arctic/1': [11.807625, 0.006316671264632151, 0.06714780536536875, 0.14177451015356554, 0.1284018717235984, 0.19226864621942402, -0.21715896374329766, -0.2780403034250378, 0.28527458770308306, -0.26238591132461936, 0.04503458624931465, 0.09726372283381536],
  'arctic/20261101': [11.807625, 0.04892843918430391, 0.045402201985409035, 0.12702230215412288, 0.014334322176028456, 0.1370793130026256, 0.07686805949844402, 0.11561796510899419, 0.34046031366949425, -0.2825241757168346, 0.04631566233326039, -0.05690886683045738],
  'valley/1': [11.807625, 0.18939805342788352, 0.12359180092661723, -0.12832794591591926, -0.17321234221149842, 0.05623001007958746, -0.04410200876992873, -0.014130206739142635, 0.035806578760077735, -0.019751922050773908, 0.15840652876073333, -0.1869191555947794],
  'valley/20261101': [11.807625, 0.1632087217186915, 0.1759197027439629, 0.059155535589695496, 0.09516101817991982, 0.12064024209297845, -0.058335636483935104, 0.0844939779445502, 0.2078041850976176, -0.0771067758512884, 0.17277209274969063, 0.07260771659277718],
  };

  for (const [key, expected] of Object.entries(GOLDEN)) {
    it(`${key}`, () => {
      const [theme, seed] = key.split('/');
      const field = createTerrainField(theme as ThemeId, Number(seed), 'ridge');
      POINTS.forEach(([bearing, range], i) => {
        const p = polar(bearing * DEG, range);
        expect(field.height(p.x, p.z), `${key} (${bearing} deg, ${range} m)`).toBeCloseTo(expected[i], 9);
      });
    });
  }
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
