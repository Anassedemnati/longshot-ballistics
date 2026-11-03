import { describe, expect, it } from 'vitest';
import { RIFLES } from '../../src/ballistics/rifles';
import { findZeroElevation, simulateToRanges } from '../../src/ballistics/trajectory';
import type { RifleId, WindField } from '../../src/ballistics/types';
import { rifleMaxRange } from '../../src/mission/config';
import { themeAtmosphere } from '../../src/mission/themes';
import type { ThemeId } from '../../src/mission/themes';

// The five heavier calibres flown through the same solver as the original pair: they zero, they fly as their class should, and every
// rifle's farthest band can be held with the reticle no worse than the .308 already asks.

const IDS = Object.keys(RIFLES) as RifleId[];
const THEMES: ThemeId[] = ['desert', 'arctic', 'valley'];
const CALM: WindField = () => ({ x: 0, y: 0, z: 0 });
/** The mil reticle's hash ladder runs to 10 mil (src/player/reticle.ts HASH_MAX_MIL). */
const RETICLE_HASH_MIL = 10;

/** Hold at `range` m (mils above the target) for `id` zeroed at 100 m in `theme`'s air, and the speed there, m/s. */
function holdAt(id: RifleId, theme: ThemeId, range: number): { mil: number; speed: number } {
  const atmo = themeAtmosphere(theme);
  const rifle = RIFLES[id];
  const [s] = simulateToRanges(rifle, atmo, CALM, findZeroElevation(rifle, atmo), [range]);
  return { mil: (-s.height / range) * 1000, speed: s.velocity };
}

describe('rifle data', () => {
  it('every rifle has sane game fields: reload outlasts the bolt, only the .50 is semi-automatic', () => {
    for (const id of IDS) {
      const r = RIFLES[id];
      expect(r.id).toBe(id);
      expect(r.bulletMassG).toBeGreaterThan(5);
      expect(r.reloadTimeS).toBeGreaterThan(r.boltTimeS);
      expect(r.recoil).toBeGreaterThanOrEqual(1);
      expect(r.action).toBe(id === '50' ? 'semi' : 'bolt');
      expect(r.integralSuppressor).toBe(id === '127s');
      expect(r.antiMateriel).toBe(id === '50' || id === '408' || id === '127');
    }
    expect(RIFLES['308']).toMatchObject({ boltTimeS: 1.2, reloadTimeS: 1.5, recoil: 1 });
    expect(RIFLES['50'].boltTimeS).toBeCloseTo(0.35, 6);
    for (const id of ['408', '127', '127s'] as const) expect(RIFLES[id].boltTimeS).toBeGreaterThan(RIFLES['308'].boltTimeS);
    for (const id of ['50', '127'] as const) expect(RIFLES[id].recoil).toBeGreaterThan(2);
  });
});

describe('trajectories of the heavy calibres', () => {
  it('the zero solves for every rifle in every theme', () => {
    for (const theme of THEMES) {
      for (const id of IDS) {
        const elevation = findZeroElevation(RIFLES[id], themeAtmosphere(theme));
        expect(elevation).toBeGreaterThan(0);
        expect(Math.abs(holdAt(id, theme, 100).mil)).toBeLessThan(0.01);
      }
    }
  });

  it('the .50 BMG and the .408 drop less than the .308 at 1000 m, and keep more speed', () => {
    for (const theme of THEMES) {
      const base = holdAt('308', theme, 1000);
      for (const id of ['50', '408'] as const) {
        const h = holdAt(id, theme, 1000);
        expect(h.mil).toBeLessThan(base.mil * 0.7);
        expect(h.speed).toBeGreaterThan(base.speed + 150);
      }
    }
  });

  it('the subsonic 12.7x55 never goes above the speed of sound, and drops metres by 300 m', () => {
    for (const theme of THEMES) {
      const atmo = themeAtmosphere(theme);
      expect(RIFLES['127s'].muzzleVelocity).toBeLessThan(atmo.speedOfSound);
      const rifle = RIFLES['127s'];
      const ranges = Array.from({ length: 30 }, (_, i) => (i + 1) * 20);
      const samples = simulateToRanges(rifle, atmo, CALM, findZeroElevation(rifle, atmo), ranges);
      expect(samples.length).toBe(ranges.length);
      for (const s of samples) expect(s.velocity).toBeLessThan(atmo.speedOfSound);
      expect(-samples[14].height).toBeGreaterThan(3); // 300 m: over 3 m below the line of sight
    }
  });

  it("the subsonic band cap keeps its farthest target on the reticle's 10-mil ladder, and 25 m more would not", () => {
    const cap = rifleMaxRange('127s');
    for (const theme of THEMES) {
      expect(holdAt('127s', theme, cap).mil).toBeLessThan(RETICLE_HASH_MIL - 1); // a mil to spare for wind and a downhill shot
      expect(holdAt('127s', theme, cap + 25).mil).toBeGreaterThan(RETICLE_HASH_MIL);
    }
  });

  it("every other rifle's hold at the 1500 m band maximum is no worse than the .308's", () => {
    for (const theme of THEMES) {
      const base = holdAt('308', theme, 1500).mil;
      for (const id of IDS) {
        if (id === '308' || id === '127s') continue;
        expect(holdAt(id, theme, rifleMaxRange(id)).mil).toBeLessThanOrEqual(base);
      }
    }
  });
});
