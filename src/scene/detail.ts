import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { planGroundDetail } from '../mission/groundDetail';
import type { GroundDetailPlan } from '../mission/groundDetail';
import type { MissionLayout } from '../mission/layout';
import { createRng } from '../mission/random';
import type { ThemeId } from '../mission/themes';
import type { TerrainField } from './terrainField';

// The small things on the ground. `groundRelief(theme)` is the bump map of the terrain material (sand
// ripples, snow drifts, grass and soil); `createGroundDetail` adds instanced pebbles to every theme and
// crossed-quad grass tufts to the valley, placed by the pure `planGroundDetail` (mission/groundDetail.ts).
// One InstancedMesh each, so each costs a single draw call. Visual only: no colliders.

// ---------------------------------------------------------------------------------------------
// Bump relief (linear data, tiled over the terrain)

const RELIEF_SIZE = 256;

/** Hash of a lattice cell to [0, 1). */
function cellHash(ix: number, iy: number, salt: number): number {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ Math.imul(salt, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise in [0, 1] that repeats every `periodX` x `periodY` lattice cells (so the texture tiles). */
export function periodicNoise(x: number, y: number, periodX: number, periodY: number, salt: number): number {
  const fx = Math.floor(x);
  const fy = Math.floor(y);
  const tx = x - fx;
  const ty = y - fy;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const wrap = (v: number, p: number): number => ((v % p) + p) % p;
  const x0 = wrap(fx, periodX);
  const x1 = wrap(fx + 1, periodX);
  const y0 = wrap(fy, periodY);
  const y1 = wrap(fy + 1, periodY);
  const a = cellHash(x0, y0, salt);
  const b = cellHash(x1, y0, salt);
  const c = cellHash(x0, y1, salt);
  const d = cellHash(x1, y1, salt);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Fractal tiling noise in [0, 1]: `octaves` octaves starting at `cells` cells across the tile. */
function fbm(u: number, v: number, cellsX: number, cellsY: number, octaves: number, salt: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const px = cellsX << o;
    const py = cellsY << o;
    sum += amp * periodicNoise(u * px, v * py, px, py, salt + o * 17);
    norm += amp;
    amp *= 0.5;
  }
  return sum / norm;
}

/**
 * The bump heights (0..255, 128 = mid) of a theme's ground, `size` x `size` texels, tiling seamlessly.
 * Rows run along the texture's v axis (world z), so ripples and drifts lie across the line of sight.
 * Pure and deterministic.
 */
export function reliefHeights(theme: ThemeId, size = RELIEF_SIZE): Uint8Array {
  const data = new Uint8Array(size * size);
  const rng = createRng(0x5eed0000 + (theme === 'desert' ? 1 : theme === 'arctic' ? 2 : 3));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const speckle = rng() - 0.5;
      let h: number;
      if (theme === 'desert') {
        // Wind ripples: 24 crests per tile, wobbling and fading in and out, over fine grain.
        const wobble = Math.sin(u * Math.PI * 4) * 0.8 + (fbm(u, v, 4, 4, 2, 11) - 0.5) * 3;
        const amp = 18 + 26 * fbm(u, v, 3, 3, 2, 5);
        h = 128 + Math.sin(v * Math.PI * 24 + wobble) * amp + speckle * 36;
      } else if (theme === 'arctic') {
        // Wind-packed snow: long soft drifts across the view, fine ridges on them, a faint crust of grain.
        const drift = fbm(u, v, 2, 12, 3, 23) - 0.5;
        const ridge = fbm(u, v, 4, 28, 2, 41) - 0.5;
        h = 128 + drift * 120 + ridge * 44 + speckle * 14;
      } else {
        // Meadow and soil: clumps at every scale, with blade-sized speckle.
        const clump = fbm(u, v, 6, 6, 4, 61) - 0.5;
        const tussock = fbm(u, v, 32, 32, 1, 71) - 0.5;
        h = 128 + clump * 110 + tussock * 40 + speckle * 30;
      }
      data[y * size + x] = Math.max(0, Math.min(255, Math.round(h)));
    }
  }
  return data;
}

/** The bump map of a theme's ground: a repeating, linear-data height texture. */
export function groundRelief(theme: ThemeId, maxAnisotropy = 8): THREE.DataTexture {
  const heights = reliefHeights(theme);
  const rgba = new Uint8Array(RELIEF_SIZE * RELIEF_SIZE * 4);
  for (let i = 0; i < heights.length; i++) {
    rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = heights[i];
    rgba[i * 4 + 3] = 255;
  }
  const texture = new THREE.DataTexture(rgba, RELIEF_SIZE, RELIEF_SIZE);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = maxAnisotropy;
  texture.needsUpdate = true;
  return texture;
}

// ---------------------------------------------------------------------------------------------
// Grass tuft texture

/** RGBA pixels (size x size, row 0 = the ground, the first row a texture reads) of one grass tuft: a fan of tapering blades on a transparent background. */
export function grassTuftPixels(size = 128): Uint8Array {
  const rng = createRng(0x67726173);
  const blades = Array.from({ length: 9 }, (_, i) => {
    const spread = (i / 8 - 0.5) * 0.7; // blades start across the lower middle
    return {
      x0: 0.5 + spread + (rng() - 0.5) * 0.06,
      lean: spread * 1.1 + (rng() - 0.5) * 0.25, // fan out, each with its own bend
      height: 0.62 + rng() * 0.36,
      width: 0.03 + rng() * 0.02,
      tone: 0.8 + rng() * 0.35,
    };
  });
  const px = new Uint8Array(size * size * 4);
  for (let row = 0; row < size; row++) {
    const v = (row + 0.5) / size; // 0 at the ground, 1 at the top
    for (let col = 0; col < size; col++) {
      const u = (col + 0.5) / size;
      let best = -1;
      for (let b = 0; b < blades.length; b++) {
        const blade = blades[b];
        if (v > blade.height) continue;
        const t = v / blade.height;
        const centre = blade.x0 + blade.lean * t * t;
        const half = blade.width * (1 - t * 0.92);
        if (Math.abs(u - centre) <= half && (best < 0 || blades[best].height < blade.height)) best = b;
      }
      const i = (row * size + col) * 4;
      // Transparent texels keep a mid green so mip-mapping does not pull in black.
      let r = 90;
      let g = 120;
      let bl = 50;
      let a = 0;
      if (best >= 0) {
        const blade = blades[best];
        const t = v / blade.height;
        const k = blade.tone * (0.55 + 0.6 * t); // darker at the root, paler at the tip
        r = (70 + 80 * t) * k;
        g = (105 + 70 * t) * k;
        bl = (40 + 20 * t) * k;
        a = 255;
      }
      px[i] = Math.min(255, r);
      px[i + 1] = Math.min(255, g);
      px[i + 2] = Math.min(255, bl);
      px[i + 3] = a;
    }
  }
  return px;
}

function grassTexture(maxAnisotropy: number): THREE.DataTexture {
  const size = 128;
  const texture = new THREE.DataTexture(grassTuftPixels(size), size, size);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = maxAnisotropy;
  texture.needsUpdate = true;
  return texture;
}

/** Three crossed vertical quads, each drawn twice (once facing each way) with up-pointing normals, so no side lights dark. */
function tuftGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (let k = 0; k < 3; k++) {
    const a = (k * Math.PI) / 3;
    const cx = Math.cos(a) * 0.5;
    const cz = Math.sin(a) * 0.5;
    for (const side of [1, -1]) {
      const base = positions.length / 3;
      positions.push(-cx, 0, -cz, cx, 0, cz, cx, 1, cz, -cx, 1, cz);
      uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
      normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0);
      if (side > 0) indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      else indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setIndex(indices);
  return g;
}

// ---------------------------------------------------------------------------------------------
// Pebbles

/** Two stone colours per theme; a pebble's shade picks a point between them (plus a little brightness jitter). */
const STONE_PALETTE: Record<ThemeId, [number, number]> = {
  desert: [0x80705a, 0xb8a684], // brown-grey to pale sandstone
  arctic: [0x585b61, 0x8d9097], // dark rock to grey
  valley: [0x7a7466, 0xada58b], // grey-brown to pale limestone
};

/** A lumpy stone: an icosphere with its vertices pushed in and out by a hash of their position. */
function stoneGeometry(): THREE.BufferGeometry {
  const ico = new THREE.IcosahedronGeometry(1, 1);
  ico.deleteAttribute('normal');
  ico.deleteAttribute('uv');
  const g = mergeVertices(ico); // shared corners, so the stone is smooth rather than faceted
  const pos = g.getAttribute('position');
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const key = Math.round(v.x * 100) * 73856093 ^ Math.round(v.y * 100) * 19349663 ^ Math.round(v.z * 100) * 83492791;
    v.multiplyScalar(0.8 + 0.4 * cellHash(key | 0, 7, 3));
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

function pebbleMesh(plan: GroundDetailPlan, theme: ThemeId): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(
    stoneGeometry(),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.96 }),
    Math.max(1, plan.pebbles.length),
  );
  mesh.name = 'pebbles';
  mesh.count = plan.pebbles.length;
  const [dark, light] = STONE_PALETTE[theme].map((hex) => new THREE.Color(hex));
  const o = new THREE.Object3D();
  const c = new THREE.Color();
  plan.pebbles.forEach((p, i) => {
    o.position.set(p.x, p.y, p.z);
    o.rotation.set(p.tiltX, p.yaw, p.tiltZ);
    o.scale.set(p.size * 1.4, p.size * 0.55, p.size);
    o.updateMatrix();
    mesh.setMatrixAt(i, o.matrix);
    c.copy(dark).lerp(light, p.shade).multiplyScalar(0.85 + 0.3 * cellHash(i, 1, 9));
    mesh.setColorAt(i, c);
  });
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.computeBoundingSphere();
  return mesh;
}

function tuftMesh(plan: GroundDetailPlan, maxAnisotropy: number): THREE.InstancedMesh {
  const material = new THREE.MeshStandardMaterial({
    map: grassTexture(maxAnisotropy),
    alphaTest: 0.45,
    roughness: 1,
    side: THREE.FrontSide, // the geometry holds both faces of every quad
  });
  const mesh = new THREE.InstancedMesh(tuftGeometry(), material, Math.max(1, plan.tufts.length));
  mesh.name = 'tufts';
  mesh.count = plan.tufts.length;
  const o = new THREE.Object3D();
  const c = new THREE.Color();
  plan.tufts.forEach((t, i) => {
    o.position.set(t.x, t.y, t.z);
    o.rotation.set(0, t.yaw, 0);
    o.scale.set(t.size, t.size * 0.8, t.size);
    o.updateMatrix();
    mesh.setMatrixAt(i, o.matrix);
    c.setRGB(0.8 + 0.4 * t.shade, 0.85 + 0.3 * t.shade, 0.75 + 0.2 * t.shade);
    mesh.setColorAt(i, c);
  });
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.computeBoundingSphere();
  return mesh;
}

/**
 * The instanced ground detail of a mission: pebbles (every theme) and, in the valley, grass tufts.
 * Placement is `planGroundDetail` (seeded by the mission seed; `extraTargets`, such as snipers, are kept clear like
 * the soldiers). Returns the group and the plan it built from.
 */
export function createGroundDetail(
  field: TerrainField,
  layout: MissionLayout,
  seed: number,
  maxAnisotropy = 8,
  extraTargets: ReadonlyArray<{ x: number; z: number }> = [],
): { group: THREE.Group; plan: GroundDetailPlan } {
  const plan = planGroundDetail(field, layout, seed, extraTargets);
  const group = new THREE.Group();
  group.name = 'ground-detail';
  group.add(pebbleMesh(plan, field.theme));
  if (plan.tufts.length > 0) group.add(tuftMesh(plan, maxAnisotropy));
  return { group, plan };
}
