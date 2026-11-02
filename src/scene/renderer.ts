import * as THREE from 'three';

/** Tone mapping exposure of the stage-1 look. The first-person rifle (its own lighting is tuned for it) is always drawn with it; the world's is per theme (`SKY_LOOKS[theme].hdri.exposure`). */
export const LEGACY_EXPOSURE = 0.9;

/** Pixel ratio cap: beyond 2x the extra pixels cost frame rate and add nothing visible. */
const MAX_PIXEL_RATIO = 2;

/** WebGL renderer sized to the window and attached to `parent`. Throws if WebGL is unavailable. */
export function createRenderer(parent: HTMLElement): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    // Far targets (1.5 km) and a 0.1 m near plane need more depth range than a linear buffer gives.
    logarithmicDepthBuffer: true,
    powerPreference: 'high-performance',
  });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = LEGACY_EXPOSURE;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.domElement.style.display = 'block';
  parent.appendChild(renderer.domElement);
  return renderer;
}

/** Resize the drawing buffer (CSS size w x h) and keep the pixel ratio current. */
export function resizeRenderer(renderer: THREE.WebGLRenderer, width: number, height: number): void {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
  renderer.setSize(width, height);
}
