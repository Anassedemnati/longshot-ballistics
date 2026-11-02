import * as THREE from 'three';
import type { ThemeId } from '../mission/themes';
import { groundRelief } from './detail';

// The terrain's material: MeshStandardMaterial patched with onBeforeCompile. Two looks share one program per theme:
//  - the FALLBACK look (flat theme colour, procedural bump relief, world-space mottling, slope rock tint): what the
//    terrain shows until the photographic textures arrive, and for good if one of them fails to load;
//  - the PBR look (define TERRAIN_PBR, switched on by `applyTerrainTextures` once every map is in): Poly Haven diffuse,
//    normal and roughness maps blended by slope and height. Rock uses triplanar mapping so cliffs never stretch; ground
//    is mapped from above; a detail scale near and a macro scale far (blended by the pixel's footprint on the ground, so a
//    scope zoomed on a far target keeps its detail) kill the tiling, and a 300 m modulation breaks up the far flat colour.
//    Arctic and valley get snow caps on high ground that is not too steep.
// Both looks multiply the baked lighting from the `bake` vertex attribute (terrain.ts): sun visibility into the direct light,
// ambient occlusion into the indirect light, so the walls shade the valley at the sun's real angle.
// The mesh sits at the origin, so object space is world space.

/** What the terrain shader needs of a theme, besides its textures. */
export interface TerrainMaterialLook {
  /** Texture sets under assets/textures/ (`<name>_diff|nor|rough.jpg`): the ground (sand, snow, grass), the cliff rock and the optional snow cap. */
  ground: string;
  rock: string;
  cap: string | null;
  /** One tile covers this many metres: the ground detail, the second (turned) copy of the ground detail mixed in against repetition, the rock detail, the rock macro. */
  tileM: readonly [number, number, number, number];
  /** Flat colour of the fallback look, roughly the ground texture's average. */
  fallbackColor: number;
  /** Fallback roughness and bump relief (strength, tile in metres). */
  roughness: number;
  bumpScale: number;
  bumpTileM: number;
  /** Linear multipliers on the textures: the ground, the rock and the snow cap pick up the theme's colour. */
  groundTint: readonly [number, number, number];
  rockTint: readonly [number, number, number];
  capTint: readonly [number, number, number];
  /** 0..1: how far the rock texture is pulled towards grey before its tint (the orange cliff texture becomes granite). */
  rockDesaturate: number;
  /** The darkest marks of the ground texture (footprints, holes) are lifted to this share of its mean brightness: repeated, they would read as a pattern. */
  detailFloor: number;
  /** Fallback rock tint colour (sRGB). */
  rockColor: number;
  /**
   * Bare rock: it shows on steep ground (`sin` of the slope angle, 0 flat to 1 vertical, between `slopeFrom` and `slopeTo`)
   * and on high ground (`heightFrom`..`heightTo`, m).
   */
  rockMask: { slopeFrom: number; slopeTo: number; heightFrom: number; heightTo: number };
  /** The same for the fallback look (flat colour), up to `strength` of the surface. */
  fallbackRock: { slopeFrom: number; slopeTo: number; heightFrom: number; heightTo: number; strength: number };
  /** Snow caps: from `line` m (rising to full over `band` m), kept off ground steeper than slopeFrom..slopeTo (same measure as the rock). null = none. */
  snow: { line: number; band: number; slopeFrom: number; slopeTo: number } | null;
  /** Fallback world-space mottling: broad (hundreds of m) and fine (about a metre) brightness variation, and the two tints the ground drifts between. */
  mottle: { broad: number; grain: number; tintA: readonly [number, number, number]; tintB: readonly [number, number, number] };
}

export const TERRAIN_MATERIAL_LOOKS: Record<ThemeId, TerrainMaterialLook> = {
  desert: {
    ground: 'sand',
    rock: 'rock',
    cap: null,
    tileM: [5.5, 3.9, 11, 150],
    fallbackColor: 0xcfb083,
    roughness: 0.94,
    bumpScale: 0.045,
    bumpTileM: 4,
    groundTint: [1.95, 1.4, 0.88], // the pale pink sand turns orange
    rockTint: [1.3, 1.02, 0.84],
    capTint: [1, 1, 1],
    rockDesaturate: 0.3,
    detailFloor: 0.55,
    rockColor: 0x6b645d,
    rockMask: { slopeFrom: 0.22, slopeTo: 0.45, heightFrom: 35, heightTo: 120 },
    fallbackRock: { slopeFrom: 0.3, slopeTo: 0.65, heightFrom: 35, heightTo: 120, strength: 0.85 },
    snow: null,
    mottle: { broad: 0.12, grain: 0.035, tintA: [1.05, 0.97, 0.88], tintB: [0.94, 0.96, 1.0] },
  },
  arctic: {
    ground: 'snow',
    rock: 'rock',
    cap: null, // the ground is snow already: caps simply keep the rock off the high gentle ground
    tileM: [6.5, 4.6, 12, 160],
    fallbackColor: 0xd3dae3,
    roughness: 0.82,
    bumpScale: 0.05,
    bumpTileM: 5,
    groundTint: [1.7, 1.75, 1.9],
    rockTint: [1.0, 1.05, 1.15],
    capTint: [1, 1, 1],
    rockDesaturate: 0.8,
    detailFloor: 0.8,
    rockColor: 0x4a4d53,
    rockMask: { slopeFrom: 0.3, slopeTo: 0.55, heightFrom: 999, heightTo: 1000 },
    fallbackRock: { slopeFrom: 0.24, slopeTo: 0.55, heightFrom: 40, heightTo: 130, strength: 0.88 },
    snow: { line: 65, band: 45, slopeFrom: 0.38, slopeTo: 0.62 },
    mottle: { broad: 0.07, grain: 0.02, tintA: [0.93, 0.97, 1.07], tintB: [1.02, 1.0, 0.97] },
  },
  valley: {
    ground: 'grass',
    rock: 'rock',
    cap: 'snow',
    tileM: [5.5, 3.9, 11, 150],
    fallbackColor: 0x70793f,
    roughness: 0.96,
    bumpScale: 0.06,
    bumpTileM: 4,
    groundTint: [1.0, 1.2, 0.78],
    rockTint: [1.0, 0.95, 0.88],
    capTint: [1.5, 1.55, 1.7],
    rockDesaturate: 0.55,
    detailFloor: 0.6,
    rockColor: 0x6a6256,
    rockMask: { slopeFrom: 0.3, slopeTo: 0.55, heightFrom: 999, heightTo: 1000 },
    fallbackRock: { slopeFrom: 0.32, slopeTo: 0.7, heightFrom: 30, heightTo: 110, strength: 0.85 },
    snow: { line: 100, band: 50, slopeFrom: 0.34, slopeTo: 0.58 },
    mottle: { broad: 0.14, grain: 0.05, tintA: [0.88, 1.0, 0.8], tintB: [1.1, 1.02, 0.78] },
  },
};

export type TerrainTextureKey = 'groundDiff' | 'groundNor' | 'groundRough' | 'rockDiff' | 'rockNor' | 'rockRough' | 'capDiff' | 'capNor' | 'capRough';

/** The texture files of a theme, by key, relative to the site base (`assets/textures/...`). */
export function terrainTexturePaths(theme: ThemeId): Partial<Record<TerrainTextureKey, string>> {
  const look = TERRAIN_MATERIAL_LOOKS[theme];
  const paths: Partial<Record<TerrainTextureKey, string>> = {
    groundDiff: `assets/textures/${look.ground}_diff.jpg`,
    groundNor: `assets/textures/${look.ground}_nor.jpg`,
    groundRough: `assets/textures/${look.ground}_rough.jpg`,
    rockDiff: `assets/textures/${look.rock}_diff.jpg`,
    rockNor: `assets/textures/${look.rock}_nor.jpg`,
    rockRough: `assets/textures/${look.rock}_rough.jpg`,
  };
  if (look.cap) {
    paths.capDiff = `assets/textures/${look.cap}_diff.jpg`;
    paths.capNor = `assets/textures/${look.cap}_nor.jpg`;
    paths.capRough = `assets/textures/${look.cap}_rough.jpg`;
  }
  return paths;
}

/** Uniform name of each texture key. */
const SAMPLER_UNIFORMS: Record<TerrainTextureKey, string> = {
  groundDiff: 'tGroundDiff',
  groundNor: 'tGroundNor',
  groundRough: 'tGroundRough',
  rockDiff: 'tRockDiff',
  rockNor: 'tRockNor',
  rockRough: 'tRockRough',
  capDiff: 'tCapDiff',
  capNor: 'tCapNor',
  capRough: 'tCapRough',
};

export type TerrainUniforms = Record<string, THREE.IUniform>;

/** Handles on a terrain material, kept in `material.userData.terrain`. */
export interface TerrainMaterialState {
  theme: ThemeId;
  look: TerrainMaterialLook;
  /** The uniform objects the compiled shader shares (so changing a `.value` later takes effect without recompiling). */
  uniforms: TerrainUniforms;
  /** True once the photographic textures are in and the PBR look is on. */
  pbr: boolean;
}

const glsl = (n: number): string => n.toFixed(4);
const glslVec = (v: ArrayLike<number>): string => `vec3(${glsl(v[0])}, ${glsl(v[1])}, ${glsl(v[2])})`;

/** `source` with the first `anchor` replaced; throws if the anchor is missing (a three.js upgrade moved a chunk: better to fail loudly than render wrong). */
function patch(source: string, anchor: string, replacement: string, what: string): string {
  if (!source.includes(anchor)) throw new Error(`terrain shader: cannot find ${anchor} in the ${what} shader (three.js chunk changed?)`);
  return source.replace(anchor, replacement);
}

// ---------------------------------------------------------------------------------------------
// GLSL

const VERTEX_PARS = `
attribute vec2 bake;
varying vec2 vBake;
varying vec3 vGround;
varying vec3 vGroundN;
`;

const FRAGMENT_PARS = `
varying vec2 vBake;
varying vec3 vGround;
varying vec3 vGroundN;
uniform float uSunShadow;
#ifdef TERRAIN_PBR
uniform sampler2D tGroundDiff;
uniform sampler2D tGroundNor;
uniform sampler2D tGroundRough;
uniform sampler2D tRockDiff;
uniform sampler2D tRockNor;
uniform sampler2D tRockRough;
#ifdef TERRAIN_CAPTEX
uniform sampler2D tCapDiff;
uniform sampler2D tCapNor;
uniform sampler2D tCapRough;
#endif
uniform vec4 uTile;
uniform vec4 uRockMask;
uniform vec4 uSnow;
uniform vec3 uGroundTint;
uniform vec3 uRockTint;
uniform vec3 uCapTint;
uniform float uRockDesaturate;
uniform float uDetailFloor;

// Gradient noise, 0..1 around 0.5 (value noise shows its lattice from above): smooth blobs, no axis-aligned facets.
vec2 hash22(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return -1.0 + 2.0 * fract(sin(p) * 43758.5453);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n = mix(mix(dot(hash22(i), f), dot(hash22(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0)), u.x),
                mix(dot(hash22(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0)), dot(hash22(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0)), u.x), u.y);
  return clamp(0.5 + 0.9 * n, 0.0, 1.0);
}

// Triplanar sample with explicit gradients (so it may sit inside a branch): colour of the three projections blended by w.
vec4 triSample(sampler2D t, vec3 p, vec3 dx, vec3 dy, vec3 w, float tile, vec3 shift) {
  p = p / tile + shift;
  dx /= tile;
  dy /= tile;
  return textureGrad(t, p.zy, dx.zy, dy.zy) * w.x + textureGrad(t, p.xz, dx.xz, dy.xz) * w.y + textureGrad(t, p.xy, dx.xy, dy.xy) * w.z;
}

// Triplanar normal map in world space (whiteout blend); n is the geometric normal, k the strength of the map.
vec3 triNormal(sampler2D t, vec3 p, vec3 dx, vec3 dy, vec3 w, float tile, vec3 n, float k) {
  p /= tile;
  dx /= tile;
  dy /= tile;
  vec3 tx = textureGrad(t, p.zy, dx.zy, dy.zy).xyz * 2.0 - 1.0;
  vec3 ty = textureGrad(t, p.xz, dx.xz, dy.xz).xyz * 2.0 - 1.0;
  vec3 tz = textureGrad(t, p.xy, dx.xy, dy.xy).xyz * 2.0 - 1.0;
  tx = vec3(tx.xy * k + n.zy, abs(tx.z) * n.x);
  ty = vec3(ty.xy * k + n.xz, abs(ty.z) * n.y);
  tz = vec3(tz.xy * k + n.xy, abs(tz.z) * n.z);
  return normalize(tx.zyx * w.x + ty.xzy * w.y + tz.xyz * w.z);
}

// Tangent-space normal (-1..1) seen from above, in world space.
vec3 topNormal(vec3 tn, vec3 n, float k) {
  tn = vec3(tn.xy * k + n.xz, abs(tn.z) * n.y);
  return normalize(tn.xzy);
}
#endif
`;

/** Fallback mottling + rock tint, and (with TERRAIN_PBR) the textured albedo, roughness and normal. Replaces <color_fragment>'s tail. */
function colorChunk(look: TerrainMaterialLook): string {
  const { fallbackRock, mottle } = look;
  const rockColor = new THREE.Color(look.rockColor); // linear, like diffuseColor
  return `#include <color_fragment>
      // Each term fades out once a pixel spans more than a fraction of its wavelength (far ground, or a high zoom on it), or it aliases into streaks along the view.
      float pixelM = max(fwidth(vGround.x), fwidth(vGround.z));
      float fine = 1.0 - smoothstep(0.6, 2.0, pixelM);
      float wide = 1.0 - smoothstep(25.0, 140.0, pixelM);
      float broad = sin(vGround.x * 0.012 + sin(vGround.z * 0.016) * 1.6) * sin(vGround.z * 0.010 + 0.7) * wide;
      float grain = sin(vGround.x * 0.67 + vGround.z * 0.37) * sin(vGround.z * 0.51 - vGround.x * 0.29) * fine;
      float drift = 0.5 + 0.5 * mix(0.0, sin(vGround.x * 0.0123 + 1.7) * sin(vGround.z * 0.0087 - 0.4 + sin(vGround.x * 0.004) * 2.0), wide);
      vec3 gN = normalize(vGroundN);
      float steep = sqrt(max(0.0, 1.0 - gN.y * gN.y));
      float rough = 1.0;
      vec3 shadeN = gN;
      #ifndef TERRAIN_PBR
      diffuseColor.rgb *= mix(${glslVec(mottle.tintA)}, ${glslVec(mottle.tintB)}, drift);
      diffuseColor.rgb *= 1.0 + broad * ${glsl(mottle.broad)} + grain * ${glsl(mottle.grain)};
      float rockMix = max(smoothstep(${glsl(fallbackRock.slopeFrom)}, ${glsl(fallbackRock.slopeTo)}, steep),
                          smoothstep(${glsl(fallbackRock.heightFrom)}, ${glsl(fallbackRock.heightTo)}, vGround.y)) * ${glsl(fallbackRock.strength)};
      float strata = sin(vGround.y * 1.8 + sin(vGround.x * 0.08) * 2.0) * fine;
      vec3 bare = ${glslVec([rockColor.r, rockColor.g, rockColor.b])} * (0.85 + strata * 0.1 + grain * 0.06 + broad * 0.08);
      diffuseColor.rgb = mix(diffuseColor.rgb, bare, rockMix);
      #else
      vec3 dpx = dFdx(vGround);
      vec3 dpy = dFdy(vGround);
      // Slow world-space wobble that breaks up the slope and height thresholds (it fades with the pixel footprint like the rest).
      float wob = (vnoise(vec2(vGround.x * 0.6 + vGround.z * 0.8, vGround.y) / 45.0) - 0.5) * 2.0 * wide
                + 0.5 * (vnoise(vec2(vGround.x * 0.8 - vGround.z * 0.6, vGround.y * 1.3) / 14.0) - 0.5) * 2.0 * fine;
      float rockW = smoothstep(uRockMask.x, uRockMask.y, steep + wob * 0.07);
      rockW = max(rockW, smoothstep(uRockMask.z, uRockMask.w, vGround.y + wob * 9.0));
      #ifdef TERRAIN_SNOW
      float capW = smoothstep(uSnow.x, uSnow.x + uSnow.y, vGround.y + wob * 14.0) * (1.0 - smoothstep(uSnow.z, uSnow.w, steep + wob * 0.05));
      #ifndef TERRAIN_CAPTEX
      rockW *= 1.0 - capW; // the ground is snow already: the cap just keeps the bare rock off the high gentle ground
      #endif
      #endif

      // Ground, seen from above. Near: a detail texture, the mix of two copies (different scale and angle) picked by a slow noise, so
      // no tile repeats in a pattern. Far: the detail fades to the texture's mean colour as its tiles shrink (a minified tiled
      // texture shows its tiling), and a non-repeating noise (cells of 9 m to 210 m, each fading out as it gets sub-pixel) carries the variation.
      vec2 gp = vGround.xz;
      mat2 turn = mat2(0.8, -0.6, 0.6, 0.8);
      float fineG = 1.0 - smoothstep(0.3, 1.5, pixelM);
      float pickD = mix(0.5, smoothstep(0.3, 0.7, vnoise(turn * gp / 11.0)), fineG);
      vec3 gDetail = mix(texture2D(tGroundDiff, gp / uTile.x).rgb, texture2D(tGroundDiff, turn * gp / uTile.y + 0.29).rgb, pickD);
      vec3 gMean = textureLod(tGroundDiff, gp / uTile.x, 10.0).rgb;
      float lumaMean = dot(gMean, vec3(0.3, 0.59, 0.11));
      gDetail += max(0.0, lumaMean * uDetailFloor - dot(gDetail, vec3(0.3, 0.59, 0.11))); // lift the darkest marks (footprints, holes): repeated, they would read as a pattern
      vec3 albedo = mix(gMean, gDetail, 1.0 - smoothstep(uTile.x / 16.0, uTile.x / 5.0, pixelM));
      float cloud = 0.38 * mix(0.5, vnoise(gp / 9.0), 1.0 - smoothstep(1.1, 3.0, pixelM))
                  + 0.30 * mix(0.5, vnoise(turn * gp / 26.0 + 3.1), 1.0 - smoothstep(3.0, 9.0, pixelM))
                  + 0.20 * mix(0.5, vnoise(gp / 75.0 + 9.7), 1.0 - smoothstep(9.0, 25.0, pixelM))
                  + 0.12 * vnoise(turn * gp / 210.0 + 1.3);
      albedo *= (0.78 + 0.44 * cloud) * uGroundTint;
      // The normal map takes both copies too (the turned one rotated back), and fades out early: its bumps are what shows a repeating tile first.
      float nFadeG = 1.0 - smoothstep(uTile.x / 120.0, uTile.x / 35.0, pixelM);
      rough = texture2D(tGroundRough, gp / uTile.x).g;
      if (nFadeG > 0.01) {
        vec3 tnA = texture2D(tGroundNor, gp / uTile.x).xyz * 2.0 - 1.0;
        vec3 tnB = texture2D(tGroundNor, turn * gp / uTile.y + 0.29).xyz * 2.0 - 1.0;
        tnB.xy = tnB.xy * turn;
        shadeN = topNormal(mix(tnA, tnB, pickD), gN, 0.9 * nFadeG);
      }

      // Rock on the steep ground: triplanar, so cliffs show no stretched texture. Each layer is sampled only where it shows (the
      // explicit gradients make that legal inside a branch): detail near, macro (two scales mixed by a noise, against repetition) far,
      // and the normal and roughness maps only while the pixel is small enough for their detail to matter.
      if (rockW > 0.004) {
        vec3 w = pow(abs(gN), vec3(4.0));
        w /= w.x + w.y + w.z;
        float farR = smoothstep(uTile.z / 100.0, uTile.z / 30.0, pixelM);
        vec3 rock = vec3(0.0);
        if (farR < 0.995) rock += (1.0 - farR) * triSample(tRockDiff, vGround, dpx, dpy, w, uTile.z, vec3(0.0)).rgb;
        if (farR > 0.005) {
          float pickR = smoothstep(0.3, 0.7, vnoise(vec2(vGround.x + vGround.z, vGround.y * 1.7) / 70.0));
          vec3 macro = mix(triSample(tRockDiff, vGround, dpx, dpy, w, uTile.w, vec3(0.37, 0.61, 0.23)).rgb,
                           triSample(tRockDiff, vGround, dpx, dpy, w, uTile.w * 0.67, vec3(0.71, 0.13, 0.52)).rgb, pickR);
          rock += farR * macro;
        }
        rock = mix(rock, vec3(dot(rock, vec3(0.3, 0.59, 0.11))), uRockDesaturate) * uRockTint;
        float nFadeR = 1.0 - smoothstep(uTile.z / 60.0, uTile.z / 16.0, pixelM);
        vec3 rockN = gN;
        float rockRough = 0.85;
        if (nFadeR > 0.01) {
          rockN = triNormal(tRockNor, vGround, dpx, dpy, w, uTile.z, gN, nFadeR);
          rockRough = triSample(tRockRough, vGround, dpx, dpy, w, uTile.z, vec3(0.0)).g;
        }
        albedo = mix(albedo, rock, rockW);
        rough = mix(rough, rockRough, rockW);
        shadeN = normalize(mix(shadeN, rockN, rockW));
      }
      #ifdef TERRAIN_CAPTEX
      // Snow on the high gentle ground (its own textures): detail fading to the mean like the ground.
      if (capW > 0.004) {
        vec3 cDetail = texture2D(tCapDiff, gp / 4.5).rgb;
        vec3 cMean = textureLod(tCapDiff, gp / 4.5, 10.0).rgb;
        vec3 snow = mix(cMean, cDetail, 1.0 - smoothstep(0.25, 0.8, pixelM)) * (0.85 + 0.3 * cloud) * uCapTint;
        float nFadeC = 1.0 - smoothstep(0.05, 0.2, pixelM);
        albedo = mix(albedo, snow, capW);
        rough = mix(rough, texture2D(tCapRough, gp / 4.5).g, capW);
        shadeN = normalize(mix(shadeN, topNormal(texture2D(tCapNor, gp / 4.5).xyz * 2.0 - 1.0, gN, 0.8 * nFadeC), capW));
      }
      #endif
      diffuseColor.rgb *= albedo;
      diffuseColor.rgb *= mix(${glslVec(mottle.tintA)}, ${glslVec(mottle.tintB)}, drift * 0.5 + 0.25);
      diffuseColor.rgb *= 1.0 + broad * ${glsl(mottle.broad * 0.6)}; // the textures carry the fine grain
      #endif
      `;
}

const ROUGHNESS_CHUNK = `#include <roughnessmap_fragment>
      #ifdef TERRAIN_PBR
      roughnessFactor = clamp(rough, 0.05, 1.0);
      #endif`;

const NORMAL_CHUNK = `#include <normal_fragment_maps>
      #ifdef TERRAIN_PBR
      normal = transformDirection(shadeN, viewMatrix);
      #endif`;

/** The baked lighting: sun visibility darkens the direct light only, occlusion the indirect light only. */
const BAKE_CHUNK = `#include <aomap_fragment>
      float bakedSun = mix(1.0, vBake.x, uSunShadow);
      reflectedLight.directDiffuse *= bakedSun;
      reflectedLight.directSpecular *= bakedSun;
      reflectedLight.indirectDiffuse *= vBake.y;
      reflectedLight.indirectSpecular *= mix(1.0, vBake.y, 0.7);`;

/** Patch a standard-material shader for the terrain (exported for the tests: `shader` needs only the three fields). */
export function patchTerrainShader(
  shader: { uniforms: TerrainUniforms; vertexShader: string; fragmentShader: string },
  state: Pick<TerrainMaterialState, 'look' | 'uniforms'>,
): void {
  Object.assign(shader.uniforms, state.uniforms);
  let vertex = shader.vertexShader;
  vertex = patch(vertex, '#include <common>', `#include <common>${VERTEX_PARS}`, 'vertex');
  vertex = patch(vertex, '#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nvGroundN = objectNormal;', 'vertex');
  vertex = patch(vertex, '#include <begin_vertex>', '#include <begin_vertex>\nvGround = position;\nvBake = bake;', 'vertex');
  shader.vertexShader = vertex;

  let fragment = shader.fragmentShader;
  fragment = patch(fragment, '#include <common>', `#include <common>${FRAGMENT_PARS}`, 'fragment');
  fragment = patch(fragment, '#include <color_fragment>', colorChunk(state.look), 'fragment');
  fragment = patch(fragment, '#include <roughnessmap_fragment>', ROUGHNESS_CHUNK, 'fragment');
  fragment = patch(fragment, '#include <normal_fragment_maps>', NORMAL_CHUNK, 'fragment');
  fragment = patch(fragment, '#include <aomap_fragment>', BAKE_CHUNK, 'fragment');
  shader.fragmentShader = fragment;
}

// ---------------------------------------------------------------------------------------------
// Material

/**
 * The terrain material of `theme` in its fallback look (no texture is loaded here: see `loadTerrainTextures`).
 * Its state (uniforms, look, whether the PBR look is on) is `material.userData.terrain`.
 */
export function createTerrainMaterial(theme: ThemeId, maxAnisotropy = 8): THREE.MeshStandardMaterial {
  const look = TERRAIN_MATERIAL_LOOKS[theme];
  const uniforms: TerrainUniforms = {
    uSunShadow: { value: 0.9 },
    uTile: { value: new THREE.Vector4(...look.tileM) },
    uRockMask: { value: new THREE.Vector4(look.rockMask.slopeFrom, look.rockMask.slopeTo, look.rockMask.heightFrom, look.rockMask.heightTo) },
    uSnow: { value: look.snow ? new THREE.Vector4(look.snow.line, look.snow.band, look.snow.slopeFrom, look.snow.slopeTo) : new THREE.Vector4(1e6, 1, 1, 1) },
    uGroundTint: { value: new THREE.Vector3(...look.groundTint) },
    uRockTint: { value: new THREE.Vector3(...look.rockTint) },
    uCapTint: { value: new THREE.Vector3(...look.capTint) },
    uRockDesaturate: { value: look.rockDesaturate },
    uDetailFloor: { value: look.detailFloor },
  };
  for (const name of Object.values(SAMPLER_UNIFORMS)) uniforms[name] = { value: null };

  // Flat theme colour and a procedural bump until the textures arrive; if they never do, the terrain just stays like this.
  const bump = groundRelief(theme, maxAnisotropy);
  bump.repeat.set(look.tileM[0] / look.bumpTileM, look.tileM[0] / look.bumpTileM); // uv runs in ground tiles
  const material = new THREE.MeshStandardMaterial({
    color: look.fallbackColor,
    vertexColors: true,
    roughness: look.roughness,
    metalness: 0,
    bumpMap: bump,
    bumpScale: look.bumpScale,
  });
  const state: TerrainMaterialState = { theme, look, uniforms, pbr: false };
  material.userData.terrain = state;
  material.defines = { ...(material.defines ?? {}) };
  if (look.snow) material.defines.TERRAIN_SNOW = '';
  if (look.cap) material.defines.TERRAIN_CAPTEX = '';
  material.onBeforeCompile = (shader) => patchTerrainShader(shader, state);
  material.customProgramCacheKey = () => `terrain-${theme}`; // the patch differs per theme (and the defines per look)
  return material;
}

/** Wrap, mipmap and filter a loaded terrain texture: colour maps are sRGB, normal and roughness maps linear data. */
function configureTexture(texture: THREE.Texture, srgb: boolean, maxAnisotropy: number): THREE.Texture {
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = maxAnisotropy;
  texture.needsUpdate = true;
  return texture;
}

/** Switch `material` to the PBR look with these textures (every key of `terrainTexturePaths(theme)` must be present). */
export function applyTerrainTextures(material: THREE.MeshStandardMaterial, textures: Partial<Record<TerrainTextureKey, THREE.Texture>>): void {
  const state = material.userData.terrain as TerrainMaterialState;
  for (const key of Object.keys(terrainTexturePaths(state.theme)) as TerrainTextureKey[]) {
    const texture = textures[key];
    if (!texture) throw new Error(`terrain: missing texture ${key}`);
    state.uniforms[SAMPLER_UNIFORMS[key]].value = texture;
  }
  material.defines = { ...(material.defines ?? {}), TERRAIN_PBR: '' };
  material.color.set(0xffffff); // the textures carry the colour; vertex colours still tint them
  material.roughness = 1; // overridden per pixel
  material.bumpMap = null;
  state.pbr = true;
  material.needsUpdate = true;
}

export interface TerrainTextureOptions {
  /** Site base URL; default the Vite `BASE_URL`. */
  baseUrl?: string;
  maxAnisotropy?: number;
  /** Texture loader (default: three's TextureLoader); tests inject one that needs no image decoding. */
  load?: (url: string) => Promise<THREE.Texture>;
}

const defaultLoad = (url: string): Promise<THREE.Texture> => new THREE.TextureLoader().loadAsync(url);

/**
 * Load the photographic textures of the material's theme and, once every one has arrived, switch it to the PBR look. If any
 * fails the terrain keeps its fallback look (and a warning is logged). Resolves true when the PBR look is on.
 */
export async function loadTerrainTextures(material: THREE.MeshStandardMaterial, options: TerrainTextureOptions = {}): Promise<boolean> {
  const state = material.userData.terrain as TerrainMaterialState;
  const baseUrl = options.baseUrl ?? import.meta.env.BASE_URL;
  const anisotropy = options.maxAnisotropy ?? 8;
  const load = options.load ?? defaultLoad;
  const paths = terrainTexturePaths(state.theme);
  const keys = Object.keys(paths) as TerrainTextureKey[];
  try {
    const loaded = await Promise.all(keys.map((key) => load(`${baseUrl}${paths[key]}`)));
    const textures: Partial<Record<TerrainTextureKey, THREE.Texture>> = {};
    keys.forEach((key, i) => {
      textures[key] = configureTexture(loaded[i], key.endsWith('Diff'), anisotropy);
    });
    applyTerrainTextures(material, textures);
    return true;
  } catch (error) {
    console.warn(`terrain: could not load the ${state.theme} textures, keeping the flat colour look`, error);
    return false;
  }
}
