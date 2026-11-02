import * as THREE from 'three';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { describe, expect, it, vi } from 'vitest';
import type { ThemeId } from '../../src/mission/themes';
import {
  BLOOM,
  BLOOM_MARGIN_DEG,
  GRADES,
  NEUTRAL_GRADE,
  POST_SAMPLES,
  applyGrade,
  createPostFx,
  postQualityFromSearch,
  sunNearView,
} from '../../src/scene/postfx';
import { LEGACY_EXPOSURE } from '../../src/scene/renderer';

const THEMES: ThemeId[] = ['desert', 'arctic', 'valley'];

/** The little of a WebGLRenderer the composer's constructor and `render` bookkeeping touch (no GL in Node). */
function stubRenderer(): THREE.WebGLRenderer {
  return {
    getSize: (v: THREE.Vector2) => v.set(1280, 720),
    getPixelRatio: () => 2,
    toneMappingExposure: 0.55,
    info: { autoReset: true, reset: vi.fn() },
    render: vi.fn(),
  } as unknown as THREE.WebGLRenderer;
}

describe('postQualityFromSearch', () => {
  it('is high unless ?post=low or ?post=off is given, and ignores the mission code', () => {
    expect(postQualityFromSearch('')).toBe('high');
    expect(postQualityFromSearch('?m=v2.d.300.300.1.0.0.9.308.n.n.1.r.0.0.0&debug=1')).toBe('high');
    expect(postQualityFromSearch('?post=low')).toBe('low');
    expect(postQualityFromSearch('?debug=1&post=off')).toBe('off');
    expect(postQualityFromSearch('?post=ultra')).toBe('high');
  });
});

describe('colour grade', () => {
  it('the neutral grade changes nothing', () => {
    for (const c of [[0, 0, 0], [0.2, 0.5, 0.9], [1, 1, 1], [0.33, 0.33, 0.8]] as const) {
      const out = applyGrade(c, NEUTRAL_GRADE);
      for (let i = 0; i < 3; i++) expect(out[i]).toBeCloseTo(c[i], 9);
    }
  });

  it('applies gain, lift, gamma and saturation as documented', () => {
    const g = { lift: [0.1, 0, 0] as [number, number, number], gamma: [2, 1, 1] as [number, number, number], gain: [0.5, 1, 1] as [number, number, number], saturation: 1 };
    const out = applyGrade([0.6, 0.3, 0.3], g);
    expect(out[0]).toBeCloseTo(Math.sqrt(0.6 * 0.5 + 0.1), 9);
    expect(out[1]).toBeCloseTo(0.3, 9);
    const grey = applyGrade([0.8, 0.4, 0.2], { ...NEUTRAL_GRADE, saturation: 0 });
    expect(grey[0]).toBeCloseTo(grey[1], 9);
    expect(grey[1]).toBeCloseTo(grey[2], 9);
    expect(applyGrade([2, -1, 0.5], NEUTRAL_GRADE)).toEqual([1, 0, 0.5]); // clamped to the displayable range
  });

  it('each theme has a gentle grade: small cast, no crushed or blown tones, saturation near 1', () => {
    for (const theme of THEMES) {
      const g = GRADES[theme];
      for (let i = 0; i < 3; i++) {
        expect(Math.abs(g.gain[i] - 1)).toBeLessThanOrEqual(0.06);
        expect(Math.abs(g.lift[i])).toBeLessThanOrEqual(0.02);
        expect(Math.abs(g.gamma[i] - 1)).toBeLessThanOrEqual(0.1);
      }
      expect(Math.abs(g.saturation - 1)).toBeLessThanOrEqual(0.12);
      // black stays near black, white near white, a mid grey near itself
      const black = applyGrade([0, 0, 0], g);
      const white = applyGrade([1, 1, 1], g);
      const mid = applyGrade([0.5, 0.5, 0.5], g);
      for (let i = 0; i < 3; i++) {
        expect(black[i]).toBeLessThan(0.03);
        expect(white[i]).toBeGreaterThan(0.93);
        expect(Math.abs(mid[i] - 0.5)).toBeLessThan(0.06);
      }
    }
  });

  it('the themes differ the way they should: warm desert, cold and muted arctic, lively valley', () => {
    expect(GRADES.desert.gain[0]).toBeGreaterThan(GRADES.desert.gain[2]);
    expect(GRADES.arctic.gain[2]).toBeGreaterThan(GRADES.arctic.gain[0]);
    expect(GRADES.arctic.saturation).toBeLessThan(1);
    expect(GRADES.valley.saturation).toBeGreaterThan(1);
    const warm = applyGrade([0.5, 0.5, 0.5], GRADES.desert);
    expect(warm[0]).toBeGreaterThan(warm[2]);
    const cold = applyGrade([0.5, 0.5, 0.5], GRADES.arctic);
    expect(cold[2]).toBeGreaterThan(cold[0]);
  });

  it('bloom is subtle and only takes what is far brighter than a lit surface', () => {
    for (const theme of THEMES) {
      expect(BLOOM[theme].threshold).toBeGreaterThanOrEqual(2);
      expect(BLOOM[theme].strength).toBeLessThanOrEqual(0.4);
      expect(BLOOM[theme].radius).toBeGreaterThanOrEqual(0);
      expect(BLOOM[theme].radius).toBeLessThanOrEqual(1);
    }
  });
});

describe('sunNearView', () => {
  const fwd = { x: 0, y: 0, z: -1 };
  const at = (azimuthDeg: number, elevationDeg: number) => {
    const a = (azimuthDeg * Math.PI) / 180;
    const e = (elevationDeg * Math.PI) / 180;
    return { x: Math.sin(a) * Math.cos(e), y: Math.sin(e), z: -Math.cos(a) * Math.cos(e) };
  };

  it('is true for a sun in the frame, including its corners, and false for one behind the viewer', () => {
    // 60 degree vertical fov, 16:9: horizontal half-angle about 46.8, half-diagonal about 49.7
    expect(sunNearView(fwd, at(0, 0), 60, 16 / 9, 0)).toBe(true);
    expect(sunNearView(fwd, at(40, 20), 60, 16 / 9, 0)).toBe(true);
    expect(sunNearView(fwd, at(60, 0), 60, 16 / 9, 0)).toBe(false);
    expect(sunNearView(fwd, at(170, 18), 60, 16 / 9, BLOOM_MARGIN_DEG)).toBe(false);
  });

  it('the margin lets the glare of a sun just outside the frame in, and a narrow scope field shrinks the frame', () => {
    expect(sunNearView(fwd, at(70, 0), 60, 16 / 9, 0)).toBe(false);
    expect(sunNearView(fwd, at(70, 0), 60, 16 / 9, BLOOM_MARGIN_DEG)).toBe(true);
    // through the scope (2 degrees of field) only the sun nearly in line counts
    expect(sunNearView(fwd, at(10, 0), 2, 1.78, BLOOM_MARGIN_DEG)).toBe(true);
    expect(sunNearView(fwd, at(40, 0), 2, 1.78, BLOOM_MARGIN_DEG)).toBe(false);
  });

  it('does not accept a zero vector', () => {
    expect(sunNearView({ x: 0, y: 0, z: 0 }, at(0, 0), 60, 1.78, 10)).toBe(false);
  });
});

describe('createPostFx (built without WebGL)', () => {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 16 / 9);

  for (const theme of THEMES) {
    it(`${theme}, high: render, bloom, output (with the grade) in that order, on a 2x multisampled half-float target`, () => {
      const renderer = stubRenderer();
      const post = createPostFx({ renderer, scene, camera, theme, quality: 'high' });
      const [render, bloom, output] = post.passes;
      expect(post.passes).toHaveLength(3);
      expect(render).toBeInstanceOf(RenderPass);
      expect((render as RenderPass).scene).toBe(scene);
      expect((render as RenderPass).camera).toBe(camera);
      expect(bloom).toBeInstanceOf(UnrealBloomPass);
      expect(bloom).toBe(post.bloom);
      expect((bloom as UnrealBloomPass).threshold).toBe(BLOOM[theme].threshold);
      expect((bloom as UnrealBloomPass).strength).toBe(BLOOM[theme].strength);
      expect(output).toBeInstanceOf(OutputPass);
      expect(output).toBe(post.output);
      expect(post.composer?.passes[post.composer.passes.length - 1]).toBe(output); // the last pass draws to the screen
      const u = post.output!.uniforms;
      const g = GRADES[theme];
      expect(u['gradeGain'].value.toArray()).toEqual(g.gain);
      expect(u['gradeLift'].value.toArray()).toEqual(g.lift);
      expect(u['gradeSaturation'].value).toBe(g.saturation);
      expect(post.composer?.renderTarget1.samples).toBe(POST_SAMPLES.high);
      expect(post.composer?.renderTarget1.texture.type).toBe(THREE.HalfFloatType);
      // sized to the drawing buffer: 1280 x 720 CSS px at pixel ratio 2
      expect(post.composer?.renderTarget1.width).toBe(2560);
      expect(post.composer?.renderTarget1.height).toBe(1440);
      expect(renderer.info.autoReset).toBe(false);
    });
  }

  it('the output pass carries the grade in its own shader (one full-screen pass), and keeps the tone mapping and sRGB code', () => {
    const post = createPostFx({ renderer: stubRenderer(), scene, camera, theme: 'desert', quality: 'high' });
    const fragment = post.output!.material.fragmentShader;
    expect(fragment).toContain('uniform vec3 gradeGain;');
    expect(fragment).toContain('gl_FragColor.rgb = graded;');
    expect(fragment).toContain('ACESFilmicToneMapping');
    // the grade comes after the sRGB encoding, inside main()
    expect(fragment.indexOf('sRGBTransferOETF')).toBeLessThan(fragment.indexOf('gl_FragColor.rgb = graded;'));
    expect(fragment.trimEnd().endsWith('}')).toBe(true);
  });

  it('bloom runs at a quarter of the output resolution', () => {
    const post = createPostFx({ renderer: stubRenderer(), scene, camera, theme: 'valley', quality: 'high' });
    // 1280 x 720 at pixel ratio 2 = 2560 x 1440; UnrealBloomPass halves it, the extra divisor halves it again
    expect(post.bloom!.renderTargetBright.width).toBe(640);
    expect(post.bloom!.renderTargetBright.height).toBe(360);
  });

  it('low: no multisampling and no bloom pass', () => {
    const post = createPostFx({ renderer: stubRenderer(), scene, camera, theme: 'desert', quality: 'low' });
    expect(post.bloom).toBeNull();
    expect(post.passes).toHaveLength(2);
    expect(post.passes.some((p) => p instanceof UnrealBloomPass)).toBe(false);
    expect(post.composer?.renderTarget1.samples).toBe(POST_SAMPLES.low);
  });

  it('setSize resizes the target to the pixel ratio and the bloom with it', () => {
    const renderer = stubRenderer();
    const post = createPostFx({ renderer, scene, camera, theme: 'valley', quality: 'high' });
    post.setSize(800, 600);
    expect(post.composer?.renderTarget1.width).toBe(1600);
    expect(post.composer?.renderTarget2.height).toBe(1200);
    expect(post.bloom!.renderTargetBright.width).toBe(400);
  });

  it('bloom is drawn only while the sun is near the view', () => {
    const renderer = stubRenderer();
    const cam = new THREE.PerspectiveCamera(60, 16 / 9);
    const post = createPostFx({ renderer, scene, camera: cam, theme: 'desert', quality: 'high' });
    post.composer!.render = () => {};
    // The desert sun is behind the shooter (azimuth 60 deg from +Z): looking along -Z it is far out of view
    cam.rotation.set(0, 0, 0);
    cam.updateMatrixWorld(true);
    post.render(false);
    expect(post.bloom!.enabled).toBe(false);
    // turned round to face it: yaw 180 + 60 (looking along +Z rotated toward -X)
    cam.rotation.set((18 * Math.PI) / 180, Math.PI + -(60 * Math.PI) / 180, 0, 'YXZ');
    cam.updateMatrixWorld(true);
    post.render(false);
    expect(post.bloom!.enabled).toBe(true);
  });

  it('the overlay (the rifle) is drawn after the composer, at the stage-1 exposure, only when asked, and the exposure comes back', () => {
    const renderer = stubRenderer();
    const seen: number[] = [];
    const post = createPostFx({ renderer, scene, camera, theme: 'desert', quality: 'high', overlay: () => seen.push(renderer.toneMappingExposure) });
    const order: string[] = [];
    post.composer!.render = () => void order.push(`composer@${renderer.toneMappingExposure}`);
    post.render(true);
    post.render(false);
    expect(seen).toEqual([LEGACY_EXPOSURE]);
    expect(renderer.toneMappingExposure).toBe(0.55);
    expect(renderer.info.reset).toHaveBeenCalledTimes(2); // once per frame, so the counts cover every pass
    expect(order).toEqual(['composer@0.55', 'composer@0.55']);
  });

  it('off: no composer, the world is rendered straight to the canvas and the overlay follows', () => {
    const renderer = stubRenderer();
    const calls: string[] = [];
    (renderer.render as ReturnType<typeof vi.fn>).mockImplementation(() => calls.push('world'));
    const post = createPostFx({ renderer, scene, camera, theme: 'arctic', quality: 'off', overlay: () => calls.push('rifle') });
    expect(post.passes).toHaveLength(0);
    expect(post.composer).toBeNull();
    post.render(true);
    post.render(false);
    expect(calls).toEqual(['world', 'rifle', 'world']);
    expect(renderer.info.autoReset).toBe(false);
    expect(renderer.info.reset).toHaveBeenCalledTimes(2);
    expect(() => post.setSize(100, 100)).not.toThrow();
  });
});
