import * as THREE from 'three';

// Pure maths on an equirectangular HDRI held in memory (no GL, no DOM): where its sun is, what colour its horizon
// is, and a copy with the sun disc clamped so it can light the scene as sky-only image-based light. `sky.ts` loads
// the file and uses these. The mapping is three.js's own: u = atan2(z, x) / 2pi + 0.5, v = asin(y) / pi + 0.5, with
// the image stored top row first (row 0 is straight up), which is how `HDRLoader` hands the data over.

export interface EquirectImage {
  /** RGBA, rows top to bottom. A `Float32Array` holds linear floats, a `Uint16Array` half floats (the loader's default). */
  data: Float32Array | Uint16Array;
  width: number;
  height: number;
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Dir3 {
  x: number;
  y: number;
  z: number;
}

const DEG = Math.PI / 180;
/** One pixel never counts for more than this luminance (a single hot pixel must not decide where the sun is). */
const MAX_LUMINANCE = 1e6;

let halfTable: Float32Array | null = null;
/** Half float -> float for every 16-bit pattern: 2 M pixels decode in a few ms instead of a function call each. */
function halfLut(): Float32Array {
  if (halfTable) return halfTable;
  const table = new Float32Array(65536);
  for (let i = 0; i < 65536; i++) table[i] = THREE.DataUtils.fromHalfFloat(i);
  halfTable = table;
  return table;
}

/** Reader of the red, green and blue values (linear floats) of pixel `pixel` (= row * width + column). */
function rgbReader(img: EquirectImage): (pixel: number, out: Rgb) => void {
  const d = img.data;
  if (d instanceof Uint16Array) {
    const lut = halfLut();
    return (p, out) => {
      out.r = lut[d[p * 4]];
      out.g = lut[d[p * 4 + 1]];
      out.b = lut[d[p * 4 + 2]];
    };
  }
  return (p, out) => {
    out.r = d[p * 4];
    out.g = d[p * 4 + 1];
    out.b = d[p * 4 + 2];
  };
}

/** Rec. 709 luminance of linear RGB. */
export function luminanceOf(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Unit direction of the centre of pixel (column, row) in an image of `width` x `height`. */
export function equirectDirection(column: number, row: number, width: number, height: number): Dir3 {
  const phi = ((column + 0.5) / width - 0.5) * 2 * Math.PI; // atan2(z, x)
  const elevation = (0.5 - (row + 0.5) / height) * Math.PI;
  const c = Math.cos(elevation);
  return { x: Math.cos(phi) * c, y: Math.sin(elevation), z: Math.sin(phi) * c };
}

/** Elevation above the horizon of a direction, degrees. */
export function elevationDegOf(d: Dir3): number {
  return Math.asin(Math.max(-1, Math.min(1, d.y / Math.hypot(d.x, d.y, d.z)))) / DEG;
}

/**
 * Azimuth of a direction as `SkyLook.sunAzimuthDeg` measures it: from +Z (behind the shooter) toward -X (left),
 * degrees in (-180, 180].
 */
export function lookAzimuthDegOf(d: Dir3): number {
  return Math.atan2(-d.x, d.z) / DEG;
}

export interface SunFind {
  /** Unit vector towards the sun (in the HDRI's own frame). */
  direction: Dir3;
  elevationDeg: number;
  /** Azimuth in `SkyLook` terms, degrees. */
  azimuthDeg: number;
  /** Luminance of the brightest pixel near the sun. */
  peak: number;
  /** Mean luminance of the whole image. */
  mean: number;
  /** True when the peak stands far above the rest of the sky: a visible sun disc. An overcast sky has none. */
  distinct: boolean;
}

/** The peak must be this many times the image's mean luminance for the sun to count as a visible disc. */
const DISTINCT_PEAK_OVER_MEAN = 20;

/**
 * The brightest region of the sky: the block of pixels (about 5.6 degrees on a 2k image) with the highest mean
 * luminance, then the luminance-weighted centre of the pixels at least half as bright as its brightest pixel.
 * A sun disc is found to a fraction of a pixel; an overcast sky gives the middle of its brightest patch.
 */
export function findSunDirection(img: EquirectImage): SunFind {
  const { width: w, height: h } = img;
  const read = rgbReader(img);
  const px: Rgb = { r: 0, g: 0, b: 0 };
  const lum = (p: number): number => {
    read(p, px);
    return Math.min(MAX_LUMINANCE, luminanceOf(px.r, px.g, px.b));
  };

  const block = Math.max(2, Math.round(w / 64));
  const bw = Math.ceil(w / block);
  const bh = Math.ceil(h / block);
  const sums = new Float64Array(bw * bh);
  let total = 0;
  for (let row = 0; row < h; row++) {
    const by = Math.floor(row / block);
    for (let col = 0; col < w; col++) {
      const l = lum(row * w + col);
      sums[by * bw + Math.floor(col / block)] += l;
      total += l;
    }
  }
  let best = 0;
  for (let i = 1; i < sums.length; i++) if (sums[i] > sums[best]) best = i;
  const bx = best % bw;
  const by = Math.floor(best / bw);

  // The window: the peak block and its neighbours (columns wrap round, rows stop at the poles).
  const rowFrom = Math.max(0, (by - 1) * block);
  const rowTo = Math.min(h - 1, (by + 2) * block - 1);
  let peak = 0;
  for (let row = rowFrom; row <= rowTo; row++) {
    for (let k = (bx - 1) * block; k < (bx + 2) * block; k++) {
      peak = Math.max(peak, lum(row * w + (((k % w) + w) % w)));
    }
  }
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (let row = rowFrom; row <= rowTo; row++) {
    for (let k = (bx - 1) * block; k < (bx + 2) * block; k++) {
      const col = ((k % w) + w) % w;
      const l = lum(row * w + col);
      if (l < peak * 0.5) continue;
      const d = equirectDirection(col, row, w, h);
      // The weight is the pixel's luminance times its solid angle (cos elevation, which is the direction's horizontal length).
      const weight = l * Math.hypot(d.x, d.z);
      sx += d.x * weight;
      sy += d.y * weight;
      sz += d.z * weight;
    }
  }
  const length = Math.hypot(sx, sy, sz) || 1;
  const direction = { x: sx / length, y: sy / length, z: sz / length };
  const mean = total / (w * h);
  return {
    direction,
    elevationDeg: elevationDegOf(direction),
    azimuthDeg: lookAzimuthDegOf(direction),
    peak,
    mean,
    distinct: peak >= DISTINCT_PEAK_OVER_MEAN * mean,
  };
}

/**
 * The rotation about +Y, radians, that `THREE.Matrix4.makeRotationY` turns `from` into the azimuth of `to`
 * (elevations are left as they are): rotating an HDRI's sun direction by it puts the sun where `to` is.
 */
export function yawBetween(from: Dir3, to: Dir3): number {
  // makeRotationY(t) takes a point at atan2(z, x) = phi to phi - t.
  return Math.atan2(from.z, from.x) - Math.atan2(to.z, to.x);
}

export interface HorizonBand {
  /** Centre of the sector, `atan2(z, x)` of the HDRI's frame, degrees. */
  centerPhiDeg: number;
  /** Half the sector's width, degrees. */
  halfWidthDeg: number;
  elevationMinDeg: number;
  elevationMaxDeg: number;
}

/** Mean linear colour of the pixels in `band` (a sector of the horizon). Throws when the band holds no pixel. */
export function sampleHorizonColor(img: EquirectImage, band: HorizonBand): Rgb {
  const { width: w, height: h } = img;
  const read = rgbReader(img);
  const px: Rgb = { r: 0, g: 0, b: 0 };
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let row = 0; row < h; row++) {
    const elevation = (0.5 - (row + 0.5) / h) * 180;
    if (elevation < band.elevationMinDeg || elevation > band.elevationMaxDeg) continue;
    for (let col = 0; col < w; col++) {
      const phi = ((col + 0.5) / w - 0.5) * 360;
      // Signed angular distance to the sector's centre, wrapped to [-180, 180).
      const dphi = ((((phi - band.centerPhiDeg) % 360) + 540) % 360) - 180;
      if (Math.abs(dphi) > band.halfWidthDeg) continue;
      read(row * w + col, px);
      r += px.r;
      g += px.g;
      b += px.b;
      n++;
    }
  }
  if (n === 0) throw new Error('sampleHorizonColor: the band holds no pixel');
  return { r: r / n, g: g / n, b: b / n };
}

/** The luminance below which `fraction` of the pixels lie (a log histogram: exact to about 1 %). */
export function luminancePercentile(img: EquirectImage, fraction: number): number {
  const { width: w, height: h } = img;
  const read = rgbReader(img);
  const px: Rgb = { r: 0, g: 0, b: 0 };
  const BINS = 2048;
  const LOG_MIN = Math.log(1e-4);
  const LOG_SPAN = Math.log(MAX_LUMINANCE) - LOG_MIN;
  const counts = new Uint32Array(BINS);
  for (let p = 0; p < w * h; p++) {
    read(p, px);
    const l = luminanceOf(px.r, px.g, px.b);
    const bin = l <= 1e-4 ? 0 : Math.min(BINS - 1, Math.floor(((Math.log(Math.min(l, MAX_LUMINANCE)) - LOG_MIN) / LOG_SPAN) * BINS));
    counts[bin]++;
  }
  const target = fraction * w * h;
  let seen = 0;
  for (let i = 0; i < BINS; i++) {
    seen += counts[i];
    if (seen >= target) return Math.exp(LOG_MIN + ((i + 1) / BINS) * LOG_SPAN);
  }
  return MAX_LUMINANCE;
}

/**
 * A copy of the image with every pixel brighter than `cap` (luminance) scaled down to it, keeping its colour:
 * the sun disc and its closest glare are gone, the rest of the sky is as it was. Lit by this copy the scene
 * gets the sky's light only, and the sun's own light (and its shadows) comes from the directional light.
 * The input is not modified; the copy has the same data type.
 */
export function clampLuminance(img: EquirectImage, cap: number): EquirectImage {
  const { width: w, height: h } = img;
  const read = rgbReader(img);
  const px: Rgb = { r: 0, g: 0, b: 0 };
  const out = img.data.slice();
  const half = out instanceof Uint16Array;
  for (let p = 0; p < w * h; p++) {
    read(p, px);
    const l = luminanceOf(px.r, px.g, px.b);
    if (!(l > cap)) continue;
    const k = cap / l;
    if (half) {
      out[p * 4] = THREE.DataUtils.toHalfFloat(px.r * k);
      out[p * 4 + 1] = THREE.DataUtils.toHalfFloat(px.g * k);
      out[p * 4 + 2] = THREE.DataUtils.toHalfFloat(px.b * k);
    } else {
      out[p * 4] = px.r * k;
      out[p * 4 + 1] = px.g * k;
      out[p * 4 + 2] = px.b * k;
    }
  }
  return { data: out, width: w, height: h };
}

/**
 * A copy of the image with the colour of the sky pushed away from grey by `factor` (1 = unchanged, above 1 = bluer / more
 * vivid), growing smoothly from nothing at `fromDeg` of elevation to the full factor at `toDeg`: the horizon band (which
 * the fog matches, so fogged ground meets the sky without a seam) and everything below it are untouched, and so is the
 * luminance of every pixel. The input is not modified; the copy has the same data type.
 */
export function saturateSky(img: EquirectImage, factor: number, fromDeg: number, toDeg: number): EquirectImage {
  const { width: w, height: h } = img;
  const out = img.data.slice();
  if (factor === 1) return { data: out, width: w, height: h };
  const read = rgbReader(img);
  const px: Rgb = { r: 0, g: 0, b: 0 };
  const half = out instanceof Uint16Array;
  for (let row = 0; row < h; row++) {
    const elevation = (0.5 - (row + 0.5) / h) * 180;
    const t = Math.min(1, Math.max(0, (elevation - fromDeg) / (toDeg - fromDeg)));
    if (t <= 0) continue;
    const k = 1 + (factor - 1) * t * t * (3 - 2 * t);
    for (let column = 0; column < w; column++) {
      const p = row * w + column;
      read(p, px);
      const l = luminanceOf(px.r, px.g, px.b);
      const r = Math.max(0, l + (px.r - l) * k);
      const g = Math.max(0, l + (px.g - l) * k);
      const b = Math.max(0, l + (px.b - l) * k);
      if (half) {
        out[p * 4] = THREE.DataUtils.toHalfFloat(r);
        out[p * 4 + 1] = THREE.DataUtils.toHalfFloat(g);
        out[p * 4 + 2] = THREE.DataUtils.toHalfFloat(b);
      } else {
        out[p * 4] = r;
        out[p * 4 + 1] = g;
        out[p * 4 + 2] = b;
      }
    }
  }
  return { data: out, width: w, height: h };
}

/**
 * Irradiance the pixels above `cap` carry, in the image's own units: the sum over them of (luminance - cap) times
 * their solid angle (steradians). It is what `clampLuminance` removed, and so what the sun's directional light
 * has to supply for the scene to be lit as the HDRI says (with the surface facing the sun).
 */
export function irradianceAbove(img: EquirectImage, cap: number): number {
  const { width: w, height: h } = img;
  const read = rgbReader(img);
  const px: Rgb = { r: 0, g: 0, b: 0 };
  let sum = 0;
  for (let row = 0; row < h; row++) {
    const solidAngle = ((2 * Math.PI) / w) * (Math.PI / h) * Math.cos((0.5 - (row + 0.5) / h) * Math.PI);
    for (let col = 0; col < w; col++) {
      read(row * w + col, px);
      const l = luminanceOf(px.r, px.g, px.b);
      if (l > cap) sum += (l - cap) * solidAngle;
    }
  }
  return sum;
}
