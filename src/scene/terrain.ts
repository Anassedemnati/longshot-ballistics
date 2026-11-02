import * as THREE from 'three';
import { createRng } from '../mission/random';
import type { ThemeId } from '../mission/themes';
import { SKY_LOOKS, sunDirectionOf } from './sky';
import { bakeLighting, interpolateGrid, sampleHeightGrid } from './terrainBake';
import type { SunVector } from './terrainBake';
import { sectorDistance, smoothstep } from './terrainField';
import type { RockOutcrop, TerrainField } from './terrainField';
import { TERRAIN_MATERIAL_LOOKS, createTerrainMaterial, loadTerrainTextures } from './terrainMaterial';

export { DESERT_FIELD, SHOOTER_POS, terrainHeight } from './terrainHeight';

/** Map extent: 4 km x 4 km, the shooter near the +Z end so the lane runs down the long middle. */
const X_MIN = -2000;
const X_MAX = 2000;
const Z_MIN = -3000;
const Z_MAX = 1000;

/**
 * The fine mesh covers the engagement sector (out to 1600 m, +-12 deg) with a margin, plus the
 * shooter's rise; spacing grows with distance beyond it. Fine spacing is well under the 6 m the
 * sector needs: the surface and `height()` then agree to a few centimetres at any target spot.
 * Beyond the sector the grid coarsens to 25 m within 250 m of the focus box: the valley walls (up to
 * 250 m high, ridgelines 300-500 m apart, strata 85-210 m) still read as eroded ridges at that spacing.
 */
const FOCUS_X = 450; // 1650 m * sin(15 deg) = 427 m
const FOCUS_Z_MIN = -1700;
const FOCUS_Z_MAX = 120;
const FINE_STEP = 4;
/** Extra-fine ring around the origin: the prone view sits right over the rise, and the mountain's 90 m spur needs it to read as crags. */
const NEAR_HALF = 100;
const NEAR_STEP = 3;
/** Finer still round the origin: the mountain's summit is a cone, and the shooter's own view (and nest) sits on its tip. */
const TIP_HALF = 10;
const TIP_STEP = 1.5;
const COARSE_STEP = 25;
const FALLOFF_DISTANCE = 250;

/**
 * Grid line positions from min to max, with a line exactly on 0 (min < 0 < max): the shooter's feet, and the mountain's
 * summit, a 62 degree spike whose rendered tip would otherwise lie metres below the height field's apex. Built outward
 * from 0 in both directions; the step grows linearly from FINE_STEP inside [focusMin, focusMax] to COARSE_STEP,
 * FALLOFF_DISTANCE beyond it (and is at most NEAR_STEP within NEAR_HALF of the origin, TIP_STEP within TIP_HALF).
 */
function gridAxis(min: number, max: number, focusMin: number, focusMax: number): number[] {
  const stepAt = (p: number): number => {
    const outside = Math.max(focusMin - p, p - focusMax, 0);
    const t = Math.min(1, outside / FALLOFF_DISTANCE);
    const step = FINE_STEP + (COARSE_STEP - FINE_STEP) * t;
    if (Math.abs(p) < TIP_HALF) return Math.min(step, TIP_STEP);
    return Math.abs(p) < NEAR_HALF ? Math.min(step, NEAR_STEP) : step;
  };
  const up = [0];
  for (let p = 0; p < max; ) {
    p = Math.min(max, p + stepAt(p));
    up.push(p);
  }
  const down: number[] = [];
  for (let p = 0; p > min; ) {
    p = Math.max(min, p - stepAt(p));
    down.push(p);
  }
  return [...down.reverse(), ...up];
}

/** The x and z grid lines of the terrain mesh (vertex k = j * xs.length + i sits at xs[i], zs[j]). */
export function terrainGridAxes(): { xs: number[]; zs: number[] } {
  return {
    xs: gridAxis(X_MIN, X_MAX, -FOCUS_X, FOCUS_X),
    zs: gridAxis(Z_MIN, Z_MAX, FOCUS_Z_MIN, FOCUS_Z_MAX),
  };
}

/** Vertex-colour variation per theme (the shader and its textures live in terrainMaterial.ts). */
interface TerrainLook {
  /** Fallback texture tile for the `uv` attribute, m: the ground detail tile (the shader works in world space, but the fallback bump relief reads uv). */
  tileM: number;
  /** Colour of the rocky patches around outcrops. */
  rockPatch: THREE.Color;
  /** Neutral vertex tint around 1 at a vertex, from height `y` and a slow patchy variation 0..1. */
  tint(y: number, patch: number, out: THREE.Color): void;
}

const LOOKS: Record<ThemeId, TerrainLook> = {
  desert: {
    tileM: TERRAIN_MATERIAL_LOOKS.desert.tileM[0],
    rockPatch: new THREE.Color(0.5, 0.48, 0.46),
    // Pale crests, darker hollows.
    tint: (y, patch, out) => {
      const shade = 0.88 + 0.1 * Math.max(-1, Math.min(1, y / 5)) + 0.1 * patch;
      out.setRGB(shade, shade, shade);
    },
  },
  arctic: {
    tileM: TERRAIN_MATERIAL_LOOKS.arctic.tileM[0],
    rockPatch: new THREE.Color(0.3, 0.31, 0.34),
    // Bright drift crests, faintly blue hollows.
    tint: (y, patch, out) => {
      const shade = 0.9 + 0.06 * Math.max(-1, Math.min(1, y / 4)) + 0.06 * patch;
      out.setRGB(shade * 0.96, shade * 0.98, shade);
    },
  },
  valley: {
    tileM: TERRAIN_MATERIAL_LOOKS.valley.tileM[0],
    rockPatch: new THREE.Color(0.48, 0.44, 0.38),
    // Lush and darker low down, drier and paler on the hilltops.
    tint: (y, patch, out) => {
      const high = Math.max(0, Math.min(1, y / 22));
      out.setRGB(0.95 + 0.2 * high + 0.12 * patch, 1.04 + 0.1 * high + 0.12 * patch, 0.85 + 0.05 * patch);
    },
  },
};

/** How rocky the ground at (x, z) is, 0..1: 1 at an outcrop's centre, 0 beyond 1.3 of its radii. */
function rockness(outcrops: ReadonlyArray<RockOutcrop>, x: number, z: number): number {
  let best = 0;
  for (const rock of outcrops) {
    const d = Math.hypot(x - rock.x, z - rock.z) / (rock.radius * 1.3);
    best = Math.max(best, 1 - Math.min(1, d));
  }
  return best;
}

/** Spacing of the baked-lighting grid, m: 20 m resolves the walls' shadows and gullies, and keeps the bake near 0.2 s. */
const BAKE_STEP = 20;

/**
 * Share of a wall's shadow kept on the engagement sector's floor: the targets and props standing there are lit by the
 * sun (the terrain casts no real-time shadow on them), so ground in full shade would look wrong around them.
 * It rises to the full shadow over 300 m outside the sector.
 */
const SECTOR_SHADOW = 0.55;

/** The sun of `theme` (the same one the sky and the shadow light use) as a plain vector. */
function themeSun(theme: ThemeId): SunVector {
  const dir = sunDirectionOf(SKY_LOOKS[theme]);
  return { x: dir.x, y: dir.y, z: dir.z };
}

/**
 * The terrain surface of `field` on the shared grid. Vertex colours carry large-scale variation
 * (crests, hollows, rocky patches) so the detail tile does not read as a repeating pattern from afar.
 * The `bake` attribute (vec2) holds the baked lighting: sun visibility (0 in the shadow of the walls, 1 in the open)
 * and ambient occlusion (1 open sky .. 0 deep gully), for `sun` (default: the theme's sun), computed on a 20 m grid
 * of the height field and interpolated to the vertices.
 */
export function buildTerrainGeometry(field: TerrainField, sun: SunVector = themeSun(field.theme)): THREE.BufferGeometry {
  const look = LOOKS[field.theme];
  const { xs, zs } = terrainGridAxes();
  const nx = xs.length;
  const nz = zs.length;

  const positions = new Float32Array(nx * nz * 3);
  const uvs = new Float32Array(nx * nz * 2);
  const colors = new Float32Array(nx * nz * 3);
  const baked = new Float32Array(nx * nz * 2);
  const heightGrid = sampleHeightGrid(field.height, X_MIN, X_MAX, Z_MIN, Z_MAX, BAKE_STEP);
  const bake = bakeLighting(heightGrid, sun);
  const tint = new THREE.Color();

  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = xs[i];
      const z = zs[j];
      const y = field.height(x, z);
      const k = j * nx + i;
      positions[k * 3] = x;
      positions[k * 3 + 1] = y;
      positions[k * 3 + 2] = z;
      uvs[k * 2] = x / look.tileM;
      uvs[k * 2 + 1] = z / look.tileM;

      // Neutral tint around 1 plus a slow patchy variation.
      const patch = 0.5 + 0.5 * Math.sin(x * 0.0071 + 1.3) * Math.sin(z * 0.0053 - 0.6);
      look.tint(y, patch, tint);
      tint.lerp(look.rockPatch, rockness(field.outcrops, x, z) * 0.7);
      colors[k * 3] = tint.r;
      colors[k * 3 + 1] = tint.g;
      colors[k * 3 + 2] = tint.b;
      const keep = SECTOR_SHADOW + (1 - SECTOR_SHADOW) * smoothstep(0, 300, sectorDistance(x, z));
      baked[k * 2] = 1 - (1 - interpolateGrid(heightGrid, bake.sun, x, z)) * keep;
      baked[k * 2 + 1] = interpolateGrid(heightGrid, bake.ao, x, z);
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
  geometry.setAttribute('bake', new THREE.BufferAttribute(baked, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * The 4 km x 4 km ground of `field`, textured for its theme (sand, snow or grass, with cliff rock on the steep ground).
 * `maxAnisotropy` should be `renderer.capabilities.getMaxAnisotropy()`. `sun` is the unit vector towards the sun the baked shadows are cast for
 * (default: the theme's sun from sky.ts, which is the one the lights use).
 * The mesh shows the flat-colour look at once and switches to the photographic textures when they have loaded.
 */
export function createTerrainMesh(field: TerrainField, maxAnisotropy = 8, sun?: SunVector): THREE.Mesh {
  const geometry = buildTerrainGeometry(field, sun);
  const material = createTerrainMaterial(field.theme, maxAnisotropy);
  void loadTerrainTextures(material, { maxAnisotropy });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'terrain';
  mesh.frustumCulled = false; // one big mesh that is almost always in view
  mesh.receiveShadow = true; // the ground takes the shadows of props and soldiers; it casts none (it would fill the shadow map)
  return mesh;
}

/** Low-poly boulders sitting on the outcrop mounds of `field`. */
export function createRocks(field: TerrainField): THREE.Group {
  const group = new THREE.Group();
  group.name = 'rocks';
  const material = new THREE.MeshStandardMaterial({ color: TERRAIN_MATERIAL_LOOKS[field.theme].rockColor, roughness: 0.92, flatShading: true });
  const geometry = new THREE.DodecahedronGeometry(1, 0);
  // Deterministic jitter so the rocks are the same every load.
  const rand = createRng(7);
  for (const outcrop of field.outcrops) {
    const count = 4 + Math.floor(rand() * 3);
    for (let n = 0; n < count; n++) {
      const angle = rand() * Math.PI * 2;
      const dist = rand() * outcrop.radius * 0.45;
      const x = outcrop.x + Math.cos(angle) * dist;
      const z = outcrop.z + Math.sin(angle) * dist;
      const size = (0.5 + rand() * 0.9) * (outcrop.height / 3);
      const rock = new THREE.Mesh(geometry, material);
      rock.scale.set(size * (1 + rand()), size * (0.6 + rand() * 0.5), size * (1 + rand()));
      rock.position.set(x, field.height(x, z) + size * 0.1, z);
      rock.rotation.set(rand() * 3, rand() * 6.28, rand() * 3);
      rock.castShadow = true;
      rock.receiveShadow = true;
      group.add(rock);
    }
  }
  return group;
}
