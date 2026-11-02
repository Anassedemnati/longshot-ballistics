// @ts-expect-error the project has no Node typings (tsconfig types: vite/client); vitest runs in Node
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ThemeId } from '../../src/mission/themes';
import { equirectDirection, findSunDirection, irradianceAbove, luminancePercentile } from '../../src/scene/hdri';
import type { EquirectImage } from '../../src/scene/hdri';
import {
  BACKGROUND_MAX_LUMINANCE,
  ENVIRONMENT_CAP_PERCENTILE,
  SKY_LOOKS,
  createSky,
  loadSkyHdri,
  planHdriSky,
  sunDirectionOf,
  viewPhiInHdriDeg,
} from '../../src/scene/sky';

const THEMES: ThemeId[] = ['desert', 'arctic', 'valley'];
const DEG = Math.PI / 180;

const shipped = (theme: ThemeId, type: THREE.TextureDataType = THREE.HalfFloatType): EquirectImage => {
  const bytes: Uint8Array = readFileSync(new URL(`../../public/assets/hdri/${SKY_LOOKS[theme].hdri.file}`, import.meta.url));
  const loader = new HDRLoader();
  loader.type = type;
  const tex = loader.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer) as unknown as EquirectImage;
  return { data: tex.data, width: tex.width, height: tex.height };
};

describe('the HDRI looks of each theme', () => {
  it('every theme names a file that exists and has sane lighting values', () => {
    for (const theme of THEMES) {
      const h = SKY_LOOKS[theme].hdri;
      expect(h.file).toMatch(/^[a-z]+\.hdr$/);
      expect(() => shipped(theme)).not.toThrow();
      expect(h.exposure).toBeGreaterThan(0.2);
      expect(h.exposure).toBeLessThan(1.5);
      expect(h.sunIntensity).toBeGreaterThan(0);
      expect(h.environmentIntensity).toBeGreaterThan(0.3);
      expect(h.hemisphereIntensity).toBeLessThan(SKY_LOOKS[theme].hemisphereIntensity); // the HDRI carries the sky light now
    }
  });

  it('the sun elevation of the look is the one in the picture, where the picture has a sun', () => {
    for (const theme of ['desert', 'valley'] as const) {
      const measured = findSunDirection(shipped(theme));
      expect(measured.distinct).toBe(true);
      expect(Math.abs(measured.elevationDeg - SKY_LOOKS[theme].sunElevationDeg)).toBeLessThan(1.5);
    }
    // The overcast arctic has no disc: it only borrows the azimuth of its brightest cloud.
    expect(findSunDirection(shipped('arctic')).distinct).toBe(false);
  });

  it('sun intensity follows the irradiance the sun carries in the file (desert, valley) and the overcast arctic stays gentle', () => {
    for (const theme of ['desert', 'valley'] as const) {
      const img = shipped(theme, THREE.FloatType); // half floats clip the disc at 65504: measure on floats
      const cap = luminancePercentile(img, ENVIRONMENT_CAP_PERCENTILE);
      const e = irradianceAbove(img, cap);
      expect(SKY_LOOKS[theme].hdri.sunIntensity / e).toBeGreaterThan(0.85);
      expect(SKY_LOOKS[theme].hdri.sunIntensity / e).toBeLessThan(1.15);
    }
    const arctic = shipped('arctic', THREE.FloatType);
    expect(irradianceAbove(arctic, luminancePercentile(arctic, ENVIRONMENT_CAP_PERCENTILE))).toBeLessThan(0.5);
    expect(SKY_LOOKS.arctic.hdri.sunIntensity).toBeLessThan(SKY_LOOKS.valley.hdri.sunIntensity / 2);
  });
});

describe('planHdriSky on the shipped skies', () => {
  for (const theme of THEMES) {
    it(`${theme}: turning the HDRI by the yaw puts its sun on the look's azimuth; fog is a plausible horizon colour; copies are prepared`, () => {
      const image = shipped(theme);
      const plan = planHdriSky(theme, image);
      const d = plan.measured.direction;
      const rotated = new THREE.Vector3(d.x, d.y, d.z).applyMatrix4(new THREE.Matrix4().makeRotationY(plan.yawRad));
      const want = sunDirectionOf(SKY_LOOKS[theme]);
      expect(Math.atan2(rotated.z, rotated.x)).toBeCloseTo(Math.atan2(want.z, want.x), 6);
      // fog: neither black nor blown out, and every channel above zero
      const c = plan.hazeColor;
      const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
      expect(lum).toBeGreaterThan(0.15);
      expect(lum).toBeLessThan(2);
      expect(Math.min(c.r, c.g, c.b)).toBeGreaterThan(0);
      // the background keeps the sky but not an absurd sun; the lighting copy has the sun cut out
      expect(findSunDirection(plan.backgroundImage).peak).toBeLessThanOrEqual(BACKGROUND_MAX_LUMINANCE * 1.01);
      expect(findSunDirection(plan.lightingImage).peak).toBeLessThan(findSunDirection(plan.backgroundImage).peak + 1e-6);
      expect(findSunDirection(plan.lightingImage).distinct).toBe(false);
      expect(plan.backgroundImage.width).toBe(image.width);
    });
  }

  it('the fog colours differ by theme the way the skies do: neutral desert haze (the warm glare is on the sun side), bluish valley, neutral-cool arctic', () => {
    const haze = (t: ThemeId): THREE.Color => planHdriSky(t, shipped(t)).hazeColor;
    expect(Math.abs(haze('desert').r - haze('desert').b) / haze('desert').g).toBeLessThan(0.15);
    expect(haze('valley').b).toBeGreaterThan(haze('valley').r * 1.15); // blue
    expect(Math.abs(haze('arctic').r - haze('arctic').b) / haze('arctic').g).toBeLessThan(0.25); // near neutral
    // the sector faces away from the sun glare: darker than the horizon all round
    expect(haze('desert').g).toBeLessThan(0.7);
  });
});

describe('the fog faces the viewer', () => {
  it('samples the horizon in the direction of world -Z after the HDRI is turned, not the whole ring', () => {
    const W = 512;
    const H = 256;
    const data = new Float32Array(W * H * 4);
    const sunPhi = 40; // the picture's sun, degrees (atan2(z, x))
    for (let row = 0; row < H; row++) {
      for (let col = 0; col < W; col++) {
        const phi = ((col + 0.5) / W - 0.5) * 360;
        const e = (0.5 - (row + 0.5) / H) * 180;
        const i = (row * W + col) * 4;
        let rgb = [0.3, 0.3, 0.3];
        // the horizon band facing the viewer: where the world's -Z lies in the HDRI frame for the desert (sun az 60 deg):
        // 120 degrees on from the sun's own direction
        const facing = 40 + 120;
        if (e >= 0 && e <= 3 && Math.abs(((phi - facing + 540) % 360) - 180) < 40) rgb = [1, 0.1, 0.1];
        // a distinct sun disc
        const d = equirectDirection(col, row, W, H);
        const s = new THREE.Vector3(Math.cos(sunPhi * DEG) * Math.cos(20 * DEG), Math.sin(20 * DEG), Math.sin(sunPhi * DEG) * Math.cos(20 * DEG));
        const a = Math.acos(Math.min(1, d.x * s.x + d.y * s.y + d.z * s.z)) / DEG;
        const boost = 30000 * Math.exp(-(a * a) / (2 * 0.7 * 0.7));
        data[i] = rgb[0] + boost;
        data[i + 1] = rgb[1] + boost;
        data[i + 2] = rgb[2] + boost;
        data[i + 3] = 1;
      }
    }
    const plan = planHdriSky('desert', { data, width: W, height: H });
    expect(plan.hazeColor.r).toBeGreaterThan(0.9);
    expect(plan.hazeColor.g).toBeLessThan(0.2);
    expect((((viewPhiInHdriDeg(plan.yawRad) - 160 + 540) % 360) - 180)).toBeCloseTo(0, 0); // 160 degrees, modulo a turn
  });
});

describe('loadSkyHdri', () => {
  afterEach(() => vi.restoreAllMocks());

  it('resolves to null (with a warning) when the file cannot be loaded, so the procedural sky stays', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await loadSkyHdri('desert', { url: 'http://127.0.0.1:1/nope.hdr', timeoutMs: 5000 })).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('gives up after the timeout', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // a server that never answers is simulated by a loader promise that never settles
    const spy = vi.spyOn(HDRLoader.prototype, 'loadAsync').mockImplementation(() => new Promise(() => {}));
    const t0 = Date.now();
    expect(await loadSkyHdri('valley', { url: 'x', timeoutMs: 50 })).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(spy).toHaveBeenCalled();
  });
});

describe('createSky keeps the procedural look as the fallback and can be upgraded', () => {
  it('names its objects so applyHdriSky finds them without the world passing them on', () => {
    for (const theme of THEMES) {
      const scene = new THREE.Scene();
      const setup = createSky(scene, theme);
      expect(scene.getObjectByName('sky')).toBe(setup.sky);
      expect(scene.getObjectByName('sun')).toBe(setup.sun);
      expect(scene.getObjectByName('hemisphere')).toBe(setup.hemisphere);
    }
  });
});
