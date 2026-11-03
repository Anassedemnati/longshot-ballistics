// How the enemy models are painted (pure data, no three.js): the soldier and the prone sniper are each ONE mesh
// with ONE material, so what makes a cheek look like skin, a rifle like steel and a sleeve like camo cloth is a
// per-vertex "surface" (the fraction of camo texture, the roughness, the metalness, the strength of the cloth
// normal map) next to the vertex colour (the tint that multiplies the camo, or the flat colour of a plain surface).
// scene/enemyParts.ts writes these numbers into a vertex attribute and scene/enemyMaterial.ts reads them back in
// the fragment shader; scene/enemyTextures.ts paints the camo and the cloth normal map.

/** The kinds of surface an enemy is made of. */
export type SurfaceKey =
  | 'camo' // printed field uniform: the camo texture, tinted
  | 'cloth' // plain dyed cloth (scarf, gloves, hood lining): flat colour with the weave
  | 'gear' // webbing, plate carrier, pouches, pack: flat, slightly coarse
  | 'skin' // face, neck, hands
  | 'metal' // rifle steel, scope tube: dark, shiny
  | 'polymer' // rifle furniture, boots, rubber: dark, semi-matt
  | 'glass' // sunglasses, scope lenses
  | 'strand'; // ghillie jute: shaggy, matt, no normal map

/** One surface: the numbers a vertex carries. */
export interface SurfaceDef {
  /** 0..1: how much of the camo texture multiplies the vertex colour (0 = the plain vertex colour). */
  camo: number;
  /** Microfacet roughness, 0..1. */
  roughness: number;
  /** 0 (dielectric) .. 1 (metal). */
  metalness: number;
  /** 0..1: how much of the cloth normal map shows (skin and steel are smooth). */
  bump: number;
}

/** Every surface (see SurfaceKey). Roughness 0.85-0.95 on the cloth, as real fabric scatters the light. */
export const SURFACES: Readonly<Record<SurfaceKey, SurfaceDef>> = {
  camo: { camo: 1, roughness: 0.92, metalness: 0, bump: 1 },
  cloth: { camo: 0, roughness: 0.93, metalness: 0, bump: 0.9 },
  gear: { camo: 0, roughness: 0.88, metalness: 0, bump: 0.8 },
  skin: { camo: 0, roughness: 0.62, metalness: 0, bump: 0.12 },
  metal: { camo: 0, roughness: 0.42, metalness: 0.85, bump: 0.1 },
  polymer: { camo: 0, roughness: 0.62, metalness: 0, bump: 0.3 },
  glass: { camo: 0, roughness: 0.12, metalness: 0.3, bump: 0 },
  strand: { camo: 0, roughness: 0.97, metalness: 0, bump: 0 },
};

/** The camo's four tones (sRGB hex) and their share of the cloth, by thresholds of the noise fields in enemyTextures. */
export const CAMO_TONES = {
  /** The ground tone of the cloth: a dry khaki. */
  base: 0x7a6a49,
  /** The light blotches: sandy tan. */
  tan: 0x8e7e5a,
  /** The dark blotches: brown. */
  brown: 0x5d4e36,
  /** The olive blotches: dusty green. */
  olive: 0x666141,
} as const;

/** Tile of the camo and cloth textures on the model, m (texture coordinates are box-projected at this size). */
export const ENEMY_UV_TILE_M = 1;
