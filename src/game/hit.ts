import type { Vec3 } from '../ballistics/types';

export type ZoneName = 'head' | 'upperTorso' | 'lowerTorso' | 'limbs' | 'engine';

/** A spherical hit volume on a target. */
export interface HitZone {
  name: ZoneName;
  center: Vec3;
  radius: number;
}

export interface HitTarget {
  id: string;
  zones: HitZone[];
  /**
   * Optional broad-phase sphere. When present, BulletSystem skips this target's zones unless the
   * substep segment touches it, so it must enclose every zone. Omit it to test every zone.
   */
  bounds?: { center: Vec3; radius: number };
}

/** What a solid obstacle is made of; decides the impact effect. */
export type Material = 'wall' | 'metal';

/**
 * An oriented box. `yaw` is a rotation about +Y, right-handed like three.js `rotation.y`: local to
 * world is R_y(yaw), so local +X maps to world (cos yaw, 0, -sin yaw) and local +Z to (sin yaw, 0, cos yaw).
 */
export interface Box {
  center: Vec3;
  halfSize: Vec3;
  yaw: number;
}

/**
 * Solid cover that stops bullets. Treat it as immutable once handed to BulletSystem: the system
 * caches its bounding sphere per object.
 */
export interface Obstacle {
  id: string;
  material: Material;
  box: Box;
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

/**
 * Parameter u in [0, 1] of the first contact of segment a->b with an oriented box, or null when the
 * segment never touches it. A segment that starts inside the box returns 0.
 *
 * Slab test in the box's local frame: the segment is moved to the centre and rotated by R_y(-yaw).
 * Allocation-free, because BulletSystem calls it per bullet per substep.
 */
export function segmentBox(a: Vec3, b: Vec3, box: Box): number | null {
  const c = Math.cos(box.yaw);
  const s = Math.sin(box.yaw);
  const ax0 = a.x - box.center.x;
  const az0 = a.z - box.center.z;
  const bx0 = b.x - box.center.x;
  const bz0 = b.z - box.center.z;
  // World -> local is R_y(-yaw): x' = c x - s z, z' = s x + c z.
  const ax = c * ax0 - s * az0;
  const az = s * ax0 + c * az0;
  const ay = a.y - box.center.y;
  const dx = c * bx0 - s * bz0 - ax;
  const dz = s * bx0 + c * bz0 - az;
  const dy = b.y - box.center.y - ay;

  let u0 = 0;
  let u1 = 1;
  // Each axis narrows [u0, u1] to the part of the segment between that axis's two slab planes.
  for (let axis = 0; axis < 3; axis++) {
    const p = axis === 0 ? ax : axis === 1 ? ay : az;
    const d = axis === 0 ? dx : axis === 1 ? dy : dz;
    const h = axis === 0 ? box.halfSize.x : axis === 1 ? box.halfSize.y : box.halfSize.z;
    if (d === 0) {
      // Parallel to this slab: inside it for the whole segment or never (a face plane counts as inside).
      if (p > h || p < -h) return null;
      continue;
    }
    let t0 = (-h - p) / d;
    let t1 = (h - p) / d;
    if (t0 > t1) {
      const t = t0;
      t0 = t1;
      t1 = t;
    }
    if (t0 > u0) u0 = t0;
    if (t1 < u1) u1 = t1;
    if (u0 > u1) return null;
  }
  return u0;
}

/** Bounding-sphere radius (half diagonal) per obstacle object; rotation does not change it. */
const boundingRadii = new WeakMap<Obstacle, number>();

/**
 * Radius of the sphere around `obstacle.box.center` that encloses the box at any yaw. Computed
 * once per Obstacle object and cached on its identity.
 */
export function obstacleBoundingRadius(obstacle: Obstacle): number {
  let radius = boundingRadii.get(obstacle);
  if (radius === undefined) {
    const h = obstacle.box.halfSize;
    radius = Math.hypot(h.x, h.y, h.z);
    boundingRadii.set(obstacle, radius);
  }
  return radius;
}
