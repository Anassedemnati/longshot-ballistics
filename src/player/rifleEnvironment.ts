import * as THREE from 'three';

// The rifle is drawn in a scene of its own, so the world's sky is not there to reflect. This is a tiny stand-in: a
// sky-to-sand gradient dome with a hot sun and two soft boxes, baked once into a PMREM that lights and reflects off
// the metal, the polymer and the scope glass. Colours are linear and deliberately neutral-warm (a strongly blue
// dome would tint the steel and the lens).

/** Dome radius, m (the PMREM camera sits at the middle). */
const DOME_RADIUS_M = 50;
/** Where the sun is, as a direction from the rifle: behind-left and well up, so the glass catches it. */
const SUN_DIRECTION = new THREE.Vector3(-0.45, 0.62, 0.64).normalize();

const ZENITH = new THREE.Color().setRGB(0.3, 0.36, 0.46);
const HORIZON = new THREE.Color().setRGB(0.95, 0.86, 0.72);
const GROUND = new THREE.Color().setRGB(0.5, 0.43, 0.34);

/** The dome colour toward height `t` (-1 straight down .. 1 straight up). */
function domeColor(t: number, out: THREE.Color): THREE.Color {
  if (t >= 0) return out.copy(HORIZON).lerp(ZENITH, Math.pow(t, 0.55));
  return out.copy(HORIZON).lerp(GROUND, Math.min(1, -t * 4));
}

/** A glowing panel at `direction`, `distance` m away, facing the origin; `intensity` can exceed 1 (HDR). */
function panel(width: number, height: number, direction: THREE.Vector3, color: number, intensity: number): THREE.Mesh {
  const material = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, toneMapped: false });
  material.color.multiplyScalar(intensity);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
  mesh.position.copy(direction).multiplyScalar(DOME_RADIUS_M * 0.8);
  mesh.lookAt(0, 0, 0);
  return mesh;
}

/** The scene baked into the rifle's environment map. Needs no WebGL to build. */
export function buildEnvironmentScene(): THREE.Scene {
  const scene = new THREE.Scene();
  scene.name = 'rifle-environment';

  const dome = new THREE.SphereGeometry(DOME_RADIUS_M, 48, 24);
  const colors = new Float32Array(dome.attributes.position.count * 3);
  const color = new THREE.Color();
  for (let i = 0; i < dome.attributes.position.count; i++) {
    domeColor(dome.attributes.position.getY(i) / DOME_RADIUS_M, color);
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  dome.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  scene.add(new THREE.Mesh(dome, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, toneMapped: false })));

  // The sun: small and very bright (a glint on the lens, a streak down the barrel).
  const sun = panel(6, 6, SUN_DIRECTION, 0xfff0d8, 40);
  scene.add(sun);
  // A wide soft box up and to the right (fill on the stock and the glove) and a low warm strip (ground bounce).
  scene.add(panel(26, 12, new THREE.Vector3(0.7, 0.55, 0.45).normalize(), 0xfff4e6, 3.2));
  scene.add(panel(40, 4, new THREE.Vector3(0.1, -0.25, 0.95).normalize(), 0xf2d6a8, 1.6));
  return scene;
}

const cache = new WeakMap<THREE.WebGLRenderer, THREE.Texture>();

/**
 * The rifle's environment map for `renderer` (baked on first use, then shared). The bake renders a few cube faces:
 * those draws are taken back out of the renderer's `info` so the frame's draw-call reading stays the rifle's own.
 */
export function rifleEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const known = cache.get(renderer);
  if (known) return known;
  const { calls, triangles, points, lines, frame } = renderer.info.render;
  const generator = new THREE.PMREMGenerator(renderer);
  const scene = buildEnvironmentScene();
  const target = generator.fromScene(scene, 0.02, 0.1, DOME_RADIUS_M * 2);
  generator.dispose();
  scene.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      object.geometry.dispose();
      (object.material as THREE.Material).dispose();
    }
  });
  const info = renderer.info.render;
  info.calls = calls;
  info.triangles = triangles;
  info.points = points;
  info.lines = lines;
  info.frame = frame;
  cache.set(renderer, target.texture);
  return target.texture;
}
