import * as THREE from 'three';

// Small procedural textures for the first-person rifle (no files, no canvas: plain pixel arrays that also build in
// Node). All are tileable, seeded (the same pixels every run) and power-of-two so they mip-map.
//   metal   anodised / cerakote: roughness and metalness variation, brushed streaks, scratches and bare-metal chips
//   stipple polymer stipple: a normal map of small round dots
//   pebble  rubber grain: the same dots, coarser and softer
//   fabric  camo-tan glove cloth: blotchy tan colours over a woven thread pattern, and the weave as a normal map

/** Integer hash of a lattice point and a seed to [0, 1). */
function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed + 1, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function wrap(i: number, period: number): number {
  return ((i % period) + period) % period;
}

/** Tileable value noise in [0, 1): (x, y) in lattice units, repeating every `px` / `py` lattice cells. */
function valueNoise(x: number, y: number, px: number, py: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const xa = wrap(x0, px);
  const xb = wrap(x0 + 1, px);
  const ya = wrap(y0, py);
  const yb = wrap(y0 + 1, py);
  const top = hash2(xa, ya, seed) * (1 - sx) + hash2(xb, ya, seed) * sx;
  const bottom = hash2(xa, yb, seed) * (1 - sx) + hash2(xb, yb, seed) * sx;
  return top * (1 - sy) + bottom * sy;
}

/** Tileable fractal noise in [0, 1): `period` lattice cells across (u, v in [0, 1)) at the first octave. */
function fbm(u: number, v: number, period: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let p = period;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(u * p, v * p, p, p, seed + o * 17);
    norm += amp;
    amp *= 0.5;
    p *= 2;
  }
  return sum / norm;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** Wrap a pixel array in a repeating, mip-mapped, anisotropic texture. */
function toTexture(pixels: Uint8Array, size: number, colour: boolean): THREE.DataTexture {
  const texture = new THREE.DataTexture(pixels, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  texture.colorSpace = colour ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Metal surface data packed like a glTF ORM map: G = roughness, B = metalness (R = 1, unused). A satin coat with
 * slow roughness drift, fine brushed streaks along u, scratches and chips where the bare, shinier metal shows.
 */
export function metalPixels(size = 256, seed = 11): Uint8Array {
  const pixels = new Uint8Array(size * size * 4);
  const rough = new Float32Array(size * size);
  const metal = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const drift = fbm(u, v, 4, 4, seed) - 0.5;
      const streak = valueNoise(u * 6, v * 96, 6, 96, seed + 5) - 0.5;
      const grain = hash2(x, y, seed + 9) - 0.5;
      const chipField = fbm(u, v, 16, 3, seed + 31);
      const chip = smoothstep(0.64, 0.7, chipField);
      let r = 0.46 + 0.34 * drift + 0.16 * streak + 0.07 * grain;
      let m = 0.8 + 0.1 * drift;
      r = r * (1 - chip) + 0.3 * chip;
      m = m * (1 - chip) + 1 * chip;
      rough[y * size + x] = r;
      metal[y * size + x] = m;
    }
  }
  // Scratches: short straight lines of bare metal, wrapping around the tile.
  for (let s = 0; s < 22; s++) {
    const x0 = hash2(s, 1, seed + 41) * size;
    const y0 = hash2(s, 2, seed + 41) * size;
    const angle = hash2(s, 3, seed + 41) * Math.PI;
    const length = 14 + hash2(s, 4, seed + 41) * 50;
    for (let t = 0; t < length; t++) {
      const px = wrap(Math.round(x0 + Math.cos(angle) * t), size);
      const py = wrap(Math.round(y0 + Math.sin(angle) * t), size);
      rough[py * size + px] = 0.26;
      metal[py * size + px] = 1;
    }
  }
  for (let i = 0; i < size * size; i++) {
    pixels[i * 4] = 255;
    pixels[i * 4 + 1] = Math.round(255 * clamp01(rough[i]));
    pixels[i * 4 + 2] = Math.round(255 * clamp01(metal[i]));
    pixels[i * 4 + 3] = 255;
  }
  return pixels;
}

/** Tangent-space normals (as pixels) from a tileable height field; `strength` scales the slope. */
function normalPixels(height: Float32Array, size: number, strength: number): Uint8Array {
  const pixels = new Uint8Array(size * size * 4);
  const h = (x: number, y: number) => height[wrap(y, size) * size + wrap(x, size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (h(x + 1, y) - h(x - 1, y)) * strength;
      const dy = (h(x, y + 1) - h(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      pixels[i] = Math.round((-dx / len * 0.5 + 0.5) * 255);
      pixels[i + 1] = Math.round((-dy / len * 0.5 + 0.5) * 255);
      pixels[i + 2] = Math.round((1 / len * 0.5 + 0.5) * 255);
      pixels[i + 3] = 255;
    }
  }
  return pixels;
}

/** A field of round bumps (`count` dots of `radius` px) over a slow unevenness; heights in about [0, 1]. */
function dotField(size: number, count: number, radius: number, unevenness: number, seed: number): Float32Array {
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) height[y * size + x] = unevenness * fbm(x / size, y / size, 6, 3, seed + 3);
  }
  const reach = Math.ceil(radius);
  for (let d = 0; d < count; d++) {
    const cx = hash2(d, 7, seed) * size;
    const cy = hash2(d, 8, seed) * size;
    const peak = 0.7 + 0.3 * hash2(d, 9, seed);
    for (let oy = -reach; oy <= reach; oy++) {
      for (let ox = -reach; ox <= reach; ox++) {
        const px = Math.round(cx) + ox;
        const py = Math.round(cy) + oy;
        const dist = Math.hypot(px - cx, py - cy) / radius;
        if (dist >= 1) continue;
        const bump = peak * (0.5 + 0.5 * Math.cos(Math.PI * dist));
        const k = wrap(py, size) * size + wrap(px, size);
        height[k] = Math.max(height[k], bump + unevenness * 0.3);
      }
    }
  }
  return height;
}

/** Polymer stipple: a dense field of small dots, as a normal map. */
export function stipplePixels(size = 128, seed = 23): Uint8Array {
  return normalPixels(dotField(size, 620, 2.3, 0.15, seed), size, 3.2);
}

/** Rubber grain: bigger, softer dots, as a normal map. */
export function pebblePixels(size = 128, seed = 37): Uint8Array {
  return normalPixels(dotField(size, 240, 3.6, 0.3, seed), size, 2.2);
}

/** Thread height of a plain weave: `threads` threads across the tile, over and under. */
function weaveHeight(u: number, v: number, threads: number): number {
  const a = Math.sin(Math.PI * 2 * threads * u);
  const b = Math.sin(Math.PI * 2 * threads * v);
  const over = Math.sin(Math.PI * threads * (u + v)) > 0 ? 1 : 0;
  return 0.5 + 0.25 * (over ? a * 0.6 + 0.4 : b * 0.6 + 0.4);
}

/** Camo-tan cloth colour (sRGB) over the thread pattern. Three tans (khaki, coyote, brown) in soft blotches. */
export function fabricColourPixels(size = 256, seed = 53): Uint8Array {
  const khaki = [0xa9, 0x98, 0x6c];
  const coyote = [0x86, 0x74, 0x4c];
  const brown = [0x57, 0x47, 0x30];
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const a = fbm(u, v, 3, 4, seed);
      const b = fbm(u, v, 5, 3, seed + 100);
      const weave = 0.86 + 0.28 * weaveHeight(u, v, 28);
      const toBrown = smoothstep(0.55, 0.62, b);
      const toKhaki = smoothstep(0.52, 0.58, a);
      const i = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) {
        const base = coyote[c] * (1 - toKhaki) + khaki[c] * toKhaki;
        const mix = base * (1 - toBrown) + brown[c] * toBrown;
        pixels[i + c] = Math.round(Math.min(255, mix * weave));
      }
      pixels[i + 3] = 255;
    }
  }
  return pixels;
}

/** The weave as a normal map. */
export function fabricNormalPixels(size = 256): Uint8Array {
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) height[y * size + x] = weaveHeight(x / size, y / size, 28);
  }
  return normalPixels(height, size, 4);
}

/** The finished textures of one rifle. Built once and shared by every rifle model. */
export interface RifleTextures {
  metal: THREE.DataTexture;
  stipple: THREE.DataTexture;
  pebble: THREE.DataTexture;
  fabric: THREE.DataTexture;
  fabricNormal: THREE.DataTexture;
}

let shared: RifleTextures | null = null;

export function rifleTextures(): RifleTextures {
  shared ??= {
    metal: toTexture(metalPixels(), 256, false),
    stipple: toTexture(stipplePixels(), 128, false),
    pebble: toTexture(pebblePixels(), 128, false),
    fabric: toTexture(fabricColourPixels(), 256, true),
    fabricNormal: toTexture(fabricNormalPixels(), 256, false),
  };
  return shared;
}
