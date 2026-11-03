import type { Vec3 } from '../ballistics/types';

// Pure sound timing and level maths (no DOM, no three.js): unit-tested in Node. The Web Audio code
// in engine.ts / sounds.ts only turns these numbers into nodes.

/** Distance below which an impact sounds as loud and bright as it gets, m. */
const NEAR_RANGE_M = 100;
/** Distance at and beyond which an impact is as dull as it gets, m. */
const FAR_RANGE_M = 1500;
/** Low-pass cutoff of an impact heard from NEAR_RANGE_M, Hz. */
const NEAR_CUTOFF_HZ = 4000;
/** Low-pass cutoff of an impact heard from FAR_RANGE_M, Hz. */
const FAR_CUTOFF_HZ = 800;
/** Distance at which an impact is half as loud as at the shooter's feet, m. */
const HALF_LEVEL_M = 300;

/** Euclidean distance between two points, m. */
export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
}

/** Seconds sound takes to travel between two points at `speedOfSound` m/s. */
export function soundTravelTime(from: Vec3, to: Vec3, speedOfSound: number): number {
  return distance(from, to) / speedOfSound;
}

/**
 * Delay after an impact event before the listener hears it, s. The event already fires at the
 * bullet's arrival, so only the sound's trip back to the shooter is left.
 */
export function impactSoundDelay(impactPoint: Vec3, listener: Vec3, speedOfSound: number): number {
  return soundTravelTime(impactPoint, listener, speedOfSound);
}

/** Linear loudness factor of an impact heard from `distanceM`: 1 up close, 1/2 at 300 m, ~1/6 at 1500 m. */
export function distanceGain(distanceM: number): number {
  const d = Number.isFinite(distanceM) ? Math.max(0, distanceM) : 0;
  return 1 / (1 + d / HALF_LEVEL_M);
}

/**
 * Loudness factor of a recorded impact heard from `distanceM`, 0..1: full strength up to 100 m, then
 * the `distanceGain` falloff relative to 100 m (about 0.36 at 800 m and 0.22 at 1500 m).
 */
export function impactGain(distanceM: number): number {
  return Math.min(1, distanceGain(distanceM) / distanceGain(NEAR_RANGE_M));
}

/** Low-pass cutoff for an impact heard from `distanceM`, Hz: 4 kHz at 100 m falling to 800 Hz at 1500 m. */
export function distanceCutoffHz(distanceM: number): number {
  const d = Number.isFinite(distanceM) ? distanceM : 0;
  const u = Math.min(1, Math.max(0, (d - NEAR_RANGE_M) / (FAR_RANGE_M - NEAR_RANGE_M)));
  return NEAR_CUTOFF_HZ + (FAR_CUTOFF_HZ - NEAR_CUTOFF_HZ) * u;
}
