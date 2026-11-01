import { describe, expect, it } from 'vitest';
import { makeAtmosphere } from '../../src/ballistics/atmosphere';
import { THEMES, themeAtmosphere } from '../../src/mission/themes';
import type { ThemeId } from '../../src/mission/themes';

describe('THEMES', () => {
  it('defines desert, arctic and valley with the spec air', () => {
    expect(THEMES.desert).toEqual({ id: 'desert', name: 'Desert', airTempC: 38, airPressureHPa: 1013.25 });
    expect(THEMES.arctic).toEqual({ id: 'arctic', name: 'Arctic', airTempC: -15, airPressureHPa: 1013.25 });
    expect(THEMES.valley).toEqual({ id: 'valley', name: 'Green valley', airTempC: 18, airPressureHPa: 900 });
  });

  it('keys each theme by its own id', () => {
    for (const id of Object.keys(THEMES) as ThemeId[]) expect(THEMES[id].id).toBe(id);
  });
});

describe('themeAtmosphere', () => {
  it('arctic air is denser than desert air', () => {
    expect(themeAtmosphere('arctic').densityRatio).toBeGreaterThan(themeAtmosphere('desert').densityRatio);
  });

  it('valley air is built from 18 C / 900 hPa', () => {
    expect(themeAtmosphere('valley')).toEqual(makeAtmosphere(18, 900));
  });

  it('desert and arctic match makeAtmosphere with the spec values', () => {
    expect(themeAtmosphere('desert')).toEqual(makeAtmosphere(38, 1013.25));
    expect(themeAtmosphere('arctic')).toEqual(makeAtmosphere(-15, 1013.25));
  });
});
