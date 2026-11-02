import * as THREE from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import type { ThemeId } from '../mission/themes';
import { clampLuminance, findSunDirection, luminancePercentile, sampleHorizonColor, yawBetween } from './hdri';
import type { EquirectImage, SunFind } from './hdri';

// Each theme's sky is an HDRI photograph (Poly Haven, CC0) used twice: as the background, and, with its sun cut out,
// as the image-based light of every standard material. The sun itself is the directional light (it casts the
// shadows). The HDRI is rotated about the vertical so ITS sun lands on the theme's sun azimuth (`sunAzimuthDeg`:
// behind the shooter, so the targets are front-lit and the glare never looks down the barrel); the sun ELEVATION
// is the HDRI's own (`sunElevationDeg` is set to it, desert 18 for 19.1, valley 48), because the sun disc in the
// picture and the shadows must agree. Rotating the picture (instead of moving the light to the picture's sun) keeps
// `sunDirectionOf(SKY_LOOKS[theme])` the one sun of the game: the shadow light, the terrain's baked shadows and the
// procedural fallback sky all read it.
// If the file cannot be loaded the procedural `Sky` shader that `createSky` adds stays: the stage-1 look.

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
  /** What changes when the HDRI sky replaces the procedural one. */
  hdri: HdriLook;
}

/** The HDRI sky's lighting: the HDRI carries the sky light, so these replace the procedural values above. */
export interface HdriLook {
  /** File under `assets/hdri/`. */
  file: string;
  /** Tone mapping exposure (the world pass; the first-person rifle keeps its own). */
  exposure: number;
  /**
   * Directional (sun) light intensity. Baked rather than measured at run time: the browser loads the HDRI as half
   * floats, which clip the sun disc at 65504 and would undercount it. It is the irradiance `irradianceAbove` finds in
   * the file (desert 7.8, valley 4.7, in the file's units), scaled by the exposure choice; the overcast arctic has
   * no sun, so it gets a weak light that gives soft shadows only.
   */
  sunIntensity: number;
  /** Image-based light intensity (`scene.environmentIntensity`). */
  environmentIntensity: number;
  /** Hemisphere light kept as a ground-bounce tint on top of the HDRI's own (its lower half is a grey-blue reflection, not sand, snow or grass). */
  hemisphereIntensity: number;
}

/** The HDRI's sun disc and glare are clamped to this luminance in the background copy (half floats allow 65504; the bloom would smear that over the screen). */
export const BACKGROUND_MAX_LUMINANCE = 40;
/** The lighting copy of the HDRI is clamped at this percentile of its luminance: the sky's own light stays, the sun leaves (the directional light is the sun). */
export const ENVIRONMENT_CAP_PERCENTILE = 0.995;
/** The fog colour is the HDRI's horizon between these elevations, degrees, in a sector this wide (half-width), centred on the view direction. */
export const HAZE_ELEVATION_MIN_DEG = 0;
export const HAZE_ELEVATION_MAX_DEG = 3;
export const HAZE_HALF_WIDTH_DEG = 40;

/**
 * Per-theme sun, sky, haze and light. Without the HDRI the desert is the stage-1 look, value for value; the valley's
 * sun is raised from 24 to the HDRI's 48 degrees.
 */
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
    // qwantani_late_afternoon: a low sun (19.1 degrees in the file, 18 here: the difference is invisible) in a hazy sky.
    hdri: { file: 'desert.hdr', exposure: 0.55, sunIntensity: 7.8, environmentIntensity: 1, hemisphereIntensity: 0.25 },
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
    // snow_field_2: a solid overcast: no sun disc, so the light is nearly all sky and the directional light only adds
    // soft shadows (azimuth from the brightest patch of cloud, elevation as designed).
    hdri: { file: 'arctic.hdr', exposure: 0.8, sunIntensity: 1.2, environmentIntensity: 1, hemisphereIntensity: 0.2 },
  },
  // Clear and blue: a higher sun, very little haze (low turbidity and Rayleigh scattering give a clean
  // blue), light fog (about 87 % of the contrast left at 1500 m) that tints distant grass blue.
  valley: {
    sunElevationDeg: 48, // the HDRI's sun ("kloofendal 48d"); the procedural fallback sky shows it there too
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
    // kloofendal_48d_partly_cloudy: the sun stands 48 degrees high among small cumulus.
    hdri: { file: 'valley.hdr', exposure: 0.85, sunIntensity: 4.7, environmentIntensity: 1, hemisphereIntensity: 0.3 },
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
  /** Sky and ground-bounce light. */
  hemisphere: THREE.HemisphereLight;
}

/** Names `applyHdriSky` finds the objects of `createSky` by (so `buildWorld` need not pass them on). */
export const SKY_OBJECT_NAMES = { sky: 'sky', sun: 'sun', hemisphere: 'hemisphere' } as const;

/**
 * Add the procedural sky dome, haze (fog) and sun/ambient lights of `theme` to the scene: the look without the
 * HDRI, and what stays if its file cannot be loaded. `applyHdriSky` upgrades it.
 */
export function createSky(scene: THREE.Scene, theme: ThemeId): SkySetup {
  const look = SKY_LOOKS[theme];
  const sunDirection = sunDirectionOf(look);

  const sky = new Sky();
  sky.name = SKY_OBJECT_NAMES.sky;
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
  sun.name = SKY_OBJECT_NAMES.sun;
  sun.position.copy(sunDirection).multiplyScalar(1000);
  scene.add(sun);
  // Sky light from above, a bounce from the ground below (warm sand, snow, grass).
  const hemisphere = new THREE.HemisphereLight(look.skyLight, look.groundLight, look.hemisphereIntensity);
  hemisphere.name = SKY_OBJECT_NAMES.hemisphere;
  scene.add(hemisphere);

  return { sky, sunDirection, sun, hemisphere };
}

/** The HDRI as loaded: pixels only (nothing is uploaded to the GPU until `applyHdriSky`). */
export interface SkyHdri {
  theme: ThemeId;
  image: EquirectImage;
}

/** Longest the mission start waits for the HDRI, ms; then the procedural sky stays. */
export const HDRI_TIMEOUT_MS = 12000;

/**
 * Fetch and decode the theme's HDRI (RGBE .hdr, half floats). Resolves to null, with a warning, when it cannot be
 * had (missing file, bad data, no answer within `timeoutMs`): the caller keeps the procedural sky. `url` overrides
 * the file (tests, tools).
 */
export async function loadSkyHdri(theme: ThemeId, opts: { url?: string; timeoutMs?: number } = {}): Promise<SkyHdri | null> {
  const url = opts.url ?? `${import.meta.env.BASE_URL}assets/hdri/${SKY_LOOKS[theme].hdri.file}`;
  const timeoutMs = opts.timeoutMs ?? HDRI_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
    });
    const texture = await Promise.race([new HDRLoader().loadAsync(url), timeout]);
    const { data, width, height } = texture.image as { data: Uint16Array | Float32Array; width: number; height: number };
    if (!(data instanceof Uint16Array || data instanceof Float32Array) || data.length < width * height * 4) {
      throw new Error('not an RGBA float image');
    }
    return { theme, image: { data, width, height } };
  } catch (error) {
    console.warn(`HDRI sky ${url} not loaded, using the procedural sky:`, error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface HdriSkyResult {
  /** The HDRI's own sun as found in the picture (its frame, before the rotation). */
  measured: SunFind;
  /** Rotation about +Y, radians, that carries the HDRI's sun onto the theme's sun azimuth (`makeRotationY` sense). */
  yawRad: number;
  /** The fog colour, linear: the HDRI's horizon in the viewer's direction. */
  hazeColor: THREE.Color;
}

/**
 * `scene.backgroundRotation.y` / `environmentRotation.y` are `yawRad` times this: three turns an equirect background and
 * environment by the same `makeRotationY` sense as the mathematical rotation (world direction = R(yaw) * HDRI direction),
 * hence +1. Found with a render aimed at the sun (scratch check: the HDRI's sun disc sits on the light's direction).
 */
export const BACKGROUND_ROTATION_SIGN = 1 as const;

/** The viewer's looking direction (world -Z), in the HDRI's own frame: `atan2(z, x)`, degrees, for a world-to-HDRI rotation of `yawRad`. */
export function viewPhiInHdriDeg(yawRad: number): number {
  // World direction w = R(yaw) h, and R(t) takes azimuth phi to phi - t, so h = R(-yaw) w sits at phi_w + yaw.
  return -90 + (yawRad * 180) / Math.PI;
}

/** Everything `applyHdriSky` derives from the picture alone (pure: no GL). */
export interface HdriPlan extends HdriSkyResult {
  /** The picture for the background: the sun disc's extreme values clipped. */
  backgroundImage: EquirectImage;
  /** The picture for the image-based light: the sun cut out (the directional light is the sun). */
  lightingImage: EquirectImage;
}

/**
 * Where the HDRI's sun is and the turn that puts it on the theme's sun azimuth, the fog colour (the horizon in the
 * direction the viewer faces) and the two prepared copies of the picture. Fog is mixed in linear light before the
 * tone mapping of the post pass, like the sky pixels beside it, so equal linear colours give no seam.
 */
export function planHdriSky(theme: ThemeId, image: EquirectImage): HdriPlan {
  const look = SKY_LOOKS[theme];
  const measured = findSunDirection(image);
  const yawRad = yawBetween(measured.direction, sunDirectionOf(look));
  const horizon = sampleHorizonColor(image, {
    centerPhiDeg: viewPhiInHdriDeg(yawRad),
    halfWidthDeg: HAZE_HALF_WIDTH_DEG,
    elevationMinDeg: HAZE_ELEVATION_MIN_DEG,
    elevationMaxDeg: HAZE_ELEVATION_MAX_DEG,
  });
  return {
    measured,
    yawRad,
    hazeColor: new THREE.Color().setRGB(horizon.r, horizon.g, horizon.b, THREE.LinearSRGBColorSpace),
    backgroundImage: clampLuminance(image, BACKGROUND_MAX_LUMINANCE),
    lightingImage: clampLuminance(image, luminancePercentile(image, ENVIRONMENT_CAP_PERCENTILE)),
  };
}

/**
 * Replace the procedural sky of `scene` (made by `createSky`) with the HDRI: background, image-based light,
 * horizon-matched fog, exposure, and the sun/hemisphere lights recalibrated for it. Synchronous; needs the renderer
 * for the PMREM filter. The shadow light keeps the direction `createSky` gave it (the theme's sun).
 */
export function applyHdriSky(renderer: THREE.WebGLRenderer, scene: THREE.Scene, theme: ThemeId, hdri: SkyHdri): HdriSkyResult {
  const look = SKY_LOOKS[theme];
  const plan = planHdriSky(theme, hdri.image);
  const rotation = BACKGROUND_ROTATION_SIGN * plan.yawRad;

  scene.background = hdriTexture(plan.backgroundImage);
  scene.backgroundRotation.set(0, rotation, 0);

  // Filtered for rough and diffuse lookups; the equirect copy is only needed for that.
  const lighting = hdriTexture(plan.lightingImage);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment?.dispose();
  scene.environment = pmrem.fromEquirectangular(lighting).texture;
  pmrem.dispose();
  lighting.dispose();
  scene.environmentRotation.set(0, rotation, 0);
  scene.environmentIntensity = look.hdri.environmentIntensity;

  if (scene.fog) scene.fog.color.copy(plan.hazeColor);

  // The procedural dome would cover the background; the lights are recalibrated for image-based lighting.
  const dome = scene.getObjectByName(SKY_OBJECT_NAMES.sky) as Sky | undefined;
  if (dome) {
    dome.removeFromParent();
    dome.geometry.dispose();
    dome.material.dispose();
  }
  const sun = scene.getObjectByName(SKY_OBJECT_NAMES.sun) as THREE.DirectionalLight | undefined;
  if (sun) sun.intensity = look.hdri.sunIntensity;
  const hemisphere = scene.getObjectByName(SKY_OBJECT_NAMES.hemisphere) as THREE.HemisphereLight | undefined;
  if (hemisphere) hemisphere.intensity = look.hdri.hemisphereIntensity;
  renderer.toneMappingExposure = look.hdri.exposure;

  return { measured: plan.measured, yawRad: plan.yawRad, hazeColor: plan.hazeColor };
}

/** An equirectangular float texture of `image`, in the state `HDRLoader` gives its own. */
function hdriTexture(image: EquirectImage): THREE.DataTexture {
  const type = image.data instanceof Uint16Array ? THREE.HalfFloatType : THREE.FloatType;
  const texture = new THREE.DataTexture(image.data, image.width, image.height, THREE.RGBAFormat, type);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.LinearSRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.flipY = true;
  texture.needsUpdate = true;
  return texture;
}
