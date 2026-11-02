import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import type { ThemeId } from '../mission/themes';

/**
 * Exponential fog is exp(-(distance * density)^2): the share of a target's contrast left at 1500 m
 * is exp(-(1500 * density)^2). Every theme keeps at least ~60 % of it, so a target stays visible in the scope.
 */
export interface SkyLook {
  /** Sun height above the horizon, degrees. */
  sunElevationDeg: number;
  /** Sun direction measured from +Z (behind the shooter) toward -X (left), degrees: the target is front-lit. */
  sunAzimuthDeg: number;
  turbidity: number;
  rayleigh: number;
  mieCoefficient: number;
  mieDirectionalG: number;
  /** Fog density, 1/m, and its colour. The desert and arctic haze match the sky's horizon colour (sampled from renders) so fogged terrain meets the sky cleanly; fog colour is not tone mapped. */
  fogDensity: number;
  hazeColor: number;
  sunColor: number;
  sunIntensity: number;
  /** Hemisphere light: sky colour, ground bounce colour, intensity. */
  skyLight: number;
  groundLight: number;
  hemisphereIntensity: number;
}

/** Per-theme sun, sky, haze and light. The desert is the stage-1 look, value for value. */
export const SKY_LOOKS: Record<ThemeId, SkyLook> = {
  // Late-afternoon sun: low, warm, dusty air. About three quarters of a target's contrast survives
  // at 1500 m; the 3 km map edge is mostly gone.
  desert: {
    sunElevationDeg: 18,
    sunAzimuthDeg: 60,
    turbidity: 10,
    rayleigh: 1.0,
    mieCoefficient: 0.01,
    mieDirectionalG: 0.82,
    fogDensity: 0.00035,
    hazeColor: 0xb9c3ca,
    sunColor: 0xffe2b8,
    sunIntensity: 4.0,
    skyLight: 0xb8cde6,
    groundLight: 0xc9ae80,
    hemisphereIntensity: 1.6,
  },
  // Cold, pale and hazy: heavy Rayleigh and Mie scattering (slightly higher turbidity than the desert)
  // gives a pale, blue-white sky, and the haze colour is the sky's horizon colour (sampled from a render),
  // so fogged snow meets the sky without a step. A slightly denser fog (about 63 % of the contrast left
  // at 1500 m) and a bright snow bounce.
  arctic: {
    sunElevationDeg: 22,
    sunAzimuthDeg: 70,
    turbidity: 10.5,
    rayleigh: 2.4,
    mieCoefficient: 0.02,
    mieDirectionalG: 0.85,
    fogDensity: 0.00045,
    hazeColor: 0xc7d3de,
    sunColor: 0xe6eeff,
    sunIntensity: 3.4,
    skyLight: 0xc7d8f0,
    groundLight: 0xd9e2ec,
    hemisphereIntensity: 1.8,
  },
  // Clear and blue: a higher sun, very little haze (low turbidity and Rayleigh scattering give a clean
  // blue), light fog (about 87 % of the contrast left at 1500 m) that tints distant grass blue.
  valley: {
    sunElevationDeg: 24,
    sunAzimuthDeg: 55,
    turbidity: 4,
    rayleigh: 0.7,
    mieCoefficient: 0.004,
    mieDirectionalG: 0.8,
    fogDensity: 0.00025,
    hazeColor: 0xa9c4de,
    sunColor: 0xfff0d6,
    sunIntensity: 4.2,
    skyLight: 0xa6c8f0,
    groundLight: 0x7a8f58,
    hemisphereIntensity: 1.5,
  },
};

/** Unit vector from the scene towards the sun of `look` (the shadow light uses the same one). */
export function sunDirectionOf(look: SkyLook): THREE.Vector3 {
  const elevation = (look.sunElevationDeg * Math.PI) / 180;
  const azimuth = (look.sunAzimuthDeg * Math.PI) / 180;
  return new THREE.Vector3(
    -Math.sin(azimuth) * Math.cos(elevation),
    Math.sin(elevation),
    Math.cos(azimuth) * Math.cos(elevation),
  );
}

export interface SkySetup {
  sky: Sky;
  /** Unit vector from the scene towards the sun. */
  sunDirection: THREE.Vector3;
  /** The sun light; `createShadowLight` makes this same light cast the shadows. */
  sun: THREE.DirectionalLight;
}

/** Add the sky dome, haze (fog) and sun/ambient lights of `theme` to the scene. */
export function createSky(scene: THREE.Scene, theme: ThemeId): SkySetup {
  const look = SKY_LOOKS[theme];
  const sunDirection = sunDirectionOf(look);

  const sky = new Sky();
  sky.scale.setScalar(50000);
  sky.frustumCulled = false;
  sky.renderOrder = -1000; // first: it only fills what the terrain does not cover
  const uniforms = sky.material.uniforms;
  uniforms['turbidity'].value = look.turbidity;
  uniforms['rayleigh'].value = look.rayleigh;
  uniforms['mieCoefficient'].value = look.mieCoefficient;
  uniforms['mieDirectionalG'].value = look.mieDirectionalG;
  uniforms['cloudCoverage'].value = 0; // clear sky
  uniforms['sunPosition'].value.copy(sunDirection);
  scene.add(sky);

  scene.fog = new THREE.FogExp2(look.hazeColor, look.fogDensity);

  const sun = new THREE.DirectionalLight(look.sunColor, look.sunIntensity);
  sun.position.copy(sunDirection).multiplyScalar(1000);
  scene.add(sun);
  // Sky light from above, a bounce from the ground below (warm sand, snow, grass).
  scene.add(new THREE.HemisphereLight(look.skyLight, look.groundLight, look.hemisphereIntensity));

  return { sky, sunDirection, sun };
}
