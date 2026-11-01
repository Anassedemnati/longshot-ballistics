import { createTerrainField } from './terrainField';

// Stage-1 / legacy-URL terrain: thin wrappers over the desert field with seed 1. The height field
// itself (rise, engagement sector, dunes, outcrops) lives in terrainField.ts.
export { RISE_HEIGHT, RISE_RADIUS, smoothstep } from './terrainField';
export type { RockOutcrop } from './terrainField';

export const DESERT_FIELD = createTerrainField('desert', 1);

/** Rock outcrops of the desert field, all outside the engagement sector. */
export const ROCK_OUTCROPS = DESERT_FIELD.outcrops;

/** Ground height at (x, z), m. */
export const terrainHeight = DESERT_FIELD.height;

/** Prone eye position: the top of the rise at the origin plus 0.4 m. */
export const SHOOTER_POS = DESERT_FIELD.shooter;
