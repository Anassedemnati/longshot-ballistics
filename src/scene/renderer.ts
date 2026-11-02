import * as THREE from 'three';

/** Tone mapping exposure of the stage-1 look: the renderer's default, which the direct render without the post chain (`?post=off`, or the procedural sky) keeps, rifle included. With the HDRI sky the world's is per theme (`SKY_LOOKS[theme].hdri.exposure`), the rifle's too. */
export const LEGACY_EXPOSURE = 0.9;

/** Pixel ratio cap: beyond 2x the extra pixels cost frame rate and add nothing visible. */
const MAX_PIXEL_RATIO = 2;

/**
 * Whether this browser can reverse the depth range (`EXT_clip_control`): three.js's `reversedDepthBuffer`. Probed on a throwaway
 * canvas, which is released again.
 */
export function reversedDepthSupported(): boolean {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return false;
    const supported = gl.getExtension('EXT_clip_control') !== null;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return supported;
  } catch {
    return false;
  }
}

export interface RendererOptions {
  /**
   * The world is drawn into the post chain's own multisampled float target, not onto the canvas: the canvas then needs no
   * antialiasing (its 4x buffer would only cost a resolve of the final full-screen pass), and the depth buffer can be reversed
   * (the target has a 32-bit float one; the canvas's is 24-bit fixed point, which reversing does not help). Without the chain
   * (`?post=off`) the world is drawn onto the canvas with 4x antialiasing and a logarithmic depth buffer.
   */
  composer?: boolean;
  /** The render pixel ratio to start at (default: the display's, at most `MAX_PIXEL_RATIO`). */
  pixelRatio?: number;
}

/**
 * WebGL renderer sized to the window and attached to `parent`. Throws if WebGL is unavailable.
 * Far targets (1.5 km) and a 0.1 m near plane need more depth range than a linear buffer gives: a reversed float depth buffer
 * where the chain draws (precision stays fine to the far plane, and the depth test is a plain one the GPU can reject early,
 * unlike the logarithmic buffer, whose every fragment writes its own depth), a logarithmic one otherwise.
 */
export function createRenderer(parent: HTMLElement, opts: RendererOptions = {}): THREE.WebGLRenderer {
  const composer = opts.composer === true;
  const reversed = composer && reversedDepthSupported();
  const renderer = new THREE.WebGLRenderer({
    antialias: !composer,
    reversedDepthBuffer: reversed,
    logarithmicDepthBuffer: !reversed,
    powerPreference: 'high-performance',
  });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = LEGACY_EXPOSURE;
  renderer.setPixelRatio(opts.pixelRatio ?? Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.domElement.style.display = 'block';
  parent.appendChild(renderer.domElement);
  return renderer;
}

/** Resize the drawing buffer (CSS size w x h) at `pixelRatio` (default: the display's, at most `MAX_PIXEL_RATIO`). */
export function resizeRenderer(renderer: THREE.WebGLRenderer, width: number, height: number, pixelRatio?: number): void {
  renderer.setPixelRatio(pixelRatio ?? Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
  renderer.setSize(width, height);
}
