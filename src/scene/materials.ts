import * as THREE from 'three';
import type { ThemeId } from '../mission/themes';

// Materials of the scenery (houses, sheds, compound walls, parked and target vehicles): one cached
// MeshStandardMaterial per theme and part class, shared by every prop of that theme. The meshes are
// merged per class (scene/props.ts), so a prop costs a handful of draw calls.
//
// Look. The photographic Poly Haven textures (public/assets/textures, CC0) carry the surface detail and the
// weathering; their own colour does not: each diffuse map is divided by its own average colour in the shader,
// so it only modulates the albedo around 1 and the theme's tint (the material colour, times a per-part tone in
// the vertex colours) decides the hue. A green rusty metal map therefore gives sand, white or olive paint with
// the same scratches and rust spots. On top of that a vertical dirt gradient (dust, slush, mud) darkens the
// lowest metre. Without the textures (loading failed, or no DOM as in the unit tests) the materials keep the
// flat tint and the dirt gradient.
//
// UVs are world scale (see `boxProjectUV`): one texture repeat covers TEXTURE_REPEAT_M metres of surface, on
// every face of every box, so a long wall is not stretched and neighbouring boxes line up.

/** One texture repeat spans this many metres of surface (box-projected UVs in the prop frame). */
export const TEXTURE_REPEAT_M = 2;

export interface UV {
  u: number;
  v: number;
}

/**
 * World-scale box-projected UV of a point of a box face, in the prop frame (metres). The face is picked by the
 * dominant axis of the outward normal; u runs to the right and v upwards as seen from outside (top faces:
 * u = +x, v = -z), so no face is mirrored, and both are the in-plane position divided by `repeatM`. Equal metres
 * give equal UV on every axis.
 */
export function boxProjectUV(x: number, y: number, z: number, nx: number, ny: number, nz: number, repeatM = TEXTURE_REPEAT_M, out: UV = { u: 0, v: 0 }): UV {
  const ax = Math.abs(nx);
  const ay = Math.abs(ny);
  const az = Math.abs(nz);
  let u: number;
  let v: number;
  if (ax >= ay && ax >= az) {
    u = nx > 0 ? -z : z;
    v = y;
  } else if (az >= ay) {
    u = nz > 0 ? x : -x;
    v = y;
  } else {
    u = x;
    v = ny > 0 ? -z : z;
  }
  out.u = u / repeatM;
  out.v = v / repeatM;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Looks

/** What a merged mesh of a prop is made of: plaster/timber walls, roof slabs, trim (frames, doors), unlit-detail plain parts (tyres, vents), glass, vehicle paint. */
export type PartClass = 'wall' | 'roof' | 'trim' | 'plain' | 'glass' | 'paint';
export const PART_CLASSES: readonly PartClass[] = ['wall', 'roof', 'trim', 'plain', 'glass', 'paint'];

type TexName = 'plaster_clay' | 'plaster_white' | 'planks' | 'metal_paint' | 'snow';

/** Average colour of each diffuse map in linear RGB (measured once; the shader divides the map by it). */
const TEXTURE_MEAN: Record<TexName, [number, number, number]> = {
  plaster_clay: [0.1697, 0.102, 0.0451],
  plaster_white: [0.341, 0.2627, 0.1882],
  planks: [0.3286, 0.3028, 0.2533],
  metal_paint: [0.0499, 0.0738, 0.0342],
  snow: [0.3792, 0.3787, 0.3892],
};

interface ClassLook {
  /** Texture set (`<name>_diff|nor|rough.jpg`); null = a flat colour. */
  texture: TexName | null;
  /** The material colour (sRGB hex): the average colour of the surface. Null: white, the parts carry their colours in the vertex colours. */
  tint: number | null;
  roughness: number;
  metalness: number;
  normalScale: number;
  /** How hard the texture's variation around its average shows (1 = as photographed). */
  contrast: number;
  /** How much of the texture's own hue variation is kept (0 = luminance only; rust spots are hue). */
  hueKeep: number;
  /** Dirt gradient: colour (sRGB hex), how much of the lowest part it covers (0..1) and how high it reaches, m. */
  dirt: number;
  dirtAmount: number;
  dirtHeight: number;
  /** Strength (0..1) of the large-scale weathering: blotches and rain streaks that differ from one instance to the next. */
  macro: number;
}

const look = (l: Partial<ClassLook> & Pick<ClassLook, 'texture' | 'tint'>): ClassLook => ({
  roughness: 0.9,
  metalness: 0,
  normalScale: 0.8,
  contrast: 1.4,
  hueKeep: 0.6,
  dirt: 0x000000,
  dirtAmount: 0,
  dirtHeight: 1,
  macro: 0,
  ...l,
});

const GLASS_LOOK = look({ texture: null, tint: 0x3a4d5c, roughness: 0.08, metalness: 0.25 });
const PLAIN_LOOK = (dirt: number): ClassLook => look({ texture: null, tint: null, roughness: 0.82, dirt, dirtAmount: 0.3, dirtHeight: 0.5, macro: 0.3 });
const TRIM_LOOK = (dirt: number): ClassLook => look({ texture: 'planks', tint: null, roughness: 0.85, normalScale: 1, contrast: 1.1, hueKeep: 0.3, dirt, dirtAmount: 0.3, dirtHeight: 0.6, macro: 0.35 });

const LOOKS: Record<ThemeId, Record<PartClass, ClassLook>> = {
  // Desert: mud-brick plaster under a flat mud roof; sand, khaki paint under dust.
  desert: {
    wall: look({ texture: 'plaster_clay', tint: 0xb89a6c, roughness: 0.95, contrast: 1.9, hueKeep: 0.5, dirt: 0x6c5638, dirtAmount: 0.5, dirtHeight: 1.1, macro: 1 }),
    roof: look({ texture: 'plaster_clay', tint: 0x937852, roughness: 0.95, contrast: 1.9, hueKeep: 0.5, macro: 0.7 }),
    trim: TRIM_LOOK(0x5a4630),
    plain: PLAIN_LOOK(0x6c5638),
    glass: GLASS_LOOK,
    paint: look({ texture: 'metal_paint', tint: 0xb09a6a, roughness: 0.7, metalness: 0.1, normalScale: 0.6, contrast: 1.15, hueKeep: 0.5, dirt: 0xa08a62, dirtAmount: 0.55, dirtHeight: 0.8, macro: 0.8 }),
  },
  // Arctic: dark timber under snow; white and grey paint spattered with road slush.
  arctic: {
    wall: look({ texture: 'planks', tint: 0x4a3a2e, roughness: 0.9, normalScale: 1, contrast: 1.3, hueKeep: 0.4, dirt: 0x2c241d, dirtAmount: 0.4, dirtHeight: 1.1, macro: 0.8 }),
    roof: look({ texture: 'snow', tint: 0xdde3ea, roughness: 0.85, normalScale: 0.6, contrast: 1.5, hueKeep: 0.2, macro: 0.4 }),
    trim: TRIM_LOOK(0x2c241d),
    plain: PLAIN_LOOK(0x2c241d),
    glass: GLASS_LOOK,
    paint: look({ texture: 'metal_paint', tint: 0xc4cacf, roughness: 0.65, metalness: 0.1, normalScale: 0.6, contrast: 1.15, hueKeep: 0.5, dirt: 0x6e7479, dirtAmount: 0.55, dirtHeight: 0.8, macro: 0.8 }),
  },
  // Valley: white render under red sheet roofs; olive paint splashed with mud.
  valley: {
    wall: look({ texture: 'plaster_white', tint: 0xe0dac9, roughness: 0.92, contrast: 2.4, hueKeep: 0.5, dirt: 0x6b6050, dirtAmount: 0.5, dirtHeight: 1.1, macro: 1 }),
    roof: look({ texture: 'metal_paint', tint: 0x9c3e30, roughness: 0.75, metalness: 0.05, normalScale: 0.6, contrast: 1.4, hueKeep: 0.5, macro: 0.6 }),
    trim: TRIM_LOOK(0x4a3d2c),
    plain: PLAIN_LOOK(0x4a3d2c),
    glass: GLASS_LOOK,
    paint: look({ texture: 'metal_paint', tint: 0x5e6439, roughness: 0.7, metalness: 0.1, normalScale: 0.6, contrast: 1.15, hueKeep: 0.5, dirt: 0x4d4030, dirtAmount: 0.55, dirtHeight: 0.8, macro: 0.8 }),
  },
};

/** The material colour of a class in a theme (linear), or null when the parts carry their own colours (vertex colours). */
export function classTint(theme: ThemeId, cls: PartClass): THREE.Color | null {
  const t = LOOKS[theme][cls].tint;
  return t === null ? null : new THREE.Color(t);
}

// ---------------------------------------------------------------------------------------------
// Texture loading (once per file, shared by all materials; the material keeps its flat tint when a file fails)

type TextureSource = (url: string) => Promise<THREE.Texture>;
let source: TextureSource | null | undefined;

/** Replace the texture source (tests); `null` disables textures; `undefined` restores the default (TextureLoader in a browser, none without a DOM). */
export function setTextureSource(s: TextureSource | null | undefined): void {
  source = s;
  loads.clear();
}

function currentSource(): TextureSource | null {
  if (source !== undefined) return source;
  if (typeof document === 'undefined') return null;
  return (url) => new THREE.TextureLoader().loadAsync(url);
}

/** Anisotropy asked for; three clamps it to what the GPU supports. */
const ANISOTROPY = 8;
const loads = new Map<string, Promise<THREE.Texture | null>>();

function loadTexture(name: string, kind: 'diff' | 'nor' | 'rough'): Promise<THREE.Texture | null> {
  const file = `${name}_${kind}.jpg`;
  let p = loads.get(file);
  if (!p) {
    const src = currentSource();
    if (!src) return Promise.resolve(null);
    p = src(`${import.meta.env.BASE_URL}assets/textures/${file}`).then(
      (t) => {
        t.wrapS = THREE.RepeatWrapping;
        t.wrapT = THREE.RepeatWrapping;
        t.colorSpace = kind === 'diff' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        t.anisotropy = ANISOTROPY;
        return t;
      },
      () => {
        console.warn(`materials: could not load ${file}, using flat colours`);
        return null;
      },
    );
    loads.set(file, p);
  }
  return p;
}

/** Attach whichever maps of the class's texture set load, in one recompile. */
function attachTextures(m: THREE.MeshStandardMaterial, l: ClassLook): void {
  const name = l.texture;
  if (!name || !currentSource()) return;
  void Promise.all([loadTexture(name, 'diff'), loadTexture(name, 'nor'), loadTexture(name, 'rough')]).then(([diff, nor, rough]) => {
    if (diff) m.map = diff;
    if (nor) {
      m.normalMap = nor;
      m.normalScale.set(l.normalScale, l.normalScale);
    }
    if (rough) {
      m.roughnessMap = rough;
      m.roughness = 1; // the map holds the roughness
    }
    if (diff || nor || rough) m.needsUpdate = true;
  });
}

// ---------------------------------------------------------------------------------------------
// Shader patch: texture normalised around its average, and the dirt gradient from the prop-local height

const PATCH_KEY = 'prop-weathering-2';

function patchShader(shader: { uniforms: Record<string, THREE.IUniform>; vertexShader: string; fragmentShader: string }, l: ClassLook): void {
  const mean = l.texture ? TEXTURE_MEAN[l.texture] : [1, 1, 1];
  shader.uniforms.uMapMean = { value: new THREE.Vector3(mean[0], mean[1], mean[2]) };
  shader.uniforms.uContrast = { value: l.contrast };
  shader.uniforms.uHueKeep = { value: l.hueKeep };
  shader.uniforms.uDirtColor = { value: new THREE.Color(l.dirt) };
  shader.uniforms.uDirtAmount = { value: l.dirtAmount };
  shader.uniforms.uDirtHeight = { value: l.dirtHeight };
  shader.uniforms.uMacro = { value: l.macro };
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying float vPropY;\nvarying vec2 vFaceUv;\nvarying vec2 vInstance;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPropY = position.y;\nvFaceUv = uv;\nvInstance = modelMatrix[3].xz;');
  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <common>',
      `#include <common>
varying float vPropY;
varying vec2 vFaceUv;
varying vec2 vInstance;
uniform vec3 uMapMean;
uniform float uContrast;
uniform float uHueKeep;
uniform vec3 uDirtColor;
uniform float uDirtAmount;
uniform float uDirtHeight;
uniform float uMacro;
float propHash( vec2 p ) {
	vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
	p3 += dot( p3, p3.yzx + 33.33 );
	return fract( ( p3.x + p3.y ) * p3.z );
}
float propNoise( vec2 p ) {
	vec2 i = floor( p );
	vec2 f = fract( p );
	f = f * f * ( 3.0 - 2.0 * f );
	return mix( mix( propHash( i ), propHash( i + vec2( 1.0, 0.0 ) ), f.x ), mix( propHash( i + vec2( 0.0, 1.0 ) ), propHash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}`,
    )
    .replace(
      '#include <map_fragment>',
      `#ifdef USE_MAP
	vec3 albedoVar = texture2D( map, vMapUv ).rgb / uMapMean;
	albedoVar = mix( vec3( dot( albedoVar, vec3( 0.2126, 0.7152, 0.0722 ) ) ), albedoVar, uHueKeep );
	diffuseColor.rgb *= max( vec3( 0.0 ), 1.0 + ( albedoVar - 1.0 ) * uContrast );
#endif`,
    )
    .replace(
      '#include <color_fragment>',
      `#include <color_fragment>
	// Weathering: blotches and tall rain streaks (different on every instance), then the dirt gradient from the ground up.
	vec2 weatherUv = vFaceUv * 2.0 + vec2( vInstance.x * 0.173, vInstance.y * 0.291 );
	float blotch = propNoise( weatherUv * 0.45 ) * 0.65 + propNoise( weatherUv * 1.7 ) * 0.35;
	float streak = smoothstep( 0.6, 0.95, propNoise( vec2( weatherUv.x * 2.1, weatherUv.y * 0.14 ) ) );
	diffuseColor.rgb *= 1.0 + ( blotch - 0.5 ) * 0.34 * uMacro;
	diffuseColor.rgb *= 1.0 - streak * 0.2 * uMacro * smoothstep( 0.0, 2.5, vPropY );
	float dirtK = 1.0 - smoothstep( 0.0, uDirtHeight, vPropY );
	diffuseColor.rgb = mix( diffuseColor.rgb, uDirtColor, dirtK * dirtK * uDirtAmount );`,
    );
}

/** Exposed for the tests: apply the shader patch of a theme's class to a (fake) shader object. */
export function patchShaderFor(theme: ThemeId, cls: PartClass, shader: Parameters<typeof patchShader>[0]): void {
  patchShader(shader, LOOKS[theme][cls]);
}

// ---------------------------------------------------------------------------------------------
// The materials

const cache = new Map<string, THREE.MeshStandardMaterial>();

/** The shared material of a part class in a theme (created on first use; its textures follow when they have loaded). */
export function propMaterial(theme: ThemeId, cls: PartClass): THREE.MeshStandardMaterial {
  const key = `${theme}|${cls}`;
  let m = cache.get(key);
  if (!m) {
    const l = LOOKS[theme][cls];
    m = new THREE.MeshStandardMaterial({
      color: l.tint ?? 0xffffff,
      roughness: l.roughness,
      metalness: l.metalness,
      vertexColors: cls !== 'glass',
    });
    m.name = `prop ${theme} ${cls}`;
    if (l.dirtAmount > 0 || l.texture || l.macro > 0) {
      m.onBeforeCompile = (shader) => patchShader(shader, l);
      m.customProgramCacheKey = () => PATCH_KEY; // the patch is the same code for every class; only its uniforms differ
    }
    attachTextures(m, l);
    cache.set(key, m);
  }
  return m;
}

/** Forget the cached materials (tests only: they build the same theme with different texture sources). */
export function resetPropMaterials(): void {
  for (const m of cache.values()) m.dispose();
  cache.clear();
}

let burnt: THREE.MeshStandardMaterial | null = null;
/** The charred bonnet of a disabled vehicle (shared). */
export function burntMaterial(): THREE.MeshStandardMaterial {
  burnt ??= new THREE.MeshStandardMaterial({ color: 0x1d1a17, roughness: 0.95, metalness: 0 });
  return burnt;
}
