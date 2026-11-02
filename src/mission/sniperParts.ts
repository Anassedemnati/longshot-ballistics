import type { ZoneName } from '../game/hit';

// The prone sniper's body parts: pure data with no imports of its own, so scripts/gen-sniper-spheres.mjs can
// load it straight from Node. mission/sniperDims.ts re-exports everything here and builds the hit spheres,
// the bounds and the pose maths from it; scene/sniper.ts draws the same ellipsoids.
//
// Local frame: origin on the ground (or the roof) under the sniper's belly, +Z toward the shooter (the
// head end, like the standing dummy's front), +X to the sniper's left, +Y up.

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
