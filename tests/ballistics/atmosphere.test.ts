import { describe, expect, it } from 'vitest';
import reference from '../fixtures/reference.json';
import { DESERT_ATMO, STANDARD_ATMO, makeAtmosphere } from '../../src/ballistics/atmosphere';
import { RIFLES } from '../../src/ballistics/rifles';

type RefCase = (typeof reference.cases)[number];

function firstSample(air: string): RefCase['samples'][number] {
  const c = reference.cases.find((k) => k.air === air);
  if (!c) throw new Error(`no fixture case for air=${air}`);
  const s = c.samples.find((x) => x.range === 100);
  if (!s) throw new Error(`no 100 m sample for air=${air}`);
  return s;
}

function relErr(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.abs(expected);
}

describe('atmosphere', () => {
  it('STANDARD_ATMO density ratio is ~1.000', () => {
    expect(STANDARD_ATMO.temperatureC).toBe(15);
    expect(STANDARD_ATMO.pressureHPa).toBe(1013.25);
    expect(Math.abs(STANDARD_ATMO.densityRatio - 1)).toBeLessThanOrEqual(0.001);
  });

  it('DESERT_ATMO density ratio is within 0.3% of the fixture at 100 m', () => {
    expect(DESERT_ATMO.temperatureC).toBe(38);
    expect(DESERT_ATMO.pressureHPa).toBe(1013.25);
    expect(relErr(DESERT_ATMO.densityRatio, firstSample('desert').densityRatio)).toBeLessThanOrEqual(0.003);
  });

  it('speed of sound is within 0.3% of the fixture (velocity / mach) for both airs', () => {
    for (const [air, atmo] of [
      ['standard', STANDARD_ATMO],
      ['desert', DESERT_ATMO],
    ] as const) {
      const s = firstSample(air);
      expect(relErr(atmo.speedOfSound, s.velocity / s.mach)).toBeLessThanOrEqual(0.003);
    }
  });

  it('makeAtmosphere derives density, ratio and speed of sound from T and P', () => {
    const a = makeAtmosphere(15, 1013.25);
    const tK = 288.15;
    expect(a.density).toBeCloseTo(101325 / (287.05 * tK), 10);
    expect(a.densityRatio).toBeCloseTo(a.density / 1.225, 12);
    expect(a.speedOfSound).toBeCloseTo(20.0467 * Math.sqrt(tK), 10);
    const hot = makeAtmosphere(38, 1013.25);
    expect(hot.density).toBeLessThan(a.density);
    expect(hot.speedOfSound).toBeGreaterThan(a.speedOfSound);
  });
});

describe('rifles', () => {
  it('.308 Win matches the global constraints', () => {
    expect(RIFLES['308']).toMatchObject({
      id: '308',
      name: '.308 Win',
      bcG7: 0.243,
      muzzleVelocity: 790,
      sightHeight: 0.04,
      zeroRange: 100,
      magazine: 5,
    });
  });

  it('.338 Lapua Magnum matches the global constraints', () => {
    expect(RIFLES['338']).toMatchObject({
      id: '338',
      name: '.338 Lapua Magnum',
      bcG7: 0.322,
      muzzleVelocity: 900,
      sightHeight: 0.04,
      zeroRange: 100,
      magazine: 5,
    });
  });
});
