import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { ThemeId } from '../mission/themes';
import { LEGACY_EXPOSURE } from './renderer';
import { SKY_LOOKS, sunDirectionOf } from './sky';

// Post-processing: the world is drawn into a half-float, multisampled target (so lighting is linear HDR; the canvas's
// own antialiasing does not reach a render target), a subtle bloom picks up what is far brighter than a lit surface
// (the sun, glints), and the output pass tone maps (per-theme exposure), encodes sRGB and, in the same shader, applies
// a per-theme lift/gamma/gain + saturation grade and a sliver of dither (the smooth HDRI sky would otherwise band in
// 8 bits). The first-person rifle is NOT part of the composer: it keeps its own render (its own scene, depth cleared,
// its own tone mapping, additive flash with `toneMapped: false`) and is drawn on top of the finished picture, exactly
// as before; so its muzzle flash does not bloom (it would need an HDR flash colour in `rifle.ts`). The scope overlay
// and the reticle are DOM and untouched. The logarithmic depth buffer works in the composer: the render target has
// its own depth buffer and the materials' log-depth shader code is the same.

/** `high`: 4x multisampling, bloom and grade; `low`: 2x multisampling and grade, no bloom; `off`: no composer at all (today's direct render and sky, no grade). */
export type PostQuality = 'high' | 'low' | 'off';

/** `?post=low` or `?post=off` in the page URL picks the cheaper path; anything else is `high`. (A separate parameter: the mission code is not touched.) */
export function postQualityFromSearch(search: string): PostQuality {
  const value = new URLSearchParams(search).get('post');
  return value === 'low' || value === 'off' ? value : 'high';
}

/** Multisampling of the composer's render target by quality (measured on an integrated GPU: 4 samples on a half-float target cost about 5 ms more than 2). */
export const POST_SAMPLES = { high: 4, low: 2 } as const;
/** Bloom is drawn only while the sun is within this many degrees of the view (the glare reaches that far past the frame's edge). */
export const BLOOM_MARGIN_DEG = 25;
/** The bloom's own targets are half the output's resolution (UnrealBloomPass); divided once more by this: bloom is soft, so a quarter of the pixels costs nothing visible. */
export const BLOOM_EXTRA_DIVISOR = 2;

export interface BloomParams {
  strength: number;
  radius: number;
  /** Linear scene luminance (before exposure) above which a pixel blooms. A sunlit surface is about 1-3, a glint on metal or the sun's disc far above. */
  threshold: number;
}

/** Subtle: only what is far brighter than a lit surface blooms (see `BloomParams.threshold`). */
export const BLOOM: Record<ThemeId, BloomParams> = {
  desert: { strength: 0.25, radius: 0.5, threshold: 3 },
  arctic: { strength: 0.18, radius: 0.5, threshold: 3 },
  valley: { strength: 0.25, radius: 0.5, threshold: 3 },
};

/**
 * Colour grade in display (sRGB) values: `out = pow(clamp(c * gain + lift), 1 / gamma)`, then saturation about the
 * luminance. Gentle by design (the tests bound every value): a warm cast for the desert, cold and a little
 * desaturated for the arctic, lively greens for the valley.
 */
export interface GradeParams {
  /** Added to every channel before gamma (r, g, b). */
  lift: [number, number, number];
  gamma: [number, number, number];
  gain: [number, number, number];
  /** 1 = unchanged, 0 = grey. */
  saturation: number;
}

export const GRADES: Record<ThemeId, GradeParams> = {
  desert: { lift: [0.008, 0.004, 0], gamma: [1, 1, 1], gain: [1.03, 1.0, 0.95], saturation: 1.06 },
  arctic: { lift: [0, 0.002, 0.006], gamma: [1, 1, 1], gain: [0.99, 1.0, 1.02], saturation: 0.88 },
  valley: { lift: [0.002, 0.004, 0.004], gamma: [1, 1, 1], gain: [1.0, 1.02, 0.99], saturation: 1.1 },
};

/** The neutral grade: changes nothing. */
export const NEUTRAL_GRADE: GradeParams = { lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1], saturation: 1 };

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** The grade of the last pass on one pixel (sRGB values 0-1), in JavaScript: the shader's twin, for tests and tools. */
export function applyGrade(rgb: readonly [number, number, number], g: GradeParams): [number, number, number] {
  const v = [0, 1, 2].map((i) => Math.pow(clamp01(rgb[i] * g.gain[i] + g.lift[i]), 1 / g.gamma[i]));
  const luma = 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  return [0, 1, 2].map((i) => luma + (v[i] - luma) * g.saturation) as [number, number, number];
}

const GRADE_DECLARATIONS = /* glsl */ `
		uniform vec3 gradeLift;
		uniform vec3 gradeInvGamma;
		uniform vec3 gradeGain;
		uniform float gradeSaturation;
		uniform float gradeDither;
`;

/** Runs on the display-referred colour, after the tone mapping and the sRGB encoding. `gradeDither` is in 8-bit steps. */
const GRADE_CODE = /* glsl */ `
			vec3 graded = pow( clamp( gl_FragColor.rgb * gradeGain + gradeLift, 0.0, 1.0 ), gradeInvGamma );
			float gradedLuma = dot( graded, vec3( 0.2126, 0.7152, 0.0722 ) );
			graded = mix( vec3( gradedLuma ), graded, gradeSaturation );
			// interleaved gradient noise: a cheap, stable per-pixel value in [0, 1)
			graded += ( fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) ) - 0.5 ) * gradeDither / 255.0;
			gl_FragColor.rgb = graded;
`;

/**
 * three.js's `OutputPass` (tone mapping + sRGB encoding) with the grade appended to its fragment shader: one full-screen
 * pass instead of two. Throws if the pass's shader no longer has the shape this patch expects (three is pinned, and a
 * test builds this, so a three upgrade that changes it fails there).
 */
function gradedOutputPass(g: GradeParams): OutputPass {
  const pass = new OutputPass();
  const source = pass.material.fragmentShader;
  const declarations = 'uniform sampler2D tDiffuse;';
  const tail = /(#ifdef SRGB_TRANSFER[\s\S]*?#endif)(\s*\}\s*)$/;
  if (!source.includes(declarations) || !tail.test(source)) {
    throw new Error('postfx: three.js OutputPass has a different shader than the grade patch expects');
  }
  pass.material.fragmentShader = source.replace(declarations, declarations + GRADE_DECLARATIONS).replace(tail, `$1\n${GRADE_CODE}$2`);
  // `pass.uniforms` is the material's uniforms object, read when the program is first built.
  pass.uniforms['gradeLift'] = { value: new THREE.Vector3(...g.lift) };
  pass.uniforms['gradeInvGamma'] = { value: new THREE.Vector3(1 / g.gamma[0], 1 / g.gamma[1], 1 / g.gamma[2]) };
  pass.uniforms['gradeGain'] = { value: new THREE.Vector3(...g.gain) };
  pass.uniforms['gradeSaturation'] = { value: g.saturation };
  pass.uniforms['gradeDither'] = { value: 1 };
  return pass;
}

const DEG = Math.PI / 180;

/**
 * Whether the sun (unit direction `sun`) is in a perspective view looking along `forward`, or within `marginDeg` of its
 * edge: the angle between them is at most the frame's half-diagonal plus the margin.
 */
export function sunNearView(
  forward: { x: number; y: number; z: number },
  sun: { x: number; y: number; z: number },
  fovVerticalDeg: number,
  aspect: number,
  marginDeg: number,
): boolean {
  const halfDiagonal = Math.atan(Math.tan((fovVerticalDeg * DEG) / 2) * Math.hypot(1, aspect));
  const lengths = Math.hypot(forward.x, forward.y, forward.z) * Math.hypot(sun.x, sun.y, sun.z);
  if (!(lengths > 0)) return false;
  const cos = (forward.x * sun.x + forward.y * sun.y + forward.z * sun.z) / lengths;
  return Math.acos(Math.max(-1, Math.min(1, cos))) <= halfDiagonal + marginDeg * DEG;
}

export interface PostFxOptions {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  theme: ThemeId;
  quality: PostQuality;
  /** Draws what goes over the finished picture (the first-person rifle); it clears the depth itself. */
  overlay?: () => void;
}

export interface PostFx {
  quality: PostQuality;
  /** The passes in drawing order (empty when `quality` is `off`): render, bloom (high only), output (with the grade). */
  passes: readonly object[];
  /** Null when `quality` is `off`. */
  composer: EffectComposer | null;
  /** Null unless `quality` is `high`. Drawn only while the sun is near the view (see `sunNearView`). */
  bloom: UnrealBloomPass | null;
  /** The output pass, whose `gradeLift`, `gradeGain`, ... uniforms hold the theme's grade; null when `quality` is `off`. */
  output: OutputPass | null;
  /** Draw one frame; `withOverlay`: draw the overlay (the rifle) on top. Resets `renderer.info` first, so its counts cover every pass of the frame. */
  render(withOverlay: boolean): void;
  /** CSS size of the canvas; call after `resizeRenderer`. */
  setSize(width: number, height: number): void;
  dispose(): void;
}

/**
 * The post-processing chain of a theme. With `quality: 'off'` there is no composer (the world is rendered straight to the
 * canvas, as before the HDRI sky) and `render` only adds the overlay; the tone mapping is then the renderer's.
 * Builds without WebGL (only `render` needs it), so it is unit-tested in Node with a stub renderer.
 */
export function createPostFx(opts: PostFxOptions): PostFx {
  const { renderer, scene, camera, theme, quality, overlay } = opts;
  // The composer renders several times a frame; `info` is reset by hand once per frame so it counts all of them.
  renderer.info.autoReset = false;

  if (quality === 'off') {
    return {
      quality,
      passes: [],
      composer: null,
      bloom: null,
      output: null,
      render(withOverlay) {
        renderer.info.reset();
        renderer.render(scene, camera);
        if (withOverlay) overlay?.();
      },
      setSize() {},
      dispose() {},
    };
  }

  const size = renderer.getSize(new THREE.Vector2());
  const pixelRatio = renderer.getPixelRatio();
  const target = new THREE.WebGLRenderTarget(size.x * pixelRatio, size.y * pixelRatio, {
    type: THREE.HalfFloatType,
    samples: POST_SAMPLES[quality],
  });
  target.texture.name = 'PostFx.rt1';
  const composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(pixelRatio);
  composer.setSize(size.x, size.y);

  const passes: object[] = [];
  const add = <P extends { enabled: boolean }>(pass: P): P => {
    composer.addPass(pass as never);
    passes.push(pass);
    return pass;
  };

  add(new RenderPass(scene, camera));

  let bloom: UnrealBloomPass | null = null;
  if (quality === 'high') {
    const b = BLOOM[theme];
    bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), b.strength, b.radius, b.threshold);
    const setBloomSize = bloom.setSize.bind(bloom);
    bloom.setSize = (width, height) => setBloomSize(width / BLOOM_EXTRA_DIVISOR, height / BLOOM_EXTRA_DIVISOR);
    add(bloom);
  }

  const output = add(gradedOutputPass(GRADES[theme]));

  const sun = sunDirectionOf(SKY_LOOKS[theme]);
  const forward = new THREE.Vector3();
  return {
    quality,
    passes,
    composer,
    bloom,
    output,
    render(withOverlay) {
      renderer.info.reset();
      if (bloom) {
        camera.getWorldDirection(forward);
        bloom.enabled = sunNearView(forward, sun, camera.fov, camera.aspect, BLOOM_MARGIN_DEG);
      }
      composer.render();
      if (withOverlay && overlay) {
        // The rifle has its own lighting, tuned for the stage-1 exposure: it keeps it whatever the sky's exposure is.
        const exposure = renderer.toneMappingExposure;
        renderer.toneMappingExposure = LEGACY_EXPOSURE;
        overlay();
        renderer.toneMappingExposure = exposure;
      }
    },
    setSize(width, height) {
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(width, height);
    },
    dispose() {
      composer.dispose();
      for (const pass of passes) (pass as { dispose?: () => void }).dispose?.();
    },
  };
}
