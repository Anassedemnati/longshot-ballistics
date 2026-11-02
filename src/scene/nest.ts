import * as THREE from 'three';
import type { FiringPosition } from '../mission/config';
import { PAD_EDGE_RADIUS, planNest } from '../mission/nestPlan';
import type { NestPlan } from '../mission/nestPlan';
import type { ThemeId } from '../mission/themes';
import type { TerrainField } from './terrainField';
import { boulderMaterial, gltfModelLoader, loadModelKit, loadTexture, meshGroundOf, patchSurface, rockGeometry, rockMaterial } from './vegetation';
import type { ModelLoader } from './vegetation';

// The firing nest (spec C.4), built from the pure plan in mission/nestPlan.ts: a crescent of sandbags (rounded pillows,
// one InstancedMesh), two to four boulders round the shooter (one InstancedMesh), and on the mountain a levelled rock
// platform that holds them on the summit's steep tip. Visual only (no colliders). Every mesh stays inside the plan's
// boxes (a sandbag inside its box, a rock inside its box), which the tests check against the lines of sight.

/** Sandbag cloth: the sand texture tinted per theme (flat colour until or without it), greyer and snowy in the arctic. */
const BAG_TINT: Record<ThemeId, number> = { desert: 0xe6cf9c, arctic: 0xbfc0b8, valley: 0xc2bd88 };
const BAG_FLAT: Record<ThemeId, number> = { desert: 0xb59a68, arctic: 0x8d8e88, valley: 0x6f7049 };

/** A cheap hash of an index in [0, 1). */
const hash01 = (i: number): number => {
  const v = Math.sin(i * 12.9898 + 4.1) * 43758.5453;
  return v - Math.floor(v);
};

/** Signed power: sign(v) * |v|^e. */
const sgnPow = (v: number, e: number): number => Math.sign(v) * Math.pow(Math.abs(v), e);

/**
 * A sandbag in a unit frame (half sizes 1, 1, 1 along x, y, z; the long side along x): a rounded box, the ends pinched like
 * a tied sack, the top a little bulged, lumpy. Always inside the unit cube.
 */
export function sandbagGeometry(): THREE.BufferGeometry {
  const lon = 18;
  const lat = 10;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let j = 0; j <= lat; j++) {
    const theta = -Math.PI / 2 + (j / lat) * Math.PI;
    for (let i = 0; i <= lon; i++) {
      const phi = (i / lon) * Math.PI * 2;
      const cx = sgnPow(Math.cos(theta), 0.42);
      let x = cx * sgnPow(Math.cos(phi), 0.42);
      let y = sgnPow(Math.sin(theta), 0.5);
      let z = cx * sgnPow(Math.sin(phi), 0.42);
      const pinch = 1 - 0.32 * Math.pow(Math.abs(x), 3); // the ends narrow
      y *= pinch;
      z *= pinch;
      if (y > 0) y *= 1 - 0.1 * (x * x + z * z); // the top sags towards the edges
      const lump = 0.035 * Math.sin(phi * 3 + theta * 5) * Math.cos(theta);
      x = Math.max(-1, Math.min(1, x + lump));
      y = Math.max(-1, Math.min(1, y + lump * 0.6));
      z = Math.max(-1, Math.min(1, z + lump));
      positions.push(x, y, z);
      uvs.push((i / lon) * 5, (j / lat) * 3); // fine grain: the sand texture's big tracks would read as wood grain
    }
  }
  for (let j = 0; j < lat; j++) {
    for (let i = 0; i < lon; i++) {
      const a = j * (lon + 1) + i;
      const b = a + 1;
      const c = a + lon + 1;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/** The mountain platform as a polar grid following `surface` (outside its edge: the exact ground, a few cm above the terrain mesh so it covers the mesh's facets round the tip). */
export function padGeometry(plan: NestPlan): THREE.BufferGeometry {
  const rings = [0, 0.6, 1.2, 1.8, 2.3, PAD_EDGE_RADIUS, 3.6, 4.6, 6.2];
  const segments = 40;
  const positions: number[] = [];
  const uvs: number[] = [];
  const { eye } = plan;
  for (const r of rings) {
    for (let s = 0; s < segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      const x = eye.x + Math.cos(a) * r;
      const z = eye.z + Math.sin(a) * r;
      // Outside the platform's edge it is the natural ground: lift it 3 cm (the render mesh is within 2.5 cm of it).
      positions.push(x, plan.surface(x, z) + (r >= PAD_EDGE_RADIUS ? 0.03 : 0), z);
      uvs.push(x / 2.5, z / 2.5);
    }
  }
  const indices: number[] = [];
  for (let k = 0; k < rings.length - 1; k++) {
    for (let s = 0; s < segments; s++) {
      const a = k * segments + s;
      const b = k * segments + ((s + 1) % segments);
      const c = (k + 1) * segments + s;
      const d = (k + 1) * segments + ((s + 1) % segments);
      indices.push(a, b, c, b, d, c); // counter-clockwise seen from above (the angle runs +x to +z)
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

export interface Nest {
  /** Starts with the sandbags (and the platform); the rocks join when the boulder model has loaded or failed. */
  group: THREE.Group;
  plan: NestPlan;
  /** Settles when the rocks are in `group`. Never rejects. */
  ready: Promise<void>;
}

export interface NestOptions {
  maxAnisotropy?: number;
  loadModel?: ModelLoader;
  /** The terrain mesh's surface (see `meshGroundOf`); computed when absent. */
  ground?: (x: number, z: number) => number;
}

const SCRATCH = new THREE.Object3D();

/** The nest of a mission: sandbags, rocks and (on the mountain) the platform, round the shooter's eye. */
export function createNest(field: TerrainField, seed: number, position: FiringPosition, options: NestOptions = {}): Nest {
  const theme = field.theme;
  const maxAnisotropy = options.maxAnisotropy ?? 8;
  const plan = planNest({
    eye: field.shooter,
    ground: options.ground ?? meshGroundOf(field),
    terrain: field.height,
    position,
    theme,
    seed,
  });
  const group = new THREE.Group();
  group.name = 'nest';
  const freeze = (o: THREE.Object3D): void => {
    o.matrixAutoUpdate = false;
    o.updateMatrix();
  };

  // ---- the platform
  if (plan.pad) {
    const material = rockMaterial(theme, maxAnisotropy, 1.4); // lit from above only: the cliff face is in its own shade
    material.flatShading = false;
    material.polygonOffset = true; // wins the depth tie with the terrain mesh where they coincide
    material.polygonOffsetFactor = -2;
    material.polygonOffsetUnits = -2;
    const pad = new THREE.Mesh(padGeometry(plan), material);
    pad.name = 'nest-platform';
    pad.receiveShadow = true;
    pad.castShadow = true;
    pad.frustumCulled = false;
    freeze(pad);
    group.add(pad);
  }

  // ---- the sandbags
  const bagMaterial = new THREE.MeshStandardMaterial({ color: BAG_FLAT[theme], roughness: 1, metalness: 0 });
  loadTexture(`${import.meta.env.BASE_URL}assets/textures/sand_diff.jpg`, maxAnisotropy, (texture) => {
    bagMaterial.map = texture;
    bagMaterial.color.set(BAG_TINT[theme]);
    bagMaterial.needsUpdate = true;
  });
  patchSurface(bagMaterial, 'sandbag', theme === 'arctic' ? { saturation: 0.35, snow: { from: 0.5, to: 0.85, amount: 0.9 } } : { saturation: 0.9 });
  const bags = new THREE.InstancedMesh(sandbagGeometry(), bagMaterial, Math.max(1, plan.bags.length));
  bags.name = 'nest-sandbags';
  bags.count = plan.bags.length;
  const color = new THREE.Color();
  plan.bags.forEach((b, i) => {
    SCRATCH.position.set(b.x, b.y, b.z);
    SCRATCH.rotation.set(0, b.yaw, 0);
    SCRATCH.scale.set(b.hx, b.hy, b.hz);
    SCRATCH.updateMatrix();
    bags.setMatrixAt(i, SCRATCH.matrix);
    bags.setColorAt(i, color.setScalar(0.82 + 0.28 * hash01(i)));
  });
  bags.castShadow = true;
  bags.receiveShadow = true;
  bags.computeBoundingSphere();
  freeze(bags);
  group.add(bags);

  // ---- the rocks (the glTF boulder, else the procedural rock)
  const loader = options.loadModel ?? gltfModelLoader();
  const ready = loadModelKit(loader)
    .then((kit) => {
      const geometry = kit.boulder ? kit.boulder.geometry : rockGeometry();
      const material = kit.boulder ? boulderMaterial(kit.boulder, theme) : rockMaterial(theme, maxAnisotropy);
      const rocks = new THREE.InstancedMesh(geometry, material, Math.max(1, plan.rocks.length));
      rocks.name = 'nest-rocks';
      rocks.count = plan.rocks.length;
      plan.rocks.forEach((r, i) => {
        SCRATCH.position.set(r.x, r.y, r.z);
        SCRATCH.rotation.set(0, r.yaw, 0);
        SCRATCH.scale.set(r.sx, r.sy, r.sz);
        SCRATCH.updateMatrix();
        rocks.setMatrixAt(i, SCRATCH.matrix);
        rocks.setColorAt(i, color.setScalar(0.85 + 0.12 * i));
      });
      rocks.castShadow = true;
      rocks.receiveShadow = true;
      rocks.computeBoundingSphere();
      freeze(rocks);
      group.add(rocks);
    })
    .catch((e) => console.warn(`nest: ${e instanceof Error ? e.message : String(e)}`));
  return { group, plan, ready };
}
