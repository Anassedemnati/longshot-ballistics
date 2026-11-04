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
  /** Bullet mass, g. Sets how much speed it keeps through a body or a vehicle's skin (game/penetration.ts). */
  bulletMassG: number;
  /** How the next round is chambered: by hand (`bolt`) or by the gas of the shot (`semi`, no bolt handle to work). */
  action: 'bolt' | 'semi';
  /** Lockout after a shot that leaves rounds in the magazine, s: working the bolt, or the semi-automatic action cycling. */
  boltTimeS: number;
  /** Time to swap the magazine, s. Longer than `boltTimeS` (a reload can start mid-cycle and outlasts it). */
  reloadTimeS: number;
  /** Recoil scale of the first-person kick and the scope jump: 1 for the .308, about 2.5 for the 12.7 mm rifles. */
  recoil: number;
  /** Built round its suppressor: every shot is suppressed and the mission's suppressor switch is locked on. */
  integralSuppressor: boolean;
  /** Heavy anti-materiel bullet: it punches through vehicle skins (`metal` obstacles), losing speed, and on into what is behind. */
  antiMateriel: boolean;
  /** Farthest target band the mission allows with it, m (the subsonic round must stay inside the reticle's 10-mil hold). */
  maxRangeM: number;
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
