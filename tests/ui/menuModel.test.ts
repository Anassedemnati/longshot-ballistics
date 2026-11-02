import { describe, expect, it } from 'vitest';
import { DEFAULT_MISSION, MISSION_LIMITS, decodeMission, randomMission, routeFromSearch, windVector } from '../../src/mission/config';
import { createRng } from '../../src/mission/random';
import { THEMES } from '../../src/mission/themes';
import type { ThemeId } from '../../src/mission/themes';
import {
  clockPoint,
  densityNote,
  linkRange,
  menuSearch,
  mpsToMph,
  rangeLabel,
  rifleNote,
  seedFromBits,
  startSearch,
  stepClock,
  themeBlurb,
  windArrowDir,
  windSpeedLabel,
} from '../../src/ui/menuModel';

describe('linkRange', () => {
  it('moving min below max changes only min', () => {
    expect(linkRange({ min: 600, max: 1000 }, 'min', 300)).toEqual({ min: 300, max: 1000 });
  });

  it('moving min above max pushes max up with it', () => {
    expect(linkRange({ min: 600, max: 1000 }, 'min', 1200)).toEqual({ min: 1200, max: 1200 });
  });

  it('moving max below min pushes min down with it', () => {
    expect(linkRange({ min: 600, max: 1000 }, 'max', 400)).toEqual({ min: 400, max: 400 });
  });

  it('moving max above min changes only max', () => {
    expect(linkRange({ min: 600, max: 1000 }, 'max', 1400)).toEqual({ min: 600, max: 1400 });
  });

  it('clamps to 100-1500 m', () => {
    expect(linkRange({ min: 600, max: 1000 }, 'min', -50)).toEqual({ min: 100, max: 1000 });
    expect(linkRange({ min: 600, max: 1000 }, 'max', 99999)).toEqual({ min: 600, max: 1500 });
    expect(linkRange({ min: 600, max: 1000 }, 'min', 99999)).toEqual({ min: 1500, max: 1500 });
    expect(linkRange({ min: 600, max: 1000 }, 'max', 0)).toEqual({ min: 100, max: 100 });
  });

  it('keeps the end it did not move exactly as it was (off-grid values from a shared link survive)', () => {
    expect(linkRange({ min: 637, max: 1013 }, 'min', 700)).toEqual({ min: 700, max: 1013 });
    expect(linkRange({ min: 637, max: 1013 }, 'max', 900)).toEqual({ min: 637, max: 900 });
  });

  it('ignores a non-number', () => {
    expect(linkRange({ min: 600, max: 1000 }, 'min', Number.NaN)).toEqual({ min: 600, max: 1000 });
  });

  it('min <= max and inside the limits after any sequence of moves', () => {
    const rng = createRng(7);
    let band = { min: 600, max: 1000 };
    for (let i = 0; i < 500; i++) {
      band = linkRange(band, rng() < 0.5 ? 'min' : 'max', Math.floor(rng() * 1800) - 100);
      expect(band.min).toBeLessThanOrEqual(band.max);
      expect(band.min).toBeGreaterThanOrEqual(MISSION_LIMITS.rangeMin);
      expect(band.max).toBeLessThanOrEqual(MISSION_LIMITS.rangeMax);
    }
  });
});

describe('labels', () => {
  it('rangeLabel shows the band, or one distance when both ends are equal', () => {
    expect(rangeLabel({ min: 600, max: 1000 })).toBe('600–1000 m');
    expect(rangeLabel({ min: 800, max: 800 })).toBe('800 m');
  });

  it('converts m/s to mph', () => {
    expect(mpsToMph(0)).toBe(0);
    expect(mpsToMph(4.4704)).toBeCloseTo(10, 4);
    expect(mpsToMph(12)).toBeCloseTo(26.84, 2);
  });

  it('windSpeedLabel shows m/s and whole mph', () => {
    expect(windSpeedLabel(4.5)).toBe('4.5 m/s · 10 mph');
    expect(windSpeedLabel(0)).toBe('0.0 m/s · 0 mph');
    expect(windSpeedLabel(12)).toBe('12.0 m/s · 27 mph');
  });

  it('themeBlurb gives the air of each theme (spec A.3)', () => {
    expect(themeBlurb('desert')).toBe('38 °C · thin air');
    expect(themeBlurb('arctic')).toBe('−15 °C · dense air');
    expect(themeBlurb('valley')).toBe('18 °C · 900 hPa');
  });

  it('rifleNote gives the ballistic coefficient and muzzle velocity of each rifle (spec 5.5)', () => {
    expect(rifleNote('308')).toBe('G7 BC 0.243 · 790 m/s');
    expect(rifleNote('338')).toBe('G7 BC 0.322 · 900 m/s');
  });

  it('densityNote gives the prop counts of spec A.4', () => {
    expect(densityNote('buildings', 'none')).toBe('no buildings');
    expect(densityNote('buildings', 'few')).toBe('3–5 buildings');
    expect(densityNote('buildings', 'many')).toBe('8–12 buildings');
    expect(densityNote('vehicles', 'none')).toBe('no vehicles');
    expect(densityNote('vehicles', 'few')).toBe('2–3 vehicles');
    expect(densityNote('vehicles', 'many')).toBe('5–7 vehicles');
  });

  it('themeBlurb follows the theme definitions', () => {
    for (const id of Object.keys(THEMES) as ThemeId[]) {
      expect(themeBlurb(id)).toContain(`${Math.abs(THEMES[id].airTempC)} °C`);
    }
  });
});

describe('wind dial geometry', () => {
  it('puts 12 at the top, 3 on the right, 6 at the bottom and 9 on the left', () => {
    expect(clockPoint(12, 10)).toEqual({ x: 0, y: -10 });
    expect(clockPoint(3, 10)).toEqual({ x: 10, y: 0 });
    expect(clockPoint(6, 10)).toEqual({ x: 0, y: 10 });
    expect(clockPoint(9, 10)).toEqual({ x: -10, y: 0 });
  });

  it('the 12 positions sit on the circle, 30 degrees apart', () => {
    for (let c = 1; c <= 12; c++) {
      const p = clockPoint(c, 50);
      expect(Math.hypot(p.x, p.y)).toBeCloseTo(50, 5);
    }
    const one = clockPoint(1, 100);
    expect(one.x).toBeCloseTo(50, 5);
    expect(one.y).toBeCloseTo(-86.602540378, 6);
  });

  it('the arrow for 12 points toward the shooter, for 3 left, for 6 downrange, for 9 right', () => {
    expect(windArrowDir(12)).toEqual({ x: 0, y: 1 });
    expect(windArrowDir(3)).toEqual({ x: -1, y: 0 });
    expect(windArrowDir(6)).toEqual({ x: 0, y: -1 });
    expect(windArrowDir(9)).toEqual({ x: 1, y: 0 });
  });

  it('the arrow runs from its clock position toward the centre', () => {
    for (let c = 1; c <= 12; c++) {
      const from = clockPoint(c, 1);
      const dir = windArrowDir(c);
      expect(dir.x).toBeCloseTo(-from.x, 5);
      expect(dir.y).toBeCloseTo(-from.y, 5);
    }
  });

  it('the arrow is the wind vector seen from above (x right, z toward the shooter = down)', () => {
    for (let c = 1; c <= 12; c++) {
      const v = windVector(1, c);
      const dir = windArrowDir(c);
      expect(dir.x).toBeCloseTo(v.x, 5);
      expect(dir.y).toBeCloseTo(v.z, 5);
    }
  });

  it('stepClock wraps around 12', () => {
    expect(stepClock(12, 1)).toBe(1);
    expect(stepClock(1, -1)).toBe(12);
    expect(stepClock(9, 3)).toBe(12);
    expect(stepClock(5, 0)).toBe(5);
    expect(stepClock(3, -15)).toBe(12);
  });
});

describe('starting a mission', () => {
  it('seedFromBits keeps 32-bit values and never gives 0', () => {
    expect(seedFromBits(0)).toBe(1);
    expect(seedFromBits(123456)).toBe(123456);
    expect(seedFromBits(0xffffffff)).toBe(0xffffffff);
    expect(seedFromBits(-1)).toBe(0xffffffff);
  });

  it('startSearch gives a ?m= URL the router reads back as that mission with the new seed', () => {
    const search = startSearch({ ...DEFAULT_MISSION, theme: 'arctic', soldiers: 7 }, 424242, false);
    expect(search.startsWith('?m=v2.')).toBe(true);
    expect(search).not.toContain('debug');
    const route = routeFromSearch(search);
    expect(route.kind).toBe('mission');
    if (route.kind !== 'mission') return;
    expect(route.config).toEqual({ ...DEFAULT_MISSION, theme: 'arctic', soldiers: 7, seed: 424242 });
    expect(route.debug).toBe(false);
    expect(route.legacy).toBe(false);
  });

  it('startSearch keeps debug=1 when asked', () => {
    const route = routeFromSearch(startSearch(DEFAULT_MISSION, 5, true));
    expect(route.kind === 'mission' && route.debug).toBe(true);
  });

  it('startSearch clamps whatever the controls hold', () => {
    const route = routeFromSearch(startSearch({ ...DEFAULT_MISSION, soldiers: 99, rangeMin: 5, windSpeedMps: 50 }, 3, false));
    expect(route.kind === 'mission' && route.config).toMatchObject({ soldiers: 10, rangeMin: 100, windSpeedMps: 12 });
  });

  it('a random mission survives start and the way back through ?last= unchanged', () => {
    const rng = createRng(2024);
    for (let i = 0; i < 25; i++) {
      const cfg = randomMission(rng);
      const search = startSearch(cfg, 99, false);
      const code = new URLSearchParams(search).get('m') ?? '';
      expect(decodeMission(code)).toEqual({ ...cfg, seed: 99 });
      const back = routeFromSearch(`?last=${code}`);
      expect(back.kind).toBe('menu');
      expect(back.kind === 'menu' && back.last).toEqual({ ...cfg, seed: 99 });
    }
  });

  it('menuSearch gives a ?last= URL the router reads back as the menu holding that mission', () => {
    const cfg = { ...DEFAULT_MISSION, theme: 'valley' as const, soldiers: 8, rangeMin: 250, rangeMax: 250, seed: 777 };
    const search = menuSearch(cfg, false);
    expect(search.startsWith('?last=v2.')).toBe(true);
    expect(search).not.toContain('debug');
    const route = routeFromSearch(search);
    expect(route.kind).toBe('menu');
    expect(route.kind === 'menu' && route.last).toEqual(cfg);
  });

  it('menuSearch keeps debug=1 when asked, and the router still finds the menu', () => {
    const search = menuSearch(DEFAULT_MISSION, true);
    expect(search.endsWith('&debug=1')).toBe(true);
    const route = routeFromSearch(search);
    expect(route.kind === 'menu' && route.last).toEqual(DEFAULT_MISSION);
    expect(new URLSearchParams(search).get('debug')).toBe('1');
  });

  it('menuSearch clamps like every mission, and a random mission survives it unchanged', () => {
    const clamped = routeFromSearch(menuSearch({ ...DEFAULT_MISSION, soldiers: 99, windSpeedMps: 50 }, false));
    expect(clamped.kind === 'menu' && clamped.last).toMatchObject({ soldiers: 10, windSpeedMps: 12 });
    const rng = createRng(31);
    for (let i = 0; i < 25; i++) {
      const cfg = randomMission(rng);
      const back = routeFromSearch(menuSearch(cfg, false));
      expect(back.kind === 'menu' && back.last).toEqual(cfg);
    }
  });
});
