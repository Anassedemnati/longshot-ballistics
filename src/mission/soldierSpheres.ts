import type { HitZone, ZoneName } from '../game/hit';
import { SOLDIER_BONES, SOLDIER_RIG } from './soldierRig';

// The soldier's hit spheres on his bones. The spheres are built for a man standing at rest (scene/target.ts, from the old boxes); a soldier who
// runs, crouches or kneels is somewhere else, and a bullet must hit the body that is drawn. So every sphere is hung on a bone: its offset from
// the bone's bind pivot is kept, and each frame the sphere goes wherever the bone's pivot and rotation (the bone transforms of game/ragdoll.ts,
// 7 numbers per bone) carry that offset. With the bones at rest (no rotation, pivots at their bind places) every sphere is where it was built,
// so a soldier that never animates behaves exactly as before.

/** A sphere hung on a bone. */
export interface BoneSphere {
  /** The bone, an index into `SOLDIER_BONES`. */
  bone: number;
  /** The sphere's centre minus the bone's bind pivot, in the body's frame (feet at the origin, +Z forward). */
  ox: number;
  oy: number;
  oz: number;
}

/** A sphere as `dummyHitSpheres()` builds it: in the body's frame, at the body's mid depth (z = 0). */
export interface BodySphere {
  name: ZoneName;
  x: number;
  y: number;
  radius: number;
}

const bone = (name: (typeof SOLDIER_BONES)[number]): number => SOLDIER_BONES.indexOf(name);
const point = (i: number): readonly [number, number, number] => SOLDIER_RIG.particles[i].p;

/** Distance from (x, y, z) to the segment a -> b. */
function toSegment(x: number, y: number, z: number, a: readonly number[], b: readonly number[]): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const abz = b[2] - a[2];
  const l2 = abx * abx + aby * aby + abz * abz;
  const u = l2 > 0 ? Math.min(1, Math.max(0, ((x - a[0]) * abx + (y - a[1]) * aby + (z - a[2]) * abz) / l2)) : 0;
  return Math.hypot(a[0] + abx * u - x, a[1] + aby * u - y, a[2] + abz * u - z);
}

/** Of the bones `names`, the one whose bind segment (origin joint to the joint it points at) is nearest (x, y, z). */
function nearest(x: number, y: number, z: number, names: ReadonlyArray<(typeof SOLDIER_BONES)[number]>): number {
  let best = bone(names[0]);
  let bestD = Infinity;
  for (const name of names) {
    const b = SOLDIER_RIG.bones[bone(name)];
    const d = toSegment(x, y, z, point(b.dirFrom), point(b.dirTo));
    if (d < bestD) {
      bestD = d;
      best = bone(name);
    }
  }
  return best;
}

/**
 * The bone each sphere rides: the head sphere on the head, the upper-torso ones on the chest, the lower-torso ones on the pelvis, and a limb
 * sphere on the nearest bone of the arm (out at the side of the body) or the leg (under the hip) it lies on.
 */
export function attachSpheres(spheres: readonly BodySphere[]): BoneSphere[] {
  return spheres.map((s) => {
    let b: number;
    switch (s.name) {
      case 'head':
        b = bone('head');
        break;
      case 'upperTorso':
        b = bone('chest');
        break;
      case 'lowerTorso':
        b = bone('pelvis');
        break;
      default:
        // The arms hang at x = +-0.27; the legs stand at x = +-0.1. On his left is +X.
        b =
          Math.abs(s.x) >= 0.2
            ? nearest(s.x, s.y, 0, s.x > 0 ? ['upperArmL', 'foreArmL'] : ['upperArmR', 'foreArmR'])
            : nearest(s.x, s.y, 0, s.x > 0 ? ['thighL', 'shinL'] : ['thighR', 'shinR']);
    }
    const pivot = point(SOLDIER_RIG.bones[b].origin);
    return { bone: b, ox: s.x - pivot[0], oy: s.y - pivot[1], oz: 0 - pivot[2] };
  });
}

/**
 * Place every zone's centre for the bone transforms in `bones` (7 numbers per bone: pivot x, y, z, then the rotation x, y, z, w), for a body whose
 * feet are at (`gx`, `gy`, `gz`) turned by `yaw` about +Y. Writes into the zones' own centre objects, makes no new ones.
 */
export function placeSpheres(attached: readonly BoneSphere[], bones: ArrayLike<number>, gx: number, gy: number, gz: number, yaw: number, zones: HitZone[]): void {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  for (let i = 0; i < attached.length; i++) {
    const a = attached[i];
    const o = a.bone * 7;
    const qx = bones[o + 3];
    const qy = bones[o + 4];
    const qz = bones[o + 5];
    const qw = bones[o + 6];
    // v' = v + w t + q x t, with t = 2 (q x v): the offset turned by the bone's rotation.
    const tx = 2 * (qy * a.oz - qz * a.oy);
    const ty = 2 * (qz * a.ox - qx * a.oz);
    const tz = 2 * (qx * a.oy - qy * a.ox);
    const vx = a.ox + qw * tx + (qy * tz - qz * ty);
    const vy = a.oy + qw * ty + (qz * tx - qx * tz);
    const vz = a.oz + qw * tz + (qx * ty - qy * tx);
    // The body's frame, then the world.
    const lx = bones[o] + vx;
    const ly = bones[o + 1] + vy;
    const lz = bones[o + 2] + vz;
    const center = zones[i].center;
    center.x = gx + c * lx + s * lz;
    center.y = gy + ly;
    center.z = gz - s * lx + c * lz;
  }
}

/** The bone index of the head (the soldier's head turns on its own, see scene/ragdollBody.ts). */
export const HEAD_BONE = bone('head');

