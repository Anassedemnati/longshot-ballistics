import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** The surfaces of the rifle: one mesh (one draw call) per key. */
export type MaterialKey = 'metal' | 'stock' | 'rubber' | 'glass' | 'glove';

/** How one part is painted. `color` is sRGB hex (the part's albedo); `wear` (0..1) shows bare edges on rounded boxes. */
export interface PartStyle {
  color?: number;
  wear?: number;
  /** Corner rounding of a box, as a fraction of its smallest side (default 0.15; above 0.25 the corners get more facets). */
  round?: number;
}

/** Albedo of a part with no colour of its own, by key (linear multipliers; the material's own colour multiplies). */
const DEFAULT_COLOR: Readonly<Record<MaterialKey, number>> = {
  metal: 0x2a2d32,
  stock: 0xffffff,
  rubber: 0x1b1f20,
  glass: 0xffffff,
  glove: 0xffffff,
};

/** What worn edges turn into, per key: bare steel for the coated metal, a paler chalky edge for polymer and rubber. */
const WEAR_COLOR: Readonly<Record<MaterialKey, THREE.Color | null>> = {
  metal: new THREE.Color(0x9a9da1),
  stock: new THREE.Color().setRGB(2.1, 2, 1.8),
  rubber: new THREE.Color(0x55595a),
  glass: null,
  glove: null,
};

/** How big one repeat of the texture is on the model, m (texel size and the visible detail follow from it). */
const UV_TILE_M: Readonly<Record<MaterialKey, number>> = {
  metal: 0.12,
  stock: 0.1,
  rubber: 0.08,
  glass: 1,
  glove: 0.06,
};

const scratchColor = new THREE.Color();

/** Per-vertex albedo (an RGB `color` attribute): `style.color`, blended toward the worn colour along rounded edges. */
function paint(geometry: THREE.BufferGeometry, key: MaterialKey, style: PartStyle): void {
  const count = geometry.attributes.position.count;
  const base = new THREE.Color(style.color ?? DEFAULT_COLOR[key]);
  const worn = WEAR_COLOR[key];
  const strength = style.wear ?? 0;
  const colors = new Float32Array(count * 3);
  const normal = geometry.attributes.normal;
  for (let i = 0; i < count; i++) {
    scratchColor.copy(base);
    if (worn && strength > 0) {
      // A flat face of a box has its normal on an axis; the softened edges and corners lean away from every axis.
      const lean = 1 - Math.max(Math.abs(normal.getX(i)), Math.abs(normal.getY(i)), Math.abs(normal.getZ(i)));
      const edge = Math.min(1, Math.max(0, (lean - 0.05) / 0.2));
      scratchColor.lerp(worn, edge * edge * (3 - 2 * edge) * strength);
    }
    colors[i * 3] = scratchColor.r;
    colors[i * 3 + 1] = scratchColor.g;
    colors[i * 3 + 2] = scratchColor.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

/**
 * Box-project the texture coordinates of an unindexed geometry: every triangle is flattened along the axis its face
 * points at, `tileM` metres to one repeat. One texel size on every part, whatever the part's own UVs were.
 */
function projectUVs(geometry: THREE.BufferGeometry, tileM: number): void {
  const position = geometry.attributes.position;
  const uv = new Float32Array(position.count * 2);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const normal = new THREE.Vector3();
  for (let i = 0; i + 2 < position.count; i += 3) {
    a.fromBufferAttribute(position, i);
    b.fromBufferAttribute(position, i + 1);
    c.fromBufferAttribute(position, i + 2);
    normal.crossVectors(b.sub(a), c.sub(a));
    const ax = Math.abs(normal.x);
    const ay = Math.abs(normal.y);
    const az = Math.abs(normal.z);
    for (let k = 0; k < 3; k++) {
      const x = position.getX(i + k) / tileM;
      const y = position.getY(i + k) / tileM;
      const z = position.getZ(i + k) / tileM;
      const [u, v] = ax >= ay && ax >= az ? [z, y] : ay >= az ? [x, z] : [x, y];
      uv[(i + k) * 2] = u;
      uv[(i + k) * 2 + 1] = v;
    }
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/** The part-by-part geometry of one model, collected per material and then baked into one mesh per material. */
export class PartSet {
  private readonly byMaterial = new Map<MaterialKey, THREE.BufferGeometry[]>();
  private readonly matrix = new THREE.Matrix4();
  private readonly euler = new THREE.Euler();
  private readonly quaternion = new THREE.Quaternion();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private frame: THREE.Matrix4 | null = null;

  /** From now on every part is placed inside `frame` (a sub-assembly's own axes); `null` goes back to the model's. */
  setFrame(frame: THREE.Matrix4 | null): void {
    this.frame = frame;
  }

  /** Put `geometry` through `matrix` (inside the current frame) and file it under `material`. */
  place(material: MaterialKey, geometry: THREE.BufferGeometry, matrix: THREE.Matrix4, style: PartStyle = {}): void {
    paint(geometry, material, style); // from the part's own normals, so before it is moved
    geometry.applyMatrix4(this.frame ? this.matrix.multiplyMatrices(this.frame, matrix) : matrix);
    // Rounded boxes are not indexed and cylinders are; a merge needs them all alike.
    const part = geometry.index ? geometry.toNonIndexed() : geometry;
    if (part !== geometry) geometry.dispose();
    const list = this.byMaterial.get(material);
    if (list) list.push(part);
    else this.byMaterial.set(material, [part]);
  }

  /** Put `geometry` at (x, y, z), turned by the Euler angles (XYZ order), optionally scaled, and file it under `material`. */
  add(
    material: MaterialKey,
    geometry: THREE.BufferGeometry,
    x: number,
    y: number,
    z: number,
    rx = 0,
    ry = 0,
    rz = 0,
    style: PartStyle = {},
    scale?: readonly [number, number, number],
  ): void {
    this.euler.set(rx, ry, rz, 'XYZ');
    this.quaternion.setFromEuler(this.euler);
    this.position.set(x, y, z);
    this.scale.set(scale?.[0] ?? 1, scale?.[1] ?? 1, scale?.[2] ?? 1);
    const local = new THREE.Matrix4().compose(this.position, this.quaternion, this.scale);
    this.place(material, geometry, local, style);
  }

  /** A box of w x h x d with softened edges (plain for slivers, where rounding would only add triangles). */
  box(material: MaterialKey, w: number, h: number, d: number, x: number, y: number, z: number, rx = 0, style: PartStyle = {}): void {
    const smallest = Math.min(w, h, d);
    const round = style.round ?? 0.15;
    const geometry =
      smallest < 0.02 ? new THREE.BoxGeometry(w, h, d) : new RoundedBoxGeometry(w, h, d, round > 0.25 ? 4 : 2, smallest * round);
    this.add(material, geometry, x, y, z, rx, 0, 0, style);
  }

  /**
   * A cylinder (or cone: `rFront` is the radius at the muzzle end) along the z axis by default; `rx/rz` turn it.
   * Small tubes get fewer sides.
   */
  tube(
    material: MaterialKey,
    rFront: number,
    rBack: number,
    length: number,
    x: number,
    y: number,
    z: number,
    rx = Math.PI / 2,
    rz = 0,
    style: PartStyle = {},
  ): void {
    const radius = Math.max(rFront, rBack);
    const sides = radius >= 0.03 ? 32 : radius >= 0.015 ? 20 : 10;
    // CylinderGeometry has its +y end (radiusTop) toward the shooter once turned about x.
    this.add(material, new THREE.CylinderGeometry(rBack, rFront, length, sides), x, y, z, rx, 0, rz, style);
  }

  sphere(material: MaterialKey, radius: number, x: number, y: number, z: number, style: PartStyle = {}): void {
    this.add(material, new THREE.SphereGeometry(radius, 16, 10), x, y, z, 0, 0, 0, style);
  }

  /** An ellipsoid with the three radii `rx`, `ry`, `rz`. */
  ellipsoid(material: MaterialKey, rx: number, ry: number, rz: number, x: number, y: number, z: number, style: PartStyle = {}): void {
    this.add(material, new THREE.SphereGeometry(1, 20, 14), x, y, z, 0, 0, 0, style, [rx, ry, rz]);
  }

  /**
   * A solid of revolution about the z axis. `profile` is (radius, distance back from the front end) pairs running from
   * the front to the rear along the outside (the part is on the left of the walk); a repeated point is a hard corner.
   */
  lathe(material: MaterialKey, profile: ReadonlyArray<readonly [number, number]>, x: number, y: number, zFront: number, style: PartStyle = {}): void {
    const points = profile.map(([r, d]) => new THREE.Vector2(r, d));
    this.add(material, new THREE.LatheGeometry(points, 32), x, y, zFront, Math.PI / 2, 0, 0, style);
  }

  /** One mesh per material (named after its key), in `materials`; the part geometry is merged and then released. */
  toMeshes(materials: Readonly<Record<MaterialKey, THREE.Material>>): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    for (const [key, list] of this.byMaterial) {
      const merged = mergeGeometries(list);
      if (!merged) throw new Error(`rifle: parts of '${key}' could not be merged`);
      for (const part of list) part.dispose();
      projectUVs(merged, UV_TILE_M[key]);
      const mesh = new THREE.Mesh(merged, materials[key]);
      mesh.name = key;
      mesh.frustumCulled = false; // always within a hand's reach of the camera
      meshes.push(mesh);
    }
    return meshes;
  }
}
