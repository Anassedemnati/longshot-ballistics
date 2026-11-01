import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';

/** Late-afternoon sun: low, warm, behind and to the left of the shooter so the target is front-lit. */
const SUN_ELEVATION_DEG = 18;
const SUN_AZIMUTH_DEG = 60; // from +Z (behind the shooter) toward -X (left)

/** Exponential fog density, 1/m. About three quarters of a target's contrast survives at 1500 m; the 3 km map edge is mostly gone. */
const FOG_DENSITY = 0.00035;
/** Pale haze, close to the sky colour at the horizon so fogged terrain meets the sky cleanly (fog colour is not tone mapped). */
const HAZE_COLOR = 0xb9c3ca;

export interface SkySetup {
  sky: Sky;
  /** Unit vector from the scene towards the sun. */
  sunDirection: THREE.Vector3;
}

/** Add the sky dome, haze (fog) and sun/ambient lights to the scene. */
export function createSky(scene: THREE.Scene): SkySetup {
  const elevation = (SUN_ELEVATION_DEG * Math.PI) / 180;
  const azimuth = (SUN_AZIMUTH_DEG * Math.PI) / 180;
  const sunDirection = new THREE.Vector3(
    -Math.sin(azimuth) * Math.cos(elevation),
    Math.sin(elevation),
    Math.cos(azimuth) * Math.cos(elevation),
  );

  const sky = new Sky();
  sky.scale.setScalar(50000);
  sky.frustumCulled = false;
  sky.renderOrder = -1000; // first: it only fills what the terrain does not cover
  const uniforms = sky.material.uniforms;
  uniforms['turbidity'].value = 10; // dusty desert air
  uniforms['rayleigh'].value = 1.0;
  uniforms['mieCoefficient'].value = 0.01;
  uniforms['mieDirectionalG'].value = 0.82;
  uniforms['cloudCoverage'].value = 0; // clear sky
  uniforms['sunPosition'].value.copy(sunDirection);
  scene.add(sky);

  scene.fog = new THREE.FogExp2(HAZE_COLOR, FOG_DENSITY);

  const sun = new THREE.DirectionalLight(0xffe2b8, 4.0);
  sun.position.copy(sunDirection).multiplyScalar(1000);
  scene.add(sun);
  // Sky light from above, warm sand bounce from below.
  scene.add(new THREE.HemisphereLight(0xb8cde6, 0xc9ae80, 1.6));

  return { sky, sunDirection };
}
