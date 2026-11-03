import type { SurfaceKey } from './enemySurface';

// The drawing vocabulary of the enemy models, as plain data (no three.js): scene/enemyParts.ts turns each part into
// triangles. The soldier (soldierModel.ts) and the sniper (sniperModel.ts) are lists of these. Local frame of a model:
// origin at the feet (soldier) or on the ground under the belly (sniper), +Z toward the shooter, +Y up, +X to the
// model's left. Nothing here is a hit zone: the hit spheres come from dummyDims.ts and sniperParts.ts, and the tests
// check that what is drawn covers them.

/** A point or vector, m. */
export type V3 = readonly [number, number, number];

/**
 * What a part of a ragdolling model is bound to: one bone (by name), or a blend of two along an axis (`from` -> `to` is the span, in metres,
 * over which the weight moves from `low` to `high`), so a waist bends instead of cracking.
 */
export type SkinBinding = string | { low: string; high: string; axis: 0 | 1 | 2; from: number; to: number };

interface PartBase {
  surface: SurfaceKey;
  /** The tint (sRGB hex): the plain colour of a flat surface, the multiplier on the camo of a camo one. */
  color: number;
  /** The bone(s) that carry this part when the body goes limp (see scene/ragdollBody.ts). A name ending in L or R swaps sides when the part is mirrored. */
  skin?: SkinBinding;
}

/** A tapered capsule (round cone with hemispherical ends) from `a` to `b`: radii `ra` and `rb`; `sx`/`sz` squash its cross-section. */
export interface TubePart extends PartBase {
  kind: 'tube';
  a: V3;
  b: V3;
  ra: number;
  rb: number;
  sx?: number;
  sz?: number;
  sides?: number;
  /** Rings in each rounded end (default 1). */
  caps?: number;
}

/** An ellipsoid with half-axes `r` at `c`, turned by the Euler angles `rot` (XYZ order, rad). */
export interface EllipsoidPart extends PartBase {
  kind: 'ellipsoid';
  c: V3;
  r: V3;
  rot?: V3;
  /** Tessellation: 1 is 12 segments around by 7 pole to pole (144 triangles); the default 0.8 is 8 by 6 (80). */
  detail?: number;
}

/** A box of `size` with edges rounded to `radius`, at `c`, turned by `rot`. */
export interface BoxPart extends PartBase {
  kind: 'box';
  c: V3;
  size: V3;
  radius: number;
  rot?: V3;
}

/** A solid of revolution about +Y from `profile` ((radius, height) pairs, bottom to top), scaled, turned and moved to `c`. */
export interface LathePart extends PartBase {
  kind: 'lathe';
  profile: ReadonlyArray<readonly [number, number]>;
  c: V3;
  scale?: V3;
  rot?: V3;
  sides?: number;
}

export type ModelPart = TubePart | EllipsoidPart | BoxPart | LathePart;

/** A rigid frame (an assembly's own axes: the soldier's rifle is built along +Z and then laid in his hands). */
export interface ModelFrame {
  origin: V3;
  x: V3;
  y: V3;
  z: V3;
}

/** A group of parts, optionally placed through a frame. */
export interface ModelGroup {
  frame?: ModelFrame;
  parts: readonly ModelPart[];
}

const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
};

/**
 * The frame whose +Z points along `forward` (not necessarily a unit vector) and whose +Y is as close to `up` as that allows,
 * with its origin at `origin`: x = up cross z, so a part built "pointing +Z, top at +Y" ends up pointing along `forward`.
 */
export function frameAlong(origin: V3, forward: V3, up: V3 = [0, 1, 0]): ModelFrame {
  const z = norm(forward);
  const x = norm(cross(up, z));
  const y = cross(z, x);
  return { origin, x, y, z };
}

/** The bone name of the opposite side (a trailing L becomes R and the other way round). */
function mirrorBone(name: string): string {
  return /[LR]$/.test(name) ? name.slice(0, -1) + (name.endsWith('L') ? 'R' : 'L') : name;
}

function mirrorSkin(skin: SkinBinding | undefined): SkinBinding | undefined {
  if (skin === undefined) return undefined;
  return typeof skin === 'string' ? mirrorBone(skin) : { ...skin, low: mirrorBone(skin.low), high: mirrorBone(skin.high) };
}

/** A part of the model's right side mirrored to its left (x negated; the turns about y and z flip with it). */
export function mirrorX(part: ModelPart): ModelPart {
  const mirrored = mirrorOne(part);
  return part.skin === undefined ? mirrored : { ...mirrored, skin: mirrorSkin(part.skin) };
}

function mirrorOne(part: ModelPart): ModelPart {
  const flip = (p: V3): V3 => [-p[0], p[1], p[2]];
  const turn = (r: V3 | undefined): V3 | undefined => (r ? [r[0], -r[1], -r[2]] : undefined);
  switch (part.kind) {
    case 'tube':
      return { ...part, a: flip(part.a), b: flip(part.b) };
    case 'ellipsoid':
      return { ...part, c: flip(part.c), rot: turn(part.rot) };
    case 'box':
      return { ...part, c: flip(part.c), rot: turn(part.rot) };
    case 'lathe':
      return { ...part, c: flip(part.c), rot: turn(part.rot) };
  }
}

/** The part and its mirror image (for a symmetric pair: both legs, both shoulder pads). */
export function pair(part: ModelPart): ModelPart[] {
  return [part, mirrorX(part)];
}
