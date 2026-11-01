import { makeAtmosphere } from '../ballistics/atmosphere';
import type { Atmosphere } from '../ballistics/types';

export type ThemeId = 'desert' | 'arctic' | 'valley';

export interface ThemeDef {
  id: ThemeId;
  /** Display name for the menu. */
  name: string;
  /** Air temperature the ballistics uses, degC. */
  airTempC: number;
  /** Air pressure the ballistics uses, hPa. */
  airPressureHPa: number;
}

export const THEMES: Record<ThemeId, ThemeDef> = {
  desert: { id: 'desert', name: 'Desert', airTempC: 38, airPressureHPa: 1013.25 },
  arctic: { id: 'arctic', name: 'Arctic', airTempC: -15, airPressureHPa: 1013.25 },
  valley: { id: 'valley', name: 'Green valley', airTempC: 18, airPressureHPa: 900 },
};

/** Dry air at the theme's temperature and pressure, sea level. */
export function themeAtmosphere(id: ThemeId): Atmosphere {
  const t = THEMES[id];
  return makeAtmosphere(t.airTempC, t.airPressureHPa);
}
