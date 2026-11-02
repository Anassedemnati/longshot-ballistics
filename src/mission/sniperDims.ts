import type { Vec3 } from '../ballistics/types';
import type { HitZone, Obstacle, ZoneName } from '../game/hit';

// Pure dimensions of a prone enemy sniper (no three.js): the visible mesh in scene/sniper.ts, the hit
// zones (spheres in chains along each body part) and the mission layout (aim points, bounds, how much
// room the body needs on a roof) are all built from these numbers, so they cannot drift apart.
//
// Local frame: origin on the ground (or the roof) under the sniper's belly, +Z toward the shooter (the
// head end, like the standing dummy's front), +X to the sniper's left, +Y up. A placement turns the
// body by `yaw` about +Y like three.js `rotation.y`: local (x, z) maps to world (c x + s z, -s x + c z).

/** One elongated body part: an ellipsoid with its long axis along local Z. */
export interface SniperPart {
  zone: Exclude<ZoneName, 'engine'>;
  cx: number;
  cy: number;
  cz: number;
  /** Semi-axes along X, Y and Z, m. */
  rx: number;
  ry: number;
  rz: number;
  color: number;
}

export const SNIPER_CLOTH = 0x646449;
export const SNIPER_VEST = 0x454b36;
export const SNIPER_SKIN = 0x9c8768;
export const SNIPER_METAL = 0x313738;

/** The body: chest, hips, two legs, two arms (stretched forward along the rifle) and the head. */
export const SNIPER_PARTS: readonly SniperPart[] = [
  { zone: 'upperTorso', cx: 0, cy: 0.23, cz: -0.35, rx: 0.23, ry: 0.18, rz: 0.35, color: SNIPER_VEST },
  { zone: 'lowerTorso', cx: 0, cy: 0.2, cz: -0.78, rx: 0.19, ry: 0.15, rz: 0.2, color: SNIPER_CLOTH },
  { zone: 'limbs', cx: -0.14, cy: 0.13, cz: -1.24, rx: 0.095, ry: 0.1, rz: 0.37, color: SNIPER_CLOTH },
  { zone: 'limbs', cx: 0.14, cy: 0.13, cz: -1.24, rx: 0.095, ry: 0.1, rz: 0.37, color: SNIPER_CLOTH },
  { zone: 'limbs', cx: -0.25, cy: 0.16, cz: -0.03, rx: 0.075, ry: 0.08, rz: 0.29, color: SNIPER_CLOTH },
  { zone: 'limbs', cx: 0.25, cy: 0.16, cz: -0.03, rx: 0.075, ry: 0.08, rz: 0.29, color: SNIPER_CLOTH },
  { zone: 'head', cx: 0, cy: 0.37, cz: 0.13, rx: 0.12, ry: 0.12, rz: 0.12, color: SNIPER_SKIN },
];

/** The helmet: the upper part of a sphere over the head (decoration, not a hit zone: the head sphere is). */
export const SNIPER_HELMET = { cy: 0.42, cz: 0.13, radius: 0.14, color: SNIPER_CLOTH } as const;

/** The rifle, in its own frame: it pivots about `pivot` when the sniper sweeps his scope. */
export const SNIPER_RIFLE = {
  pivot: { x: 0.12, y: 0.24, z: 0.23 },
  /** Cylinders along Z (barrel and scope tube), relative to the pivot. */
  tubes: [
    { radius: 0.025, length: 0.85, y: 0, z: 0.1 },
    { radius: 0.035, length: 0.24, y: 0.16, z: 0.1 },
  ],
  /** Bipod legs, relative to the pivot: thin cylinders along Y, tilted by `tilt` about Z. */
  bipod: [-1, 1].map((side) => ({ radius: 0.008, length: 0.24, x: side * 0.07, y: -0.1, z: 0.35, tilt: side * 0.3 })),
  /** The glint (the lens catching the sun), relative to the pivot. */
  glint: { x: 0, y: 0.16, z: 0.3 },
  color: SNIPER_METAL,
} as const;

/** The glint's place in the body frame (at rest: the rifle's sweep moves it a few cm). */
export const SNIPER_GLINT_LOCAL: Vec3 = {
  x: SNIPER_RIFLE.pivot.x + SNIPER_RIFLE.glint.x,
  y: SNIPER_RIFLE.pivot.y + SNIPER_RIFLE.glint.y,
  z: SNIPER_RIFLE.pivot.z + SNIPER_RIFLE.glint.z,
};

/** Hit spheres are this much bigger than the cross-section of a part they cover with a chain, as a factor. */
const CHAIN_INFLATE = 1.15;
/** The broad-phase sphere of a sniper is this much bigger than the farthest zone edge, m. */
export const SNIPER_BOUNDS_MARGIN = 0.05;

/** One hit sphere in the sniper's own frame. */
export interface SniperSphere {
  name: Exclude<ZoneName, 'engine'>;
  x: number;
  y: number;
  z: number;
  radius: number;
}

/**
 * The hit spheres of a part: one sphere for a round part (the head), otherwise a chain along the long axis whose
 * spheres are `CHAIN_INFLATE` times the widest cross-section radius, spaced so that no point of the part falls
 * between two of them (the gap between neighbours is 2 * sqrt(R^2 - rho^2) at most). The chain's end spheres sit
 * one cross-section radius inside the ends of the part.
 */
function chainOf(part: SniperPart): SniperSphere[] {
  const rho = Math.max(part.rx, part.ry);
  if (part.rz <= rho * 1.0001) {
    return [{ name: part.zone, x: part.cx, y: part.cy, z: part.cz, radius: rho }];
  }
  const radius = rho * CHAIN_INFLATE;
  const spacing = 2 * Math.sqrt(radius * radius - rho * rho);
  const span = 2 * (part.rz - rho);
  const n = Math.max(1, Math.ceil(span / spacing) + 1);
  const out: SniperSphere[] = [];
  for (let k = 0; k < n; k++) {
    const z = n === 1 ? part.cz : part.cz - (part.rz - rho) + (span * k) / (n - 1);
    out.push({ name: part.zone, x: part.cx, y: part.cy, z, radius });
  }
  return out;
}

const ZONE_ORDER: Record<Exclude<ZoneName, 'engine'>, number> = { head: 0, upperTorso: 1, lowerTorso: 2, limbs: 3 };

let spheres: SniperSphere[] | null = null;

/** Every hit sphere of a sniper in its own frame (built once). The head comes first, then the upper torso. */
export function sniperHitSpheres(): readonly SniperSphere[] {
  spheres ??= [...SNIPER_PARTS]
    .sort((a, b) => ZONE_ORDER[a.zone] - ZONE_ORDER[b.zone])
    .flatMap((part) => chainOf(part));
  return spheres;
}

/** The head and upper-torso centres in the body frame (what a shooter aims at). */
export const SNIPER_HEAD_LOCAL: Vec3 = (() => {
  const p = SNIPER_PARTS.find((q) => q.zone === 'head');
  if (!p) throw new Error('sniper has no head');
  return { x: p.cx, y: p.cy, z: p.cz };
})();
export const SNIPER_TORSO_LOCAL: Vec3 = (() => {
  const p = SNIPER_PARTS.find((q) => q.zone === 'upperTorso');
  if (!p) throw new Error('sniper has no upper torso');
  return { x: p.cx, y: p.cy, z: p.cz };
})();

/**
 * Box around the whole prone body, rifle and helmet included, in the body frame: what the layout tests against
 * the colliders (is it standing in a wall?) and what it counts as when it hides another target.
 */
export const SNIPER_BOUNDS = ((): { cx: number; cy: number; cz: number; hx: number; hy: number; hz: number } => {
  let lo = { x: Infinity, y: Infinity, z: Infinity };
  let hi = { x: -Infinity, y: -Infinity, z: -Infinity };
  const grow = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void => {
    lo = { x: Math.min(lo.x, x0), y: Math.min(lo.y, y0), z: Math.min(lo.z, z0) };
    hi = { x: Math.max(hi.x, x1), y: Math.max(hi.y, y1), z: Math.max(hi.z, z1) };
  };
  for (const p of SNIPER_PARTS) grow(p.cx - p.rx, p.cy - p.ry, p.cz - p.rz, p.cx + p.rx, p.cy + p.ry, p.cz + p.rz);
  const h = SNIPER_HELMET;
  grow(-h.radius, h.cy - h.radius * 0.2, h.cz - h.radius, h.radius, h.cy + h.radius, h.cz + h.radius);
  // The rifle may be swung by 0.3 rad: take the muzzle's reach to either side.
  const { pivot, tubes } = SNIPER_RIFLE;
  const reachZ = Math.max(...tubes.map((t) => t.z + t.length / 2));
  const reachBack = Math.min(...tubes.map((t) => t.z - t.length / 2));
  const swing = Math.sin(0.3) * reachZ;
  grow(pivot.x - swing - 0.04, pivot.y - 0.14, pivot.z + reachBack, pivot.x + swing + 0.04, pivot.y + 0.22, pivot.z + reachZ);
  return {
    cx: (lo.x + hi.x) / 2,
    cy: (lo.y + hi.y) / 2,
    cz: (lo.z + hi.z) / 2,
    hx: (hi.x - lo.x) / 2,
    hy: (hi.y - lo.y) / 2,
    hz: (hi.z - lo.z) / 2,
  };
})();

/** Farthest horizontal distance of the body (rifle included) from the origin, m: the room it needs on a roof. */
export const SNIPER_REACH = ((): number => {
  const b = SNIPER_BOUNDS;
  let r = 0;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) r = Math.max(r, Math.hypot(b.cx + sx * b.hx, b.cz + sz * b.hz));
  return r;
})();

/** Where a sniper lies: (x, z) on the ground or a roof at height y (the surface under the belly), turned by yaw. */
export interface SniperPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** A point of the body frame in the world. */
export function sniperWorldPoint(pose: SniperPose, local: Vec3): Vec3 {
  const c = Math.cos(pose.yaw);
  const s = Math.sin(pose.yaw);
  return { x: pose.x + c * local.x + s * local.z, y: pose.y + local.y, z: pose.z - s * local.x + c * local.z };
}

/** The hit zones of a sniper at `pose`, in the world. */
export function sniperZones(pose: SniperPose): HitZone[] {
  return sniperHitSpheres().map((s) => ({
    name: s.name,
    radius: s.radius,
    center: sniperWorldPoint(pose, s),
  }));
}

/** World points a shooter aims at: the head and the upper-torso centres. */
export function sniperAimPoints(pose: SniperPose): { head: Vec3; upperTorso: Vec3 } {
  return { head: sniperWorldPoint(pose, SNIPER_HEAD_LOCAL), upperTorso: sniperWorldPoint(pose, SNIPER_TORSO_LOCAL) };
}

/** The body's bounds as a collider-shaped box (see SNIPER_BOUNDS). Never test it against the sniper's own aim points. */
export function sniperBoundsObstacle(pose: SniperPose, id: string): Obstacle {
  const b = SNIPER_BOUNDS;
  return {
    id: `${id}:bounds`,
    material: 'metal',
    box: {
      center: sniperWorldPoint(pose, { x: b.cx, y: b.cy, z: b.cz }),
      halfSize: { x: b.hx, y: b.hy, z: b.hz },
      yaw: pose.yaw,
    },
  };
}
