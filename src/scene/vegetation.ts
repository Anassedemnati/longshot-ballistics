import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { FiringPosition } from '../mission/config';
import type { MissionLayout } from '../mission/layout';
import { BOULDER_UNIT, SNAG_UNIT } from '../mission/models';
import { makeMeshGround, planScatter } from '../mission/scatter';
import type { ScatterItem, ScatterPlan } from '../mission/scatter';
import type { ThemeId } from '../mission/themes';
import { terrainGridAxes } from './terrain';
import type { TerrainField } from './terrainField';

// The trees, shrubs, boulders and grass clumps of a mission, one InstancedMesh per kind (one draw call each, plus the
// shadow pass): procedural low-poly firs (arctic, valley), snags and shrubs; glTF boulders, fallen logs and grass clumps
// (public/assets/models, Poly Haven CC0). Placement is the pure `planScatter` (mission/scatter.ts). A model that fails to
// load is skipped (boulders fall back to a procedural rock): the mission still starts, only that kind is missing.
// Visual only: no colliders. The meshes stay inside the footprints and heights the plan reserved (mission/models.ts).

// ---------------------------------------------------------------------------------------------
// glTF loading

/** The glTF files this module uses (public/assets/models/<name>.glb). */
export type ModelName = 'boulder2' | 'dead_tree' | 'grass_clump';

/** Loads a model's scene; rejects when it cannot. Injectable so tests need no network or GL. */
export type ModelLoader = (name: ModelName) => Promise<THREE.Object3D>;

/** The browser's loader: GLTFLoader with meshopt decoding, from the app's base URL. */
export function gltfModelLoader(baseUrl: string = import.meta.env.BASE_URL): ModelLoader {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  return async (name) => (await loader.loadAsync(`${baseUrl}assets/models/${name}.glb`)).scene;
}

/** A model's geometry (plain float attributes, world transform baked in, centred, base at y = 0) and its material. */
export interface ModelPart {
  name: string;
  geometry: THREE.BufferGeometry;
  material: THREE.MeshStandardMaterial;
}

/** A copy of `source` with plain float position / normal / uv attributes, transformed by `matrix` (a glTF's may be interleaved). */
function plainGeometry(source: THREE.BufferGeometry, matrix: THREE.Matrix4): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  for (const [name, size] of [['position', 3], ['normal', 3], ['uv', 2]] as const) {
    const a = source.getAttribute(name);
    if (!a) continue;
    const data = new Float32Array(a.count * size);
    for (let i = 0; i < a.count; i++) {
      data[i * size] = a.getX(i);
      data[i * size + 1] = a.getY(i);
      if (size > 2) data[i * size + 2] = a.getZ(i);
    }
    out.setAttribute(name, new THREE.BufferAttribute(data, size));
  }
  if (source.index) out.setIndex(Array.from(source.index.array));
  out.applyMatrix4(matrix); // positions as points, normals by the inverse transpose
  if (!out.getAttribute('normal')) out.computeVertexNormals();
  return out;
}

/** Move a geometry so its footprint centre is on the y axis and its lowest point is at y = 0. */
function groundCentred(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  geometry.computeBoundingBox();
  const b = geometry.boundingBox as THREE.Box3;
  geometry.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** Every mesh under `root` as a ground-centred `ModelPart`; glTF materials come double-sided, so rocks set `side` themselves. */
export function modelParts(root: THREE.Object3D): ModelPart[] {
  root.updateMatrixWorld(true);
  const parts: ModelPart[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    if (!(material instanceof THREE.MeshStandardMaterial)) return;
    parts.push({ name: mesh.name, geometry: groundCentred(plainGeometry(mesh.geometry, mesh.matrixWorld)), material });
  });
  return parts;
}

/** The loaded models, each null when it did not load. */
export interface ModelKit {
  boulder: ModelPart | null;
  log: ModelPart | null;
  /** Three grass clumps (mid_a, mid_b, mid_c of the glb; null entries are skipped). */
  grass: Array<ModelPart | null>;
}

const kits = new WeakMap<ModelLoader, Promise<ModelKit>>();

/** Load each model once per loader (the vegetation and the nest share the boulder). Never rejects: a failed model is null. */
export function loadModelKit(loader: ModelLoader): Promise<ModelKit> {
  let kit = kits.get(loader);
  if (!kit) {
    const load = async (name: ModelName): Promise<ModelPart[]> => {
      try {
        const parts = modelParts(await loader(name));
        if (parts.length === 0) throw new Error('no mesh in the model');
        return parts;
      } catch (e) {
        console.warn(`vegetation: could not load ${name}.glb, skipping it (${e instanceof Error ? e.message : String(e)})`);
        return [];
      }
    };
    const pick = (parts: ModelPart[], key: string): ModelPart | null => parts.find((p) => p.name.includes(key)) ?? null;
    kit = Promise.all([load('boulder2'), load('dead_tree'), load('grass_clump')]).then(([boulder, log, grass]) => ({
      boulder: boulder[0] ?? null,
      log: log[0] ?? null,
      // The glb holds 17 clumps laid out in a row; take three (the tall ones are dark thin stalks).
      grass: [pick(grass, 'mid_a'), pick(grass, 'mid_b'), pick(grass, 'mid_c')],
    }));
    kits.set(loader, kit);
  }
  return kit;
}

// ---------------------------------------------------------------------------------------------
// Looks

/** Per-theme colours (linear): fir foliage, snag bark, shrub leaves. */
const FOLIAGE: Record<ThemeId, [number, number, number]> = {
  desert: [0.1, 0.2, 0.07],
  arctic: [0.07, 0.15, 0.12],
  valley: [0.055, 0.125, 0.045], // dark conifer green: lit by a 48 degree sun the lighter greens read as lime plastic
};
const BARK: Record<ThemeId, [number, number, number]> = {
  desert: [0.46, 0.37, 0.26], // silvery dry wood
  arctic: [0.2, 0.17, 0.15],
  valley: [0.3, 0.23, 0.16],
};
const SHRUB: Record<ThemeId, [number, number, number]> = {
  desert: [0.5, 0.42, 0.2], // dry khaki
  arctic: [0.13, 0.1, 0.08], // bare twigs
  valley: [0.11, 0.2, 0.05],
};
/** Rock tint multiplying the rock texture, and the flat colour used until (or without) it. */
const ROCK_TINT: Record<ThemeId, number> = { desert: 0xe0cdb0, arctic: 0xb9bfca, valley: 0xd0c9b8 };
const ROCK_FLAT: Record<ThemeId, number> = { desert: 0x8a7a64, arctic: 0x5f6269, valley: 0x77705f };

/** The textures asked for so far: one load and one GPU copy per file and anisotropy, shared by every material that wants it. */
const textureCache = new Map<string, { texture: THREE.Texture | null; failed: boolean; waiting: Array<(texture: THREE.Texture) => void> }>();

/** Load a texture and hand it over when it arrives (at once when already loaded); logs and carries on without it when it cannot (or there is no DOM). */
export function loadTexture(url: string, maxAnisotropy: number, apply: (texture: THREE.Texture) => void): void {
  const key = `${url}@${maxAnisotropy}`;
  const known = textureCache.get(key);
  if (known) {
    if (known.texture) apply(known.texture);
    else if (!known.failed) known.waiting.push(apply);
    return;
  }
  const entry = { texture: null as THREE.Texture | null, failed: false, waiting: [apply] };
  textureCache.set(key, entry);
  const fail = (why: string): void => {
    entry.failed = true;
    entry.waiting.length = 0;
    console.warn(`vegetation: could not load ${url}, using a flat colour${why}`);
  };
  try {
    new THREE.TextureLoader().load(
      url,
      (texture) => {
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.generateMipmaps = true;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.anisotropy = maxAnisotropy;
        entry.texture = texture;
        for (const waiting of entry.waiting.splice(0)) waiting(texture);
      },
      undefined,
      () => fail(''),
    );
  } catch (e) {
    fail(` (${e instanceof Error ? e.message : String(e)})`);
  }
}

export interface SurfaceLook {
  /** Snow settles on what faces up: blend towards white where the world-space normal's y is above `from` (fully by `to`), by `amount`. */
  snow?: { from: number; to: number; amount: number };
  /** Colour saturation of the texture and tint (1 = as is, 0 = grey): the cliff texture is orange, a snow-country rock is not. */
  saturation?: number;
}

/**
 * Patch a standard material's shader with a `SurfaceLook`. `key` keeps the shader programs of different looks apart
 * (the program cache is keyed by it and the patch's parameters are baked into the code).
 */
export function patchSurface(material: THREE.Material, key: string, look: SurfaceLook): void {
  material.onBeforeCompile = (shader) => {
    if (look.saturation !== undefined) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        diffuseColor.rgb = mix( vec3( dot( diffuseColor.rgb, vec3( 0.299, 0.587, 0.114 ) ) ), diffuseColor.rgb, ${look.saturation.toFixed(3)} );`,
      );
    }
    if (look.snow) {
      const { from, to, amount } = look.snow;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        {
          vec3 snowN = inverseTransformDirection( normal, viewMatrix );
          float snowK = smoothstep( ${from.toFixed(3)}, ${to.toFixed(3)}, snowN.y ) * ${amount.toFixed(3)};
          diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.9, 0.94, 1.0 ), snowK );
          roughnessFactor = mix( roughnessFactor, 0.9, snowK );
        }`,
      );
    }
  };
  material.customProgramCacheKey = () => `surface-${key}-${look.saturation ?? 'x'}-${look.snow ? `${look.snow.from}-${look.snow.to}-${look.snow.amount}` : 'x'}`;
  material.needsUpdate = true;
}

/** How grey each theme's rock is (the cliff texture is orange sandstone). */
const ROCK_SATURATION: Record<ThemeId, number> = { desert: 0.85, arctic: 0.12, valley: 0.4 };

// ---------------------------------------------------------------------------------------------
// Procedural geometry (plain triangle soup with vertex colours; flat-shaded by computeVertexNormals)

type V3 = [number, number, number];

/** A cheap hash in [0, 1) of two integers. */
function hash2(a: number, b: number): number {
  const s = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

/** Build a geometry from triangles (position + colour per vertex), with flat normals. */
class GeometryBuilder {
  private readonly positions: number[] = [];
  private readonly colors: number[] = [];

  /** A triangle wound so its normal points away from `inside`. */
  tri(a: V3, b: V3, c: V3, inside: V3, ca: V3, cb: V3 = ca, cc: V3 = ca): void {
    const nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
    const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    const nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const out =
      nx * ((a[0] + b[0] + c[0]) / 3 - inside[0]) + ny * ((a[1] + b[1] + c[1]) / 3 - inside[1]) + nz * ((a[2] + b[2] + c[2]) / 3 - inside[2]);
    if (out >= 0) {
      this.positions.push(...a, ...b, ...c);
      this.colors.push(...ca, ...cb, ...cc);
    } else {
      this.positions.push(...a, ...c, ...b);
      this.colors.push(...ca, ...cc, ...cb);
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    g.computeVertexNormals();
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

const scaled = (c: V3, k: number): V3 => [c[0] * k, c[1] * k, c[2] * k];

/** A tapered prism along y from (0, y0, 0) with `sides` sides, radius r0 at the bottom and r1 at the top, leaning by (lx, lz) at the top. */
function prism(g: GeometryBuilder, sides: number, y0: number, y1: number, r0: number, r1: number, lx: number, lz: number, c0: V3, c1: V3): void {
  const inside: V3 = [lx / 2, (y0 + y1) / 2, lz / 2];
  for (let j = 0; j < sides; j++) {
    const a0 = (j / sides) * Math.PI * 2;
    const a1 = ((j + 1) / sides) * Math.PI * 2;
    const b0: V3 = [Math.cos(a0) * r0, y0, Math.sin(a0) * r0];
    const b1: V3 = [Math.cos(a1) * r0, y0, Math.sin(a1) * r0];
    const t0: V3 = [lx + Math.cos(a0) * r1, y1, lz + Math.sin(a0) * r1];
    const t1: V3 = [lx + Math.cos(a1) * r1, y1, lz + Math.sin(a1) * r1];
    g.tri(b0, b1, t1, inside, c0, c0, c1);
    g.tri(b0, t1, t0, inside, c0, c1, c1);
  }
}

/**
 * A fir in a unit frame: base radius 1, height 1, the trunk reaching 0.1 below the origin (it is sunk into the ground).
 * `tiers` stacked, ragged cones narrowing upwards; each tier a little darker below, with a hollow underside.
 */
export function firGeometry(theme: ThemeId, tiers: number): THREE.BufferGeometry {
  const g = new GeometryBuilder();
  const foliage = FOLIAGE[theme];
  const trunk: V3 = [0.2, 0.12, 0.07];
  prism(g, 7, -0.1, 0.8, 0.07, 0.03, 0, 0, scaled(trunk, 0.8), trunk);
  const SIDES = 10;
  for (let k = 0; k < tiers; k++) {
    const t = tiers === 1 ? 0 : k / (tiers - 1);
    const yb = 0.1 + 0.6 * t; // the tier's base
    const h = 0.3 + 0.1 * (1 - t); // and height
    const radius = 1 - 0.72 * t;
    const tone = 0.8 + 0.4 * t;
    const body = scaled(foliage, tone);
    const under = scaled(foliage, tone * 0.5);
    const tip: V3 = [0, yb + h, 0];
    const inside: V3 = [0, yb + h * 0.55, 0];
    const hollow: V3 = [0, yb + h * 0.18, 0];
    const turn = k * 0.31;
    const ring: V3[] = [];
    for (let j = 0; j < SIDES; j++) {
      const a = turn + (j / SIDES) * Math.PI * 2;
      const r = radius * (0.78 + 0.22 * hash2(j + k * 17, tiers));
      ring.push([Math.cos(a) * r, yb - 0.05 * hash2(j, k + 5), Math.sin(a) * r]);
    }
    for (let j = 0; j < SIDES; j++) {
      const a = ring[j];
      const b = ring[(j + 1) % SIDES];
      g.tri(a, b, tip, inside, scaled(body, 0.85), scaled(body, 0.85), scaled(body, 1.15));
      g.tri(a, b, hollow, inside, under);
    }
  }
  return g.build();
}

/** A dead tree at scale 1 (`SNAG_UNIT`): a tapering bare trunk with a few snapped branch stubs, in metres. */
export function snagGeometry(theme: ThemeId): THREE.BufferGeometry {
  const g = new GeometryBuilder();
  const bark = BARK[theme];
  const { height, radius, reach } = SNAG_UNIT;
  prism(g, 6, -0.15, height, radius, radius * 0.3, 0.05, 0.03, scaled(bark, 0.8), bark);
  const stubs: Array<[number, number, number]> = [
    [0.4, 0.4, reach * 0.9],
    [0.5, 3.1, reach * 0.8],
    [0.62, 2.0, reach * 0.75],
    [0.7, 5.0, reach * 0.65],
    [0.8, 4.4, reach * 0.55],
    [0.3, 5.7, reach * 0.6],
  ];
  for (const [at, turn, length] of stubs) {
    const y = at * height;
    const rise = length * 0.45;
    const dx = Math.cos(turn) * length;
    const dz = Math.sin(turn) * length;
    // A branch is a thin tapered prism tilted outwards: build it upright along +y and shear its top to the tip.
    const inside: V3 = [dx / 2, y + rise / 2, dz / 2];
    const r0 = radius * 0.32 * (1 - at * 0.5);
    for (let j = 0; j < 4; j++) {
      const a0 = (j / 4) * Math.PI * 2;
      const a1 = ((j + 1) / 4) * Math.PI * 2;
      const b0: V3 = [Math.cos(a0) * r0, y, Math.sin(a0) * r0];
      const b1: V3 = [Math.cos(a1) * r0, y, Math.sin(a1) * r0];
      const tip: V3 = [dx, y + rise, dz];
      g.tri(b0, b1, tip, inside, bark, bark, scaled(bark, 0.7));
    }
  }
  return g.build();
}

/** A shrub in a unit frame (radius 1, height 1): three lumpy mounds, darker below, in the theme's leaf colour. */
export function shrubGeometry(theme: ThemeId): THREE.BufferGeometry {
  const g = new GeometryBuilder();
  const leaf = SHRUB[theme];
  const lumps: Array<[number, number, number, number, number]> = [
    // centre x, y, z, horizontal radius, height radius
    [0, 0.42, 0, 0.62, 0.46],
    [0.4, 0.3, 0.12, 0.46, 0.34],
    [-0.34, 0.28, -0.2, 0.44, 0.3],
  ];
  const ico = new THREE.IcosahedronGeometry(1, 1);
  const p = ico.getAttribute('position');
  lumps.forEach(([cx, cy, cz, rh, rv], li) => {
    const v = (i: number): V3 => {
      const x = p.getX(i);
      const y = p.getY(i);
      const z = p.getZ(i);
      const bump = 0.82 + 0.3 * hash2(Math.round(x * 50) + li * 31, Math.round(y * 50) * 7 + Math.round(z * 50));
      return [cx + x * rh * bump, Math.max(0, cy + y * rv * bump), cz + z * rh * bump];
    };
    const shade = (pt: V3): V3 => scaled(leaf, 0.55 + 0.7 * Math.min(1, pt[1] / 0.85));
    for (let i = 0; i < p.count; i += 3) {
      const a = v(i);
      const b = v(i + 1);
      const c = v(i + 2);
      g.tri(a, b, c, [cx, cy, cz], shade(a), shade(b), shade(c));
    }
  });
  ico.dispose();
  return g.build();
}

/**
 * A lumpy rock the size of `BOULDER_UNIT`, base at y = 0: the light stand-in for the glTF boulder (far away) and its
 * fallback. Flat-shaded, with planar texture coordinates for the rock texture.
 */
export function rockGeometry(): THREE.BufferGeometry {
  const ico = new THREE.IcosahedronGeometry(1, 2);
  const p = ico.getAttribute('position');
  const positions = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const bump = 0.78 + 0.4 * hash2(Math.round(x * 40) * 3 + Math.round(z * 40), Math.round(y * 40) + 11) + 0.1 * Math.sin(x * 5 + z * 3);
    positions[i * 3] = x * bump;
    positions[i * 3 + 1] = Math.max(y * bump, -0.55); // a flattened base
    positions[i * 3 + 2] = z * bump;
  }
  ico.dispose();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.computeBoundingBox();
  const b = g.boundingBox as THREE.Box3;
  const sx = BOULDER_UNIT.lx / (b.max.x - b.min.x);
  const sy = BOULDER_UNIT.ly / (b.max.y - b.min.y);
  const sz = BOULDER_UNIT.lz / (b.max.z - b.min.z);
  g.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
  g.scale(sx, sy, sz);
  const pos = g.getAttribute('position');
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = (pos.getX(i) + pos.getZ(i) * 0.5) / 1.8;
    uv[i * 2 + 1] = (pos.getY(i) + pos.getZ(i) * 0.5) / 1.8;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.computeVertexNormals();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

// ---------------------------------------------------------------------------------------------
// Materials

/** The rock material (far boulders, the nest's platform): the cliff texture tinted per theme, flat colour without it. */
export function rockMaterial(theme: ThemeId, maxAnisotropy: number, brightness = 1): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ color: new THREE.Color(ROCK_FLAT[theme]).multiplyScalar(brightness), roughness: 0.95, metalness: 0, flatShading: true });
  loadTexture(`${import.meta.env.BASE_URL}assets/textures/rock_diff.jpg`, maxAnisotropy, (texture) => {
    material.map = texture;
    material.color.set(ROCK_TINT[theme]).multiplyScalar(brightness);
    material.needsUpdate = true;
  });
  patchSurface(material, 'rock', { saturation: ROCK_SATURATION[theme], snow: theme === 'arctic' ? { from: 0.45, to: 0.8, amount: 0.85 } : undefined });
  return material;
}

/** The glTF boulder's material: single-sided, tinted per theme, snow on top in the arctic. */
export function boulderMaterial(part: ModelPart, theme: ThemeId): THREE.MeshStandardMaterial {
  const material = part.material.clone();
  material.side = THREE.FrontSide;
  material.metalness = 0;
  material.color.set(ROCK_TINT[theme]);
  patchSurface(material, 'boulder', { snow: theme === 'arctic' ? { from: 0.45, to: 0.8, amount: 0.85 } : undefined });
  return material;
}

// ---------------------------------------------------------------------------------------------
// Instances

const SCRATCH = new THREE.Object3D();
SCRATCH.rotation.order = 'YXZ';

/** One InstancedMesh of `items`, each placed at its position, turned and scaled, tinted by `tint`. */
function instances(
  name: string,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  items: readonly ScatterItem[],
  tint: (item: ScatterItem, out: THREE.Color) => void,
  shadows: { cast: boolean; receive: boolean },
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, items.length));
  mesh.name = name;
  mesh.count = items.length;
  const color = new THREE.Color();
  items.forEach((it, i) => {
    SCRATCH.position.set(it.x, it.y, it.z);
    SCRATCH.rotation.set(it.tiltX, it.yaw, it.tiltZ);
    SCRATCH.scale.set(it.sx, it.sy, it.sz);
    SCRATCH.updateMatrix();
    mesh.setMatrixAt(i, SCRATCH.matrix);
    tint(it, color);
    mesh.setColorAt(i, color);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = shadows.cast;
  mesh.receiveShadow = shadows.receive;
  mesh.matrixAutoUpdate = false;
  mesh.computeBoundingSphere();
  return mesh;
}

const neutral = (it: ScatterItem, out: THREE.Color): void => void out.setScalar(0.82 + 0.36 * it.shade);

export interface Vegetation {
  /** Starts with the procedural kinds; each glTF kind is added when it has loaded. */
  group: THREE.Group;
  plan: ScatterPlan;
  /** Settles when every model has loaded or failed and its meshes are in `group`. Never rejects. */
  ready: Promise<void>;
}

/** The terrain mesh's surface for `field` (what the items stand on). */
export function meshGroundOf(field: TerrainField): (x: number, z: number) => number {
  return makeMeshGround(terrainGridAxes(), field.height);
}

export interface VegetationOptions {
  maxAnisotropy?: number;
  /** Where the glTF models come from; defaults to the app's own files. */
  loadModel?: ModelLoader;
  /** The terrain mesh's surface (see `meshGroundOf`); computed when absent. */
  ground?: (x: number, z: number) => number;
  /** Share of the planned trees, shrubs, boulders and grass that is drawn (the quality level's); 1 = all. The plan is in placement order, which is random, so a prefix is an even thinning. */
  scale?: number;
}

/**
 * The vegetation and boulders of a mission: the plan (`planScatter`) turned into instanced meshes. Returns at once with the
 * procedural kinds in the group; the glTF kinds join it when they load (`ready` settles after that).
 */
export function createVegetation(
  field: TerrainField,
  layout: MissionLayout,
  seed: number,
  position: FiringPosition,
  options: VegetationOptions = {},
): Vegetation {
  const theme = field.theme;
  const maxAnisotropy = options.maxAnisotropy ?? 8;
  const ground = options.ground ?? meshGroundOf(field);
  const full = planScatter({ field, layout, seed, position, ground });
  const share = options.scale ?? 1;
  const thin = (items: ScatterItem[]): ScatterItem[] => (share >= 1 ? items : items.slice(0, Math.ceil(items.length * Math.max(0, share))));
  const plan: ScatterPlan = { firs: thin(full.firs), snags: thin(full.snags), logs: thin(full.logs), shrubs: thin(full.shrubs), boulders: thin(full.boulders), grass: thin(full.grass) };
  const group = new THREE.Group();
  group.name = 'vegetation';
  const add = (mesh: THREE.InstancedMesh): void => {
    if (mesh.count > 0) group.add(mesh);
  };

  // ---- procedural kinds
  const firMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
  if (theme === 'arctic') patchSurface(firMaterial, 'fir', { snow: { from: 0.3, to: 0.62, amount: 0.8 } });
  const firTint = (it: ScatterItem, out: THREE.Color): void =>
    void out.setRGB(0.8 + 0.4 * it.shade, 0.85 + 0.3 * it.shade, 0.75 + 0.25 * (1 - it.shade));
  for (const variant of [0, 1]) {
    const items = plan.firs.filter((f) => f.variant === variant);
    add(instances(`firs-${variant}`, firGeometry(theme, variant === 0 ? 4 : 5), firMaterial, items, firTint, { cast: true, receive: true }));
  }
  const barkMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
  add(instances('snags', snagGeometry(theme), barkMaterial, plan.snags, neutral, { cast: true, receive: true }));
  const shrubMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
  if (theme === 'arctic') patchSurface(shrubMaterial, 'shrub', { snow: { from: 0.4, to: 0.75, amount: 0.75 } });
  add(instances('shrubs', shrubGeometry(theme), shrubMaterial, plan.shrubs, neutral, { cast: false, receive: true }));

  // ---- the far boulders are always the procedural rock
  const far = plan.boulders.filter((b) => b.variant === 1);
  const near = plan.boulders.filter((b) => b.variant === 0);
  const rockTint = (it: ScatterItem, out: THREE.Color): void => void out.setScalar(0.78 + 0.4 * it.shade);
  add(instances('boulders-far', rockGeometry(), rockMaterial(theme, maxAnisotropy), far, rockTint, { cast: true, receive: true }));

  // ---- the glTF kinds, as they load
  const loader = options.loadModel ?? gltfModelLoader();
  const ready = loadModelKit(loader).then((kit) => {
    // The detailed boulder (the procedural rock stands in when it did not load, so the near field is never bare).
    const nearGeometry = kit.boulder ? kit.boulder.geometry : rockGeometry();
    const nearMaterial = kit.boulder ? boulderMaterial(kit.boulder, theme) : rockMaterial(theme, maxAnisotropy);
    add(instances('boulders-near', nearGeometry, nearMaterial, near, rockTint, { cast: true, receive: true }));
    if (kit.log) {
      const logMaterial = kit.log.material.clone();
      logMaterial.side = THREE.FrontSide;
      logMaterial.metalness = 0;
      add(instances('logs', kit.log.geometry, logMaterial, plan.logs, neutral, { cast: true, receive: true }));
    }
    kit.grass.forEach((part, variant) => {
      if (!part) return;
      const material = part.material.clone();
      material.side = THREE.DoubleSide;
      material.metalness = 0;
      material.transparent = false;
      material.alphaTest = 0.5;
      material.depthWrite = true;
      add(instances(`grass-${variant}`, part.geometry, material, plan.grass.filter((g) => g.variant === variant), neutral, { cast: false, receive: true }));
    });
  });
  return { group, plan, ready: ready.catch((e) => console.warn(`vegetation: ${e instanceof Error ? e.message : String(e)}`)) };
}
