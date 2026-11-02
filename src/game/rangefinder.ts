import type { Vec3 } from '../ballistics/types';
import type { TerrainField } from '../scene/terrainField';
import { segmentBox, segmentSphere } from './hit';
import type { HitTarget, Obstacle } from './hit';

// The rangefinder reading: slant distance from the eye to the first thing along the view ray, whether
// that is the ground, a solid prop or a target. Pure (no three.js), unit-tested in Node.

/** Default reach of the rangefinder, m (past the 1600 m engagement sector). */
export const RANGEFINDER_MAX_RANGE = 3000;
/** The ground is sampled this often along the ray, m; the crossing is then bisected. */
const TERRAIN_STEP = 2;
/** The ground crossing is located to within this distance, m. */
const TERRAIN_TOLERANCE = 0.01;

/**
 * Distance in metres from `origin` along `dir` (any length) to the first hit on the terrain, an
 * obstacle box or a target zone sphere, or null when the ray meets none of them within `maxRange`
 * (aimed at the sky or at ground beyond the reach). Obstacles and targets are tested analytically
 * on the segment origin -> origin + dir * maxRange; the ground is marched and bisected, and only as
 * far as the nearest obstacle or target. A target's zones are tested only when its bounds (if it has
 * any) touch the ray, like the bullets do.
 */
export function rangeUnderCrosshair(
  origin: Vec3,
  dir: Vec3,
  field: TerrainField,
  obstacles: Obstacle[],
  targets: HitTarget[],
  maxRange: number = RANGEFINDER_MAX_RANGE,
): number | null {
  const length = Math.hypot(dir.x, dir.y, dir.z);
  if (!(length > 1e-12) || !(maxRange > 0)) return null;
  const dx = dir.x / length;
  const dy = dir.y / length;
  const dz = dir.z / length;
  const end: Vec3 = { x: origin.x + dx * maxRange, y: origin.y + dy * maxRange, z: origin.z + dz * maxRange };

  // Nearest solid or target contact, as a parameter u of the segment (so distance = u * maxRange).
  let best = Infinity;
  for (let i = 0; i < obstacles.length; i++) {
    const u = segmentBox(origin, end, obstacles[i].box);
    if (u !== null && u < best) best = u;
  }
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const bounds = target.bounds;
    if (bounds !== undefined && segmentSphere(origin, end, bounds.center, bounds.radius) === null) continue;
    for (let k = 0; k < target.zones.length; k++) {
      const zone = target.zones[k];
      const u = segmentSphere(origin, end, zone.center, zone.radius);
      if (u !== null && u < best) best = u;
    }
  }
  let nearest = best * maxRange; // Infinity when nothing was hit

  // The ground, only as far as whatever is already nearer.
  const reach = Math.min(maxRange, nearest);
  const above = (t: number): boolean =>
    origin.y + dy * t > field.height(origin.x + dx * t, origin.z + dz * t);
  if (!above(0)) return 0;
  let lo = 0;
  for (let t = TERRAIN_STEP; ; t += TERRAIN_STEP) {
    const at = Math.min(t, reach);
    if (above(at)) {
      lo = at;
      if (at >= reach) break;
      continue;
    }
    let hi = at;
    while (hi - lo > TERRAIN_TOLERANCE) {
      const mid = 0.5 * (lo + hi);
      if (above(mid)) lo = mid;
      else hi = mid;
    }
    nearest = Math.min(nearest, 0.5 * (lo + hi));
    break;
  }
  return Number.isFinite(nearest) ? nearest : null;
}
