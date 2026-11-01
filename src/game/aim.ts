import type { Rifle, Vec3 } from '../ballistics/types';

/** Naked-eye vertical field of view, 60 degrees in radians. */
export const NAKED_VFOV_RAD: number = (60 * Math.PI) / 180;

/** Vertical field of view through a scope of the given magnification: 2*atan(tan(naked/2)/mag). */
export function magnificationToVfov(mag: number): number {
  return 2 * Math.atan(Math.tan(NAKED_VFOV_RAD / 2) / mag);
}

/**
 * Screen-space (CSS px) distance from the view centre to an angle of `mils` milliradians, for a
 * perspective camera with vertical FOV `vfovRad` rendered into a viewport `viewportHeightCss` tall.
 */
export function milToPixels(mils: number, vfovRad: number, viewportHeightCss: number): number {
  return (Math.tan(mils * 0.001) / Math.tan(vfovRad / 2)) * (viewportHeightCss / 2);
}

/**
 * Where a shot leaves the rifle. The bore sits `sightHeight` below the eye, along -up, and points
 * along `forward` rotated toward `up` by `zeroElevationRad` about the right axis (forward x up), so
 * a bullet fired this way returns to the line of sight at the zero range.
 *
 * `forward` and `up` should be unit vectors. `up` need not be exactly perpendicular to `forward`
 * (for example world up with a pitched view): the elevation is applied toward the component of
 * `up` perpendicular to `forward`. The bore offset uses `up` as given.
 */
export function muzzleLaunch(
  eye: Vec3,
  forward: Vec3,
  up: Vec3,
  rifle: Rifle,
  zeroElevationRad: number,
): { origin: Vec3; velocity: Vec3 } {
  const origin: Vec3 = {
    x: eye.x - up.x * rifle.sightHeight,
    y: eye.y - up.y * rifle.sightHeight,
    z: eye.z - up.z * rifle.sightHeight,
  };

  const fLen = Math.hypot(forward.x, forward.y, forward.z);
  const fx = forward.x / fLen;
  const fy = forward.y / fLen;
  const fz = forward.z / fLen;

  // Gram-Schmidt: the part of `up` perpendicular to forward. Rotating forward about
  // right = forward x up by e gives forward*cos(e) + (right x forward)*sin(e), and
  // right x forward is exactly this unit vector.
  const dot = up.x * fx + up.y * fy + up.z * fz;
  let ux = up.x - dot * fx;
  let uy = up.y - dot * fy;
  let uz = up.z - dot * fz;
  const uLen = Math.hypot(ux, uy, uz);
  if (!(uLen > 1e-12)) throw new Error('muzzleLaunch: forward and up must not be parallel');
  ux /= uLen;
  uy /= uLen;
  uz /= uLen;

  const c = Math.cos(zeroElevationRad) * rifle.muzzleVelocity;
  const s = Math.sin(zeroElevationRad) * rifle.muzzleVelocity;
  return {
    origin,
    velocity: {
      x: fx * c + ux * s,
      y: fy * c + uy * s,
      z: fz * c + uz * s,
    },
  };
}
