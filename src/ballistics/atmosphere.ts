import type { Atmosphere } from './types';

/** Standard sea-level air density, kg/m^3. */
export const STANDARD_DENSITY = 1.225;

const KELVIN = 273.15;
/** Specific gas constant of dry air, J/(kg*K). */
const R_DRY_AIR = 287.05;

/** Dry air at the given temperature (degC) and pressure (hPa), at sea level. */
export function makeAtmosphere(temperatureC: number, pressureHPa: number): Atmosphere {
  const tK = temperatureC + KELVIN;
  const density = (pressureHPa * 100) / (R_DRY_AIR * tK);
  return {
    temperatureC,
    pressureHPa,
    density,
    densityRatio: density / STANDARD_DENSITY,
    speedOfSound: 20.0467 * Math.sqrt(tK),
  };
}

export const STANDARD_ATMO: Atmosphere = makeAtmosphere(15, 1013.25);
export const DESERT_ATMO: Atmosphere = makeAtmosphere(38, 1013.25);
