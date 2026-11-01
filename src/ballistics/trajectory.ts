import { DEFAULT_DT, step } from './integrator';
import type { Atmosphere, BulletState, Rifle, WindField } from './types';

export interface RangeSample {
  /** Downrange distance (-z), m. */
  range: number;
  /** Time of flight, s. */
  time: number;
  /** Height relative to the line of sight (y), m. */
  height: number;
  /** Lateral offset (x), m. Positive = toward the shooter's right. */
  windage: number;
  /** Bullet speed (ground frame), m/s. */
  velocity: number;
}

/** Give up on a trajectory after this much flight time, s. */
const MAX_FLIGHT_TIME = 30;

const NO_WIND: WindField = () => ({ x: 0, y: 0, z: 0 });

/**
 * Fire from (0, -sightHeight, 0) along -Z pitched up by elevationRad. The line of sight is the
 * line y = 0. Linearly interpolates between integration steps at each downrange distance
 * (-z = range). Returns one sample per range that was reached, in ascending range order; ranges
 * the bullet never reaches (it stops travelling downrange or exceeds the flight-time cap) are omitted.
 */
export function simulateToRanges(
  rifle: Rifle,
  atmo: Atmosphere,
  wind: WindField,
  elevationRad: number,
  ranges: number[],
): RangeSample[] {
  const targets = [...ranges].sort((a, b) => a - b);
  const samples: RangeSample[] = [];
  if (targets.length === 0) return samples;

  const mv = rifle.muzzleVelocity;
  let s: BulletState = {
    pos: { x: 0, y: -rifle.sightHeight, z: 0 },
    vel: { x: 0, y: mv * Math.sin(elevationRad), z: -mv * Math.cos(elevationRad) },
    t: 0,
  };

  let next = 0;
  while (next < targets.length && s.t < MAX_FLIGHT_TIME && s.vel.z < 0) {
    const prev = s;
    s = step(prev, DEFAULT_DT, rifle.bcG7, atmo, wind);
    const prevRange = -prev.pos.z;
    const range = -s.pos.z;
    while (next < targets.length && range >= targets[next]) {
      const target = targets[next];
      const span = range - prevRange;
      const f = span > 0 ? (target - prevRange) / span : 1;
      const lerp = (a: number, b: number): number => a + (b - a) * f;
      const vx = lerp(prev.vel.x, s.vel.x);
      const vy = lerp(prev.vel.y, s.vel.y);
      const vz = lerp(prev.vel.z, s.vel.z);
      samples.push({
        range: target,
        time: lerp(prev.t, s.t),
        height: lerp(prev.pos.y, s.pos.y),
        windage: lerp(prev.pos.x, s.pos.x),
        velocity: Math.sqrt(vx * vx + vy * vy + vz * vz),
      });
      next++;
    }
  }
  return samples;
}

/** Height above the line of sight at the zero range for a given elevation (no wind). */
function heightAtZeroRange(rifle: Rifle, atmo: Atmosphere, elevationRad: number): number {
  const [sample] = simulateToRanges(rifle, atmo, NO_WIND, elevationRad, [rifle.zeroRange]);
  if (!sample) {
    throw new Error(`bullet never reached zero range ${rifle.zeroRange} m at elevation ${elevationRad} rad`);
  }
  return sample.height;
}

/**
 * Barrel elevation (radians above the line of sight) that puts the bullet back on the line of
 * sight at rifle.zeroRange. The bore starts sightHeight below the LOS; no wind. Bisection to
 * within 0.1 mm at the zero range.
 */
export function findZeroElevation(rifle: Rifle, atmo: Atmosphere): number {
  let lo = -0.01;
  let hi = 0.05;
  const hLo = heightAtZeroRange(rifle, atmo, lo);
  const hHi = heightAtZeroRange(rifle, atmo, hi);
  if (!(hLo < 0 && hHi > 0)) {
    throw new Error(`zero elevation not bracketed in [${lo}, ${hi}] rad (heights ${hLo}, ${hHi} m)`);
  }
  for (let i = 0; i < 100; i++) {
    const mid = 0.5 * (lo + hi);
    const h = heightAtZeroRange(rifle, atmo, mid);
    if (Math.abs(h) < 1e-5) return mid;
    if (h < 0) lo = mid;
    else hi = mid;
  }
  throw new Error('zero elevation bisection did not converge');
}
