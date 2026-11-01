import * as THREE from 'three';
import { ROCK_OUTCROPS, terrainHeight } from './terrainHeight';

export { SHOOTER_POS, terrainHeight } from './terrainHeight';

/** Map extent: 4 km x 4 km, the shooter near the +Z end so the lane runs down the long middle. */
const X_MIN = -2000;
const X_MAX = 2000;
const Z_MIN = -3000;
const Z_MAX = 1000;

/** Fine mesh covers the lane and the shooter's rise; spacing grows with distance beyond it. */
const FOCUS_X = 100;
const FOCUS_Z_MIN = -1600;
const FOCUS_Z_MAX = 120;
const FINE_STEP_X = 2.5;
const FINE_STEP_Z = 3;
const COARSE_STEP = 70;
const FALLOFF_DISTANCE = 700;

/** One sand texture tile covers this many metres. */
const TEXTURE_TILE_M = 4;
const TEXTURE_PATH = 'textures/sand_albedo.webp';
/** Flat colour used until (or instead of) the texture, roughly the texture's average. */
const SAND_COLOR = 0xcfb083;

/** Grid line positions from min to max; step grows from fineStep inside [focusMin, focusMax] to coarseStep. */
function gridAxis(min: number, max: number, focusMin: number, focusMax: number, fineStep: number): number[] {
  const lines = [min];
  let p = min;
  while (p < max) {
    const outside = Math.max(focusMin - p, p - focusMax, 0);
    const t = Math.min(1, outside / FALLOFF_DISTANCE);
    p = Math.min(max, p + fineStep + (COARSE_STEP - fineStep) * t * t);
    lines.push(p);
  }
  return lines;
}

/** How rocky the ground at (x, z) is, 0..1: 1 at an outcrop's centre, 0 beyond 1.3 of its radii. */
function rockness(x: number, z: number): number {
  let best = 0;
  for (const rock of ROCK_OUTCROPS) {
    const d = Math.hypot(x - rock.x, z - rock.z) / (rock.radius * 1.3);
    best = Math.max(best, 1 - Math.min(1, d));
  }
  return best;
}

/**
 * The 4 km x 4 km desert floor. Vertex colours carry large-scale variation (pale crests, darker
 * hollows, rocky patches) so the 4 m detail tile does not read as a repeating pattern from afar.
 * `maxAnisotropy` should be `renderer.capabilities.getMaxAnisotropy()`.
 */
export function createTerrainMesh(maxAnisotropy = 8): THREE.Mesh {
  const xs = gridAxis(X_MIN, X_MAX, -FOCUS_X, FOCUS_X, FINE_STEP_X);
  const zs = gridAxis(Z_MIN, Z_MAX, FOCUS_Z_MIN, FOCUS_Z_MAX, FINE_STEP_Z);
  const nx = xs.length;
  const nz = zs.length;

  const positions = new Float32Array(nx * nz * 3);
  const uvs = new Float32Array(nx * nz * 2);
  const colors = new Float32Array(nx * nz * 3);
  const rock = new THREE.Color(0.55, 0.5, 0.45);
  const tint = new THREE.Color();

  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = xs[i];
      const z = zs[j];
      const y = terrainHeight(x, z);
      const k = j * nx + i;
      positions[k * 3] = x;
      positions[k * 3 + 1] = y;
      positions[k * 3 + 2] = z;
      uvs[k * 2] = x / TEXTURE_TILE_M;
      uvs[k * 2 + 1] = z / TEXTURE_TILE_M;

      // Neutral tint around 1: brighter on crests, darker in hollows, plus a slow patchy variation.
      const patch = 0.5 + 0.5 * Math.sin(x * 0.0071 + 1.3) * Math.sin(z * 0.0053 - 0.6);
      const shade = 0.88 + 0.1 * Math.max(-1, Math.min(1, y / 5)) + 0.1 * patch;
      tint.setRGB(shade, shade, shade);
      tint.lerp(rock, rockness(x, z) * 0.7);
      colors[k * 3] = tint.r;
      colors[k * 3 + 1] = tint.g;
      colors[k * 3 + 2] = tint.b;
    }
  }

  const indices = new Uint32Array((nx - 1) * (nz - 1) * 6);
  let w = 0;
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      // Counter-clockwise seen from above (+Y).
      indices[w++] = a;
      indices[w++] = c;
      indices[w++] = b;
      indices[w++] = b;
      indices[w++] = c;
      indices[w++] = d;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  // Flat sand colour until the detail map arrives; if it never does, the terrain just stays flat sand.
  const material = new THREE.MeshLambertMaterial({ color: SAND_COLOR, vertexColors: true });
  new THREE.TextureLoader().load(
    `${import.meta.env.BASE_URL}${TEXTURE_PATH}`,
    (texture) => {
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.generateMipmaps = true;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.anisotropy = maxAnisotropy;
      material.map = texture;
      material.color.set(0xe2e2ec); // the texture carries the sand colour; a cool tint tames its orange
      material.needsUpdate = true;
    },
    undefined,
    () => console.warn(`terrain: could not load ${TEXTURE_PATH}, using flat sand colour`),
  );

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'terrain';
  mesh.frustumCulled = false; // one big mesh that is almost always in view
  return mesh;
}

/** Low-poly boulders sitting on the outcrop mounds. */
export function createRocks(): THREE.Group {
  const group = new THREE.Group();
  group.name = 'rocks';
  const material = new THREE.MeshLambertMaterial({ color: 0x7a6a58, flatShading: true });
  const geometry = new THREE.DodecahedronGeometry(1, 0);
  // Deterministic jitter so the rocks are the same every load.
  let seed = 7;
  const rand = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (const outcrop of ROCK_OUTCROPS) {
    const count = 4 + Math.floor(rand() * 3);
    for (let n = 0; n < count; n++) {
      const angle = rand() * Math.PI * 2;
      const dist = rand() * outcrop.radius * 0.45;
      const x = outcrop.x + Math.cos(angle) * dist;
      const z = outcrop.z + Math.sin(angle) * dist;
      const size = (0.5 + rand() * 0.9) * (outcrop.height / 3);
      const rock = new THREE.Mesh(geometry, material);
      rock.scale.set(size * (1 + rand()), size * (0.6 + rand() * 0.5), size * (1 + rand()));
      rock.position.set(x, terrainHeight(x, z) + size * 0.1, z);
      rock.rotation.set(rand() * 3, rand() * 6.28, rand() * 3);
      group.add(rock);
    }
  }
  return group;
}
