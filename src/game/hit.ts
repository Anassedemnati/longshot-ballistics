import type { Vec3 } from '../ballistics/types';

export type ZoneName = 'head' | 'upperTorso' | 'lowerTorso' | 'limbs';

/** A spherical hit volume on a target. */
export interface HitZone {
  name: ZoneName;
  center: Vec3;
  radius: number;
}

export interface HitTarget {
  id: string;
  zones: HitZone[];
}

/** Ground height (y) at a horizontal position. */
export type TerrainHeight = (x: number, z: number) => number;

/**
 * Parameter u in [0, 1] of the first contact of segment a->b with a sphere, or null when the
 * segment never touches it. A segment that starts inside the sphere returns 0.
 */
export function segmentSphere(a: Vec3, b: Vec3, center: Vec3, radius: number): number | null {
  const fx = a.x - center.x;
  const fy = a.y - center.y;
  const fz = a.z - center.z;
  const r2 = radius * radius;
  const f2 = fx * fx + fy * fy + fz * fz;
  if (f2 <= r2) return 0;

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 === 0) return null;

  // Closest approach of the infinite line, measured from the segment start. Working from the
  // closest point (rather than the raw quadratic) avoids cancellation at long range.
  const uClosest = -(fx * dx + fy * dy + fz * dz) / d2;
  const cx = fx + uClosest * dx;
  const cy = fy + uClosest * dy;
  const cz = fz + uClosest * dz;
  const miss2 = cx * cx + cy * cy + cz * cz;
  if (miss2 > r2) return null;

  const u = uClosest - Math.sqrt((r2 - miss2) / d2);
  return u >= 0 && u <= 1 ? u : null;
}
