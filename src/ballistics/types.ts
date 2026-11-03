// Shared ballistics types. Units: meters, seconds, radians, m/s, kg/m^3, degC, hPa.
// World frame: Y up, downrange = -Z, shooter's right = +X.

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface BulletState {
  pos: Vec3;
  vel: Vec3;
  t: number;
}

/** The rifles, by calibre. Used as-is in mission links (between dots), so letters and digits only. */
export type RifleId = '308' | '338' | '300' | '408' | '50' | '127' | '127s';

export interface Rifle {
  id: RifleId;
  name: string;
  /** G7 ballistic coefficient, lb/in^2. */
  bcG7: number;
  /** Muzzle velocity, m/s. */
  muzzleVelocity: number;
  /** Height of the sight line above the bore, m. */
  sightHeight: number;
  /** Zero range, m. */
  zeroRange: number;
  /** Rounds per magazine. */
  magazine: number;
}

export interface Atmosphere {
  temperatureC: number;
  pressureHPa: number;
  /** Air density, kg/m^3. */
  density: number;
  /** density / 1.225 (standard sea-level density). */
  densityRatio: number;
  /** Speed of sound, m/s. */
  speedOfSound: number;
}

/** Air velocity in the world frame at a point and time, m/s. */
export type WindField = (pos: Vec3, t: number) => Vec3;
