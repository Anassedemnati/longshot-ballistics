import type { Vec3 } from '../ballistics/types';
import type { HitZone } from './hit';

// A rifle bullet does not stop in a person: it goes through (a .308 or .338 keeps well over half its speed after a torso) and carries on,
// a little slower and a little off its line. This is the pure maths of that: where the bullet leaves the body, and how it flies on.

/** Zone spheres closer than this along the path still count as one body (the spheres only blanket the surface), m. */
const GAP = 0.05;
/** The farthest a bullet is followed through a body, m. */
export const MAX_THROUGH_M = 1.2;
/** The share of its speed a bullet keeps after a body: between these. */
export const KEEP_MIN = 0.6;
export const KEEP_MAX = 0.75;
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

/** The velocity of a bullet that has come out of a body: slower by 25-40 %, a hair off its line (`rng` gives numbers in [0, 1)). */
export function continuedVelocity(v: Vec3, rng: () => number): Vec3 {
  const keep = KEEP_MIN + (KEEP_MAX - KEEP_MIN) * rng();
  const speed = Math.hypot(v.x, v.y, v.z);
  const scatter = (): number => (rng() * 2 - 1) * SCATTER * speed;
  return { x: v.x * keep + scatter(), y: v.y * keep + scatter(), z: v.z * keep + scatter() };
}
