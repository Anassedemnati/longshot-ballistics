import * as THREE from 'three';
import { clamp01, fbm, hash2, normalPixels, smoothstep, toTexture, weaveHeight } from '../player/rifleTextures';
import { CAMO_TONES } from '../mission/enemySurface';

// The two textures every enemy shares (no files, no canvas: plain pixel arrays that also build in Node, tileable,
// seeded, power-of-two so they mip-map):
//   camo         the printed field uniform: four soft-edged tones in blotches about 8 cm across, over a fine grain. The
//                mean colour is the old khaki's, so at range, where the mip-maps average the blotches away, a soldier is
//                the same solid tone he was; the pattern is for the close-up.
//   cloth normal the weave (a rip-stop thread grid) with slow creases, as a tangent-space normal map.

/** Texture size, px: 512 over ENEMY_UV_TILE_M = 1 m is 2 mm a texel. */
export const ENEMY_TEXTURE_SIZE = 512;
/** Thread pitch of the weave: threads across one tile (about 9 mm a thread). */
const THREADS = 112;

const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/** An sRGB hex as three 0..255 channel values. */
function channels(hex: number): [number, number, number] {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
}

/**
 * The camo colour map (sRGB RGBA): the base khaki with three kinds of blotch laid over it by thresholding three noise
 * fields (tan, olive, brown, in that order of precedence), an organic woodland-style print, plus a +-4 % grain per
 * texel and a faint thread pattern. Tileable.
 */
export function camoPixels(size = ENEMY_TEXTURE_SIZE, seed = 71): Uint8Array {
  const base = channels(CAMO_TONES.base);
  const tan = channels(CAMO_TONES.tan);
  const brown = channels(CAMO_TONES.brown);
  const olive = channels(CAMO_TONES.olive);
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const nTan = fbm(u, v, 12, 3, seed);
      const nOlive = fbm(u, v, 10, 3, seed + 101);
      const nBrown = fbm(u, v, 14, 3, seed + 202);
      const toTan = smoothstep(0.54, 0.57, nTan);
      const toOlive = smoothstep(0.55, 0.58, nOlive);
      const toBrown = smoothstep(0.57, 0.6, nBrown);
      const grain = 1 + (hash2(x, y, seed + 7) - 0.5) * 0.08;
      const thread = 0.97 + 0.06 * weaveHeight(u, v, THREADS);
      const i = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) {
        let value = base[c];
        value = value * (1 - toTan) + tan[c] * toTan;
        value = value * (1 - toOlive) + olive[c] * toOlive;
        value = value * (1 - toBrown) + brown[c] * toBrown;
        pixels[i + c] = Math.round(clamp01((value * grain * thread) / 255) * 255);
      }
      pixels[i + 3] = 255;
    }
  }
  return pixels;
}

/** The mean linear-light colour of an sRGB RGBA pixel array (what the mip-mapped texture tends to far away). */
export function meanLinear(pixels: Uint8Array): { r: number; g: number; b: number; luminance: number } {
  let r = 0;
  let g = 0;
  let b = 0;
  const n = pixels.length / 4;
  for (let i = 0; i < n; i++) {
    r += toLinear(pixels[i * 4] / 255);
    g += toLinear(pixels[i * 4 + 1] / 255);
    b += toLinear(pixels[i * 4 + 2] / 255);
  }
  r /= n;
  g /= n;
  b /= n;
  return { r, g, b, luminance: 0.2126 * r + 0.7152 * g + 0.0722 * b };
}

/** The cloth normal map (tangent space): a plain weave with slow creases over it. Tileable. */
export function clothNormalPixels(size = ENEMY_TEXTURE_SIZE, seed = 83): Uint8Array {
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const weave = weaveHeight(u, v, THREADS);
      const crease = fbm(u, v, 6, 4, seed);
      height[y * size + x] = weave * 0.22 + crease * 2.4;
    }
  }
  return normalPixels(height, size, 3);
}

/** The finished textures of every enemy. Built once. */
export interface EnemyTextures {
  camo: THREE.DataTexture;
  clothNormal: THREE.DataTexture;
}

let shared: EnemyTextures | null = null;

/** The shared camo and cloth-normal textures (built on first use). */
export function enemyTextures(): EnemyTextures {
  shared ??= {
    camo: toTexture(camoPixels(), ENEMY_TEXTURE_SIZE, true),
    clothNormal: toTexture(clothNormalPixels(), ENEMY_TEXTURE_SIZE, false),
  };
  return shared;
}
