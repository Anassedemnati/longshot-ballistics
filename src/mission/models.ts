// Sizes of the vegetation and rock models in their own frames (pure numbers, no three.js): the placement
// (scatter.ts, nestPlan.ts) plans with them and the meshes (scene/vegetation.ts, scene/nest.ts) are built or
// normalised to them, so a plan's footprints and heights hold for what is drawn.

/** The boulder model (boulder2.glb, or the procedural rock standing in for it): centred, base at y = 0, m. */
export const BOULDER_UNIT = { lx: 2.514, ly: 0.88, lz: 1.232 } as const;
/** The fallen-log model (dead_tree.glb), lying along x, centred, base at y = 0, m. */
export const LOG_UNIT = { length: 3.05, radius: 0.15 } as const;
/** A standing snag (procedural) at scale 1: height, base radius and the reach of its branch stubs, m. */
export const SNAG_UNIT = { height: 4.6, radius: 0.28, reach: 1.7 } as const;
/** The grass clump variants (grass_clump.glb's mid_a, mid_b and mid_c), base at y = 0, centred: footprint radius and height at scale 1, m. */
export const GRASS_UNIT: ReadonlyArray<{ radius: number; height: number }> = [
  { radius: 0.16, height: 0.22 },
  { radius: 0.14, height: 0.18 },
  { radius: 0.14, height: 0.15 },
];
