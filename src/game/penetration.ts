import type { Vec3 } from '../ballistics/types';
import { boxExitDistance } from './hit';
import type { Box, HitZone } from './hit';

// A rifle bullet does not stop in a person: it goes through (a .308 or .338 keeps well over half its speed after a torso) and carries on,
// a little slower and a little off its line. This is the pure maths of that: where the bullet leaves the body, how it flies on, whether
// it still downs a second man, and how a heavy anti-materiel bullet punches through a vehicle's skin.
//
// The speed lost is set by momentum. A body (or a sheet of steel) takes a roughly fixed impulse out of a bullet, so the share of its
// speed a bullet keeps is 1 - J / (m v): a light, slowing round loses a lot, a 49 g .50 BMG bullet hardly notices a man. The impulses
// are tuned on the original .308 (KEEP_MIN..KEEP_MAX through a body at the reference speed), not measured.

/** Zone spheres closer than this along the path still count as one body (the spheres only blanket the surface), m. */
const GAP = 0.05;
/** The farthest a bullet is followed through a body, m. */
export const MAX_THROUGH_M = 1.2;
/** The share of its speed the reference .308 bullet keeps after a body at the reference speed: between these. */
export const KEEP_MIN = 0.6;
export const KEEP_MAX = 0.75;
/** The reference: the .308's 175 gr (11.34 g) bullet striking at 700 m/s (a few hundred metres out). */
export const REFERENCE_MASS_G = 11.34;
export const REFERENCE_SPEED = 700;
/** Momentum of the reference bullet, kg m/s: the impulse of a body is a share of it. */
const REFERENCE_MOMENTUM = (REFERENCE_MASS_G / 1000) * REFERENCE_SPEED;
/**
 * The share of the reference momentum a vehicle's skin takes (sheet steel, the wall behind it, what is inside): over 1, so a .308 stops
 * in it and a .338 dribbles out spent, while a .50 BMG keeps about three quarters of its speed and a .408 a little over half. Only the
 * anti-materiel calibres (`Rifle.antiMateriel`) are let through at all (run.ts).
 */
const METAL_LOSS_MIN = 0.95;
const METAL_LOSS_MAX = 1.2;
/** Nothing keeps more than this share of its speed through anything. */
const KEEP_CEILING = 0.95;
/** A bullet slower than this after a body or a plate is not worth following (it tumbles and drops close by), m/s. */
export const MIN_THROUGH_SPEED = 150;
/** A bullet that has gone through one man still downs a second one if it carries at least this much energy, J. */
export const SECOND_KILL_ENERGY_J = 1500;
/** A punched-through bullet comes out this far past the far face of the box, m (clear of it, so it cannot strike it again). */
const CLEAR_OF_FACE_M = 0.02;
/** Sideways scatter of the way out, as a share of the speed (about 2 degrees either way). */
const SCATTER = 0.035;

/**
 * Where a bullet that struck a zone at `entry` and travels along the unit vector `dir` leaves the target: the far end of the run of zone
 * spheres it passes through, at most MAX_THROUGH_M on (a body is not a mile long). A grazing hit comes out near where it went in.
 */
export function exitPoint(zones: readonly HitZone[], entry: Vec3, dir: Vec3, maxLength: number = MAX_THROUGH_M): Vec3 {
  const spans: Array<[number, number]> = [];
  for (const zone of zones) {
    const fx = entry.x - zone.center.x;
    const fy = entry.y - zone.center.y;
    const fz = entry.z - zone.center.z;
    const b = fx * dir.x + fy * dir.y + fz * dir.z;
    const c = fx * fx + fy * fy + fz * fz - zone.radius * zone.radius;
    const disc = b * b - c;
    if (disc < 0) continue;
    const root = Math.sqrt(disc);
    const t1 = -b + root;
    if (t1 <= 0) continue; // behind the entry
    spans.push([Math.max(0, -b - root), t1]);
  }
  spans.sort((p, q) => p[0] - q[0]);
  let end = 0;
  for (const [t0, t1] of spans) {
    if (t0 > end + GAP) break;
    end = Math.max(end, t1);
    if (end >= maxLength) {
      end = maxLength;
      break;
    }
  }
  return { x: entry.x + dir.x * end, y: entry.y + dir.y * end, z: entry.z + dir.z * end };
}

/**
 * The share of its speed a bullet of `massG` g striking at `speed` m/s keeps after something that takes `loss` (a share of the
 * reference momentum) out of it: 1 - loss * p_ref / p, between 0 and KEEP_CEILING.
 */
function keepShare(massG: number, speed: number, loss: number): number {
  const momentum = (massG / 1000) * speed;
  if (!(momentum > 0)) return 0;
  return Math.min(KEEP_CEILING, Math.max(0, 1 - (loss * REFERENCE_MOMENTUM) / momentum));
}

/** `v` scaled by `keep`, nudged a hair off its line (`rng` gives numbers in [0, 1)). */
function deflected(v: Vec3, keep: number, rng: () => number): Vec3 {
  const speed = Math.hypot(v.x, v.y, v.z);
  const scatter = (): number => (rng() * 2 - 1) * SCATTER * speed * keep;
  return { x: v.x * keep + scatter(), y: v.y * keep + scatter(), z: v.z * keep + scatter() };
}

/**
 * The velocity of a bullet of `massG` g (default: the .308's) that has come out of a body, a hair off its line (`rng` gives numbers in
 * [0, 1)). The reference .308 at 700 m/s keeps 60-75 % of its speed; a heavier or faster bullet keeps more (a .50 BMG about 95 %), a
 * light one that has slowed far out keeps less.
 */
export function continuedVelocity(v: Vec3, rng: () => number, massG: number = REFERENCE_MASS_G): Vec3 {
  const loss = 1 - (KEEP_MIN + (KEEP_MAX - KEEP_MIN) * rng()); // 0.25 .. 0.4 of the reference momentum
  return deflected(v, keepShare(massG, Math.hypot(v.x, v.y, v.z), loss), rng);
}

/** Kinetic energy of a bullet of `massG` g at velocity `v`, J. */
export function bulletEnergy(massG: number, v: Vec3): number {
  return 0.5 * (massG / 1000) * (v.x * v.x + v.y * v.y + v.z * v.z);
}

/**
 * Whether a bullet that has already gone through one man still downs the next one it strikes: it does while it carries
 * SECOND_KILL_ENERGY_J. A .50 BMG, a .408 or a 12.7 mm bullet does at any range; a .338 close in; a .308 almost never.
 */
export function downsSecondTarget(massG: number, v: Vec3): boolean {
  return bulletEnergy(massG, v) >= SECOND_KILL_ENERGY_J;
}

/** A bullet flying on: where it starts and its velocity. */
export interface Continuation {
  origin: Vec3;
  velocity: Vec3;
}

/**
 * A heavy bullet that struck a vehicle's skin (a `metal` box) at `entry` with velocity `v`: it punches through the box and comes out
 * past its far face, slower (see METAL_LOSS_MIN..MAX) and a hair off its line. The vehicle boxes are hollow shells, so the box's depth
 * costs nothing more. Null when it does not get through with MIN_THROUGH_SPEED left (a light or a slow bullet stops in the steel).
 */
export function punchThrough(box: Box, entry: Vec3, v: Vec3, massG: number, rng: () => number): Continuation | null {
  const speed = Math.hypot(v.x, v.y, v.z);
  if (!(speed > 0)) return null;
  const keep = keepShare(massG, speed, METAL_LOSS_MIN + (METAL_LOSS_MAX - METAL_LOSS_MIN) * rng());
  if (keep * speed < MIN_THROUGH_SPEED) return null;
  const dir = { x: v.x / speed, y: v.y / speed, z: v.z / speed };
  const out = boxExitDistance(box, entry, dir) + CLEAR_OF_FACE_M;
  return {
    origin: { x: entry.x + dir.x * out, y: entry.y + dir.y * out, z: entry.z + dir.z * out },
    velocity: deflected(v, keep, rng),
  };
}
