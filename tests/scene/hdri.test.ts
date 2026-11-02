// @ts-expect-error the project has no Node typings (tsconfig types: vite/client); vitest runs in Node
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { describe, expect, it } from 'vitest';
import {
  clampLuminance,
  elevationDegOf,
  equirectDirection,
  findSunDirection,
  irradianceAbove,
  lookAzimuthDegOf,
  luminancePercentile,
  luminanceOf,
  sampleHorizonColor,
  yawBetween,
} from '../../src/scene/hdri';
import type { Dir3, EquirectImage } from '../../src/scene/hdri';

const DEG = Math.PI / 180;
const W = 512;
const H = 256;

const unitFrom = (elevationDeg: number, phiDeg: number): Dir3 => {
  const e = elevationDeg * DEG;
  const p = phiDeg * DEG;
  return { x: Math.cos(p) * Math.cos(e), y: Math.sin(e), z: Math.sin(p) * Math.cos(e) };
};
const angleBetweenDeg = (a: Dir3, b: Dir3): number => Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z))) / DEG;

/** A flat sky of `base` with a gaussian blob (sigma in degrees) of `peak` at (elevation, phi). `half`: store half floats. */
function sky(opts: { base: number | ((elevationDeg: number, phiDeg: number) => number[]); blob?: { elevationDeg: number; phiDeg: number; peak: number; sigmaDeg: number }; half?: boolean }): EquirectImage {
  const f = new Float32Array(W * H * 4);
  const target = opts.blob ? unitFrom(opts.blob.elevationDeg, opts.blob.phiDeg) : null;
  for (let row = 0; row < H; row++) {
    for (let col = 0; col < W; col++) {
      const d = equirectDirection(col, row, W, H);
      const e = elevationDegOf(d);
      const phi = ((col + 0.5) / W - 0.5) * 360;
      const base = typeof opts.base === 'number' ? [opts.base, opts.base, opts.base] : opts.base(e, phi);
      let boost = 0;
      if (opts.blob && target) {
        const a = angleBetweenDeg(d, target);
        boost = opts.blob.peak * Math.exp(-(a * a) / (2 * opts.blob.sigmaDeg ** 2));
      }
      const i = (row * W + col) * 4;
      f[i] = base[0] + boost;
      f[i + 1] = base[1] + boost;
      f[i + 2] = base[2] + boost;
      f[i + 3] = 1;
    }
  }
  if (!opts.half) return { data: f, width: W, height: H };
  const h16 = new Uint16Array(f.length);
  for (let i = 0; i < f.length; i++) h16[i] = THREE.DataUtils.toHalfFloat(Math.min(f[i], 60000));
  return { data: h16, width: W, height: H };
}

describe('equirect conventions', () => {
  it('column W/2 looks along +x, +z is a quarter of the way across, and row 0 is up', () => {
    // Column W/2 sits at phi = 0 + half a pixel: direction ~ +X; the first row is near the zenith.
    const mid = equirectDirection(W / 2, H / 2, W, H);
    expect(mid.x).toBeGreaterThan(0.999);
    expect(equirectDirection(10, 0, W, H).y).toBeGreaterThan(0.99);
    expect(equirectDirection(10, H - 1, W, H).y).toBeLessThan(-0.99);
    // +z is phi = +90 degrees: a quarter of the way across
    const z = equirectDirection(W * 0.75, H / 2, W, H);
    expect(z.z).toBeGreaterThan(0.99);
  });

  it('look azimuth is measured from +Z toward -X, like SkyLook.sunAzimuthDeg', () => {
    expect(lookAzimuthDegOf({ x: 0, y: 0, z: 1 })).toBeCloseTo(0, 6);
    expect(lookAzimuthDegOf({ x: -1, y: 0, z: 0 })).toBeCloseTo(90, 6);
    expect(lookAzimuthDegOf({ x: 1, y: 0, z: 0 })).toBeCloseTo(-90, 6);
    expect(elevationDegOf({ x: 0, y: 1, z: 1 })).toBeCloseTo(45, 6);
  });
});

describe('findSunDirection', () => {
  for (const half of [false, true]) {
    it(`finds a sun disc on a flat sky to within a degree (${half ? 'half floats' : 'floats'})`, () => {
      const img = sky({ base: 0.3, blob: { elevationDeg: 32, phiDeg: 40, peak: 50000, sigmaDeg: 0.6 }, half });
      const sun = findSunDirection(img);
      expect(angleBetweenDeg(sun.direction, unitFrom(32, 40))).toBeLessThan(1);
      expect(sun.elevationDeg).toBeCloseTo(32, 0);
      expect(sun.distinct).toBe(true);
      expect(sun.peak).toBeGreaterThan(1000);
    });
  }

  it('finds a sun across the seam of the image (phi +-180)', () => {
    for (const phi of [179, -179, 180]) {
      const img = sky({ base: 0.2, blob: { elevationDeg: 15, phiDeg: phi, peak: 20000, sigmaDeg: 0.8 } });
      expect(angleBetweenDeg(findSunDirection(img).direction, unitFrom(15, phi))).toBeLessThan(1.5);
    }
  });

  it('on an overcast sky with a broad bright patch gives the middle of the patch and says it is not a disc', () => {
    const img = sky({ base: 0.5, blob: { elevationDeg: 25, phiDeg: -70, peak: 1.2, sigmaDeg: 14 } });
    const sun = findSunDirection(img);
    expect(angleBetweenDeg(sun.direction, unitFrom(25, -70))).toBeLessThan(8);
    expect(sun.distinct).toBe(false);
  });

  it('ignores a dim speck: the brightest region wins over one hot pixel', () => {
    const img = sky({ base: 0.2, blob: { elevationDeg: 40, phiDeg: 100, peak: 5000, sigmaDeg: 1.5 } });
    // a single hot pixel elsewhere, brighter than the sun's peak but much smaller
    img.data[(60 * W + 300) * 4] = 9000;
    img.data[(60 * W + 300) * 4 + 1] = 9000;
    img.data[(60 * W + 300) * 4 + 2] = 9000;
    expect(angleBetweenDeg(findSunDirection(img).direction, unitFrom(40, 100))).toBeLessThan(2);
  });
});

describe('yawBetween', () => {
  it('is the Y rotation that takes the sun onto the target azimuth, whatever the elevations', () => {
    const cases: [Dir3, Dir3][] = [
      [unitFrom(19, 36), unitFrom(18, -120)],
      [unitFrom(48, 34), unitFrom(24, 170)],
      [unitFrom(7, -170), unitFrom(22, 175)],
    ];
    for (const [from, to] of cases) {
      const v = new THREE.Vector3(from.x, from.y, from.z).applyMatrix4(new THREE.Matrix4().makeRotationY(yawBetween(from, to)));
      // same azimuth as `to`, same elevation as `from`
      expect(Math.atan2(v.z, v.x)).toBeCloseTo(Math.atan2(to.z, to.x), 6);
      expect(v.y).toBeCloseTo(from.y, 9);
    }
  });
});

describe('sampleHorizonColor', () => {
  const colored = sky({
    base: (e, phi) => {
      if (e < 0) return [0, 1, 0]; // below the horizon: green
      if (e > 6) return [0, 0, 1]; // high sky: blue
      return phi < 0 ? [1, 0, 0] : [0.5, 0.25, 0]; // the horizon band: red to the west, orange to the east
    },
  });

  it('averages only the band asked for', () => {
    const c = sampleHorizonColor(colored, { centerPhiDeg: -90, halfWidthDeg: 40, elevationMinDeg: 0, elevationMaxDeg: 5 });
    expect(c.r).toBeCloseTo(1, 6);
    expect(c.g).toBeCloseTo(0, 6);
    expect(c.b).toBeCloseTo(0, 6);
    const e = sampleHorizonColor(colored, { centerPhiDeg: 90, halfWidthDeg: 40, elevationMinDeg: 0, elevationMaxDeg: 5 });
    expect(e.r).toBeCloseTo(0.5, 6);
    expect(e.g).toBeCloseTo(0.25, 6);
  });

  it('wraps a sector across the seam and reads half floats', () => {
    const half = sky({ base: (_e, phi) => (Math.abs(phi) > 150 ? [0.5, 0.5, 0.5] : [0.1, 0.1, 0.1]), half: true });
    const c = sampleHorizonColor(half, { centerPhiDeg: 180, halfWidthDeg: 25, elevationMinDeg: -3, elevationMaxDeg: 3 });
    expect(c.r).toBeCloseTo(0.5, 2);
  });

  it('throws on an empty band', () => {
    expect(() => sampleHorizonColor(colored, { centerPhiDeg: 0, halfWidthDeg: 10, elevationMinDeg: 80.001, elevationMaxDeg: 80.002 })).toThrow();
  });
});

describe('clamping the sun out of the lighting', () => {
  const img = sky({ base: 0.4, blob: { elevationDeg: 30, phiDeg: 20, peak: 30000, sigmaDeg: 0.7 } });

  it('luminancePercentile sits in the sky, far below the sun', () => {
    const p = luminancePercentile(img, 0.995);
    expect(p).toBeGreaterThan(0.35);
    expect(p).toBeLessThan(5);
  });

  it('clampLuminance removes the disc, keeps the rest and the original, and keeps the colour', () => {
    const before = findSunDirection(img).peak;
    const cap = luminancePercentile(img, 0.995);
    const clamped = clampLuminance(img, cap);
    expect(findSunDirection(clamped).peak).toBeLessThanOrEqual(cap * 1.01);
    expect(findSunDirection(img).peak).toBe(before); // untouched
    // a pixel far from the sun is identical
    const far = (10 * W + 400) * 4;
    expect(clamped.data[far]).toBe(img.data[far]);
    // colour is kept: scale a coloured hot pixel
    const tinted = sky({ base: 0.3 });
    tinted.data[0] = 100;
    tinted.data[1] = 50;
    tinted.data[2] = 25;
    const c = clampLuminance(tinted, 10);
    expect(c.data[0] / c.data[1]).toBeCloseTo(2, 5);
    expect(luminanceOf(c.data[0], c.data[1], c.data[2])).toBeCloseTo(10, 5);
  });

  it('works on half floats and keeps the type', () => {
    const h = sky({ base: 0.4, blob: { elevationDeg: 30, phiDeg: 20, peak: 30000, sigmaDeg: 0.7 }, half: true });
    const c = clampLuminance(h, 3);
    expect(c.data).toBeInstanceOf(Uint16Array);
    expect(findSunDirection(c).peak).toBeLessThan(3.1);
  });

  it('irradianceAbove is the energy clampLuminance removes: more for a brighter sun, none without one', () => {
    const cap = 3;
    const e = irradianceAbove(img, cap);
    expect(e).toBeGreaterThan(0);
    const dimmer = sky({ base: 0.4, blob: { elevationDeg: 30, phiDeg: 20, peak: 15000, sigmaDeg: 0.7 } });
    expect(irradianceAbove(dimmer, cap)).toBeLessThan(e * 0.6);
    expect(irradianceAbove(sky({ base: 0.4 }), cap)).toBe(0);
  });
});

describe('the shipped HDRIs', () => {
  const load = (name: string): EquirectImage => {
    const bytes: Uint8Array = readFileSync(new URL(`../../public/assets/hdri/${name}.hdr`, import.meta.url));
    const tex = new HDRLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer) as unknown as EquirectImage;
    return { data: tex.data, width: tex.width, height: tex.height };
  };

  it('desert: a distinct late-afternoon sun, low in the sky', () => {
    const sun = findSunDirection(load('desert'));
    expect(sun.distinct).toBe(true);
    expect(sun.elevationDeg).toBeGreaterThan(17);
    expect(sun.elevationDeg).toBeLessThan(21);
  });

  it('valley: a distinct sun at about 48 degrees ("kloofendal 48d")', () => {
    const sun = findSunDirection(load('valley'));
    expect(sun.distinct).toBe(true);
    expect(sun.elevationDeg).toBeGreaterThan(46);
    expect(sun.elevationDeg).toBeLessThan(50);
  });

  it('arctic: overcast, no sun disc', () => {
    expect(findSunDirection(load('arctic')).distinct).toBe(false);
  });
});
