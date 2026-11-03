import * as THREE from 'three';
import { ENEMY_UV_TILE_M, SURFACES } from '../mission/enemySurface';
import type { SurfaceKey } from '../mission/enemySurface';
import type { ModelFrame, ModelGroup, ModelPart, V3 } from '../mission/modelPart';
import { projectUVs } from '../player/rifleParts';
import { SURFACE_ATTRIBUTE } from './enemyMaterial';

// Building the enemies' geometry from primitives: tapered capsules for limbs, ellipsoids for muscle and bulk, rounded
// boxes for gear, lathes for helmets, loose triangles for ghillie strands. Every primitive is flattened to unindexed
// triangles with smooth normals of its own, painted (vertex colour = the tint of its surface, `surface` = what the
// shader does with it) and appended to ONE set of arrays, which `build()` turns into one BufferGeometry: a whole
// soldier is one mesh, one draw call.

/** A cheap hash in [0, 1) of an integer (the tone of each part, so identical sleeves are not identical). */
function hashUnit(n: number): number {
  const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
}

/** Options shared by every primitive. */
export interface PartOptions {
  /** Brightness variation of this part's colour, +-fraction (default 0.04): so identical parts differ a little. */
  jitter?: number;
}

/** A tapered capsule: radii `ra` at A and `rb` at B, hemispherical ends; `sx`/`sz` squash the cross-section (local x, z). */
export interface TubeOptions extends PartOptions {
  sx?: number;
  sz?: number;
  /** Sides around the axis (default 12: a multiple of 4, so the outline seen from the front reaches the full radius). */
  sides?: number;
  /** Rings in each end cap (default 1: one facet at 45 degrees, 72 triangles for a 12-sided tube). */
  caps?: number;
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);

/** A lathe profile for a capsule of length `length` along +y from the pole of A (y = -ra) to the pole of B (y = length + rb). */
export function capsuleProfile(ra: number, rb: number, length: number, caps: number): THREE.Vector2[] {
  const points: THREE.Vector2[] = [];
  for (let i = 0; i <= caps; i++) {
    const phi = (Math.PI / 2) * (1 - i / caps); // pole (90 degrees) down to the equator of A
    points.push(new THREE.Vector2(ra * Math.cos(phi), -ra * Math.sin(phi)));
  }
  for (let i = 0; i <= caps; i++) {
    const phi = (Math.PI / 2) * (i / caps); // equator of B up to its pole
    points.push(new THREE.Vector2(rb * Math.cos(phi), length + rb * Math.sin(phi)));
  }
  return points;
}

/**
 * A box of w x h x d with its edges bevelled by `bevel` (44 triangles: six flat faces, twelve edge strips, eight corner triangles; the
 * normals are the face axes at the faces' own vertices, so the strips shade as soft rounded edges). A third of the cost of a
 * RoundedBoxGeometry with one segment, which is what every pouch, pad and receiver of the enemies is made of.
 */
export function bevelledBox(w: number, h: number, d: number, bevel: number): THREE.BufferGeometry {
  const half = [w / 2, h / 2, d / 2];
  const b = Math.min(bevel, Math.min(...half) - 1e-4);
  const positions: number[] = [];
  const normals: number[] = [];
  /** The vertex of corner (sx, sy, sz) on the face of `axis`: full extent along that axis, inset by b along the others. */
  const vertex = (signs: readonly number[], axis: number): [number, number, number, number, number, number] => {
    const p = [0, 0, 0];
    const n = [0, 0, 0];
    for (let k = 0; k < 3; k++) p[k] = signs[k] * (k === axis ? half[k] : half[k] - b);
    n[axis] = signs[axis];
    return [p[0], p[1], p[2], n[0], n[1], n[2]];
  };
  const emit = (a: readonly number[], c: readonly number[], e: readonly number[]): void => {
    positions.push(a[0], a[1], a[2], c[0], c[1], c[2], e[0], e[1], e[2]);
    normals.push(a[3], a[4], a[5], c[3], c[4], c[5], e[3], e[4], e[5]);
  };
  /** A quad in the winding that faces away from the box's centre. */
  const quad = (v0: number[], v1: number[], v2: number[], v3: number[]): void => {
    // Orient by the geometric normal of (v0, v1, v2) against the direction from the centre to the quad.
    const ux = v1[0] - v0[0], uy = v1[1] - v0[1], uz = v1[2] - v0[2];
    const vx = v2[0] - v0[0], vy = v2[1] - v0[1], vz = v2[2] - v0[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const cx = (v0[0] + v1[0] + v2[0] + v3[0]) / 4, cy = (v0[1] + v1[1] + v2[1] + v3[1]) / 4, cz = (v0[2] + v1[2] + v2[2] + v3[2]) / 4;
    if (nx * cx + ny * cy + nz * cz >= 0) {
      emit(v0, v1, v2);
      emit(v0, v2, v3);
    } else {
      emit(v0, v2, v1);
      emit(v0, v3, v2);
    }
  };
  const signsOf = (i: number): number[] => [i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1];
  // Faces: the four corners that share a sign along `axis`.
  for (let axis = 0; axis < 3; axis++) {
    for (const sign of [-1, 1]) {
      const corners = [0, 1, 2, 3, 4, 5, 6, 7].filter((i) => signsOf(i)[axis] === sign);
      // Order around the face: sort by angle in the face plane.
      const others = [0, 1, 2].filter((k) => k !== axis);
      const ordered = corners.sort((p, q) => {
        const sp = signsOf(p);
        const sq = signsOf(q);
        return Math.atan2(sp[others[1]], sp[others[0]]) - Math.atan2(sq[others[1]], sq[others[0]]);
      });
      const verts = ordered.map((i) => vertex(signsOf(i), axis));
      quad(verts[0], verts[1], verts[2], verts[3]);
    }
  }
  // Edges: the two faces `a` and `c` meet along the third axis; the two corners sharing signs on a and c.
  for (let a = 0; a < 3; a++) {
    for (let c = a + 1; c < 3; c++) {
      const along = 3 - a - c;
      for (const sa of [-1, 1]) {
        for (const sc of [-1, 1]) {
          const end = (sAlong: number): number => {
            const signs = [0, 0, 0];
            signs[a] = sa;
            signs[c] = sc;
            signs[along] = sAlong;
            return signs[0] > 0 ? (signs[1] > 0 ? (signs[2] > 0 ? 7 : 3) : signs[2] > 0 ? 5 : 1) : signs[1] > 0 ? (signs[2] > 0 ? 6 : 2) : signs[2] > 0 ? 4 : 0;
          };
          const lo = signsOf(end(-1));
          const hi = signsOf(end(1));
          quad(vertex(lo, a), vertex(lo, c), vertex(hi, c), vertex(hi, a));
        }
      }
    }
  }
  // Corners: one triangle joining the three vertices of each corner.
  for (let i = 0; i < 8; i++) {
    const s = signsOf(i);
    const tri = [vertex(s, 0), vertex(s, 1), vertex(s, 2)];
    const nx = (tri[1][1] - tri[0][1]) * (tri[2][2] - tri[0][2]) - (tri[1][2] - tri[0][2]) * (tri[2][1] - tri[0][1]);
    const ny = (tri[1][2] - tri[0][2]) * (tri[2][0] - tri[0][0]) - (tri[1][0] - tri[0][0]) * (tri[2][2] - tri[0][2]);
    const nz = (tri[1][0] - tri[0][0]) * (tri[2][1] - tri[0][1]) - (tri[1][1] - tri[0][1]) * (tri[2][0] - tri[0][0]);
    if (nx * s[0] + ny * s[1] + nz * s[2] >= 0) emit(tri[0], tri[1], tri[2]);
    else emit(tri[0], tri[2], tri[1]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  return g;
}

/** Collects painted primitives and bakes them into one geometry. */
export class EnemyBuilder {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly colors: number[] = [];
  private readonly surfaces: number[] = [];
  private count = 0;
  private readonly matrix = new THREE.Matrix4();
  private readonly paint = new THREE.Color();
  private readonly placed = new THREE.Matrix4();
  private frame: THREE.Matrix4 | null = null;

  /** Triangles collected so far. */
  get triangles(): number {
    return this.positions.length / 9;
  }

  /** From now on every part is placed inside `frame` (an assembly's own axes: the rifle is built along +Z); `null` goes back to the model's. */
  setFrame(frame: ModelFrame | null): void {
    this.frame = frame
      ? new THREE.Matrix4().makeBasis(new THREE.Vector3(...frame.x), new THREE.Vector3(...frame.y), new THREE.Vector3(...frame.z)).setPosition(...frame.origin)
      : null;
  }

  /** Append one part of the model description. */
  addPart(part: ModelPart): void {
    switch (part.kind) {
      case 'tube':
        this.tube(part.a, part.b, part.ra, part.rb, part.surface, part.color, { sx: part.sx, sz: part.sz, sides: part.sides, caps: part.caps });
        break;
      case 'ellipsoid':
        this.ellipsoid(part.c, part.r, part.surface, part.color, part.rot, { detail: part.detail });
        break;
      case 'box':
        this.box(part.c, part.size, part.radius, part.surface, part.color, part.rot);
        break;
      case 'lathe':
        this.lathe(part.profile, part.c, part.surface, part.color, { scale: part.scale, rot: part.rot, sides: part.sides });
        break;
    }
  }

  /** Append every group of a model, each inside its own frame. */
  addModel(groups: readonly ModelGroup[]): void {
    for (const group of groups) {
      this.setFrame(group.frame ?? null);
      for (const part of group.parts) this.addPart(part);
    }
    this.setFrame(null);
  }

  /**
   * Append `geometry` (indexed or not; it is not modified) through `matrix` (and the current frame), painted with `surface` and the
   * sRGB tint `color`. A geometry without normals gets flat ones.
   */
  addGeometry(geometry: THREE.BufferGeometry, surface: SurfaceKey, color: number, matrix?: THREE.Matrix4, options: PartOptions = {}): void {
    const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    const local = matrix ?? this.placed.identity();
    if (this.frame) g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(this.frame, local));
    else if (matrix) g.applyMatrix4(matrix);
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const position = g.getAttribute('position');
    const normal = g.getAttribute('normal');
    const tone = 1 + (hashUnit(this.count++ + 1) - 0.5) * 2 * (options.jitter ?? 0.04);
    this.paint.set(color);
    const def = SURFACES[surface];
    for (let i = 0; i < position.count; i++) {
      this.positions.push(position.getX(i), position.getY(i), position.getZ(i));
      this.normals.push(normal.getX(i), normal.getY(i), normal.getZ(i));
      this.colors.push(this.paint.r * tone, this.paint.g * tone, this.paint.b * tone);
      this.surfaces.push(def.camo, def.roughness, def.metalness, def.bump);
    }
    g.dispose();
  }

  /** Append loose triangles (9 numbers each, counter-clockwise seen from outside) with flat normals. */
  addTriangles(triangles: readonly number[], surface: SurfaceKey, color: number, options: PartOptions = {}): void {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(triangles, 3));
    this.addGeometry(g, surface, color, undefined, options);
    g.dispose();
  }

  /**
   * A ghillie strand: a thin three-sided spike (3 triangles; its open base sits against the suit, so it is a closed shape as seen:
   * no cards to alpha-test, nothing double-sided) from `root` to `tip`, `radius` at the root, `color` at the middle, darker at
   * the root and lighter at the tip.
   */
  strand(root: V3, tip: V3, radius: number, color: number): void {
    const def = SURFACES.strand;
    const axis = new THREE.Vector3(...tip).sub(new THREE.Vector3(...root));
    const length = axis.length();
    axis.divideScalar(length);
    const side = Math.abs(axis.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const u = new THREE.Vector3().crossVectors(axis, side).normalize();
    const v = new THREE.Vector3().crossVectors(axis, u);
    const base: THREE.Vector3[] = [0, 1, 2].map((k) => {
      const a = (k * 2 * Math.PI) / 3;
      return new THREE.Vector3(...root).addScaledVector(u, Math.cos(a) * radius).addScaledVector(v, Math.sin(a) * radius);
    });
    const apex = new THREE.Vector3(...tip);
    this.paint.set(color);
    const tone = 1 + (hashUnit(this.count++ + 1) - 0.5) * 0.12;
    const faces: Array<[THREE.Vector3, THREE.Vector3, THREE.Vector3]> = [
      [base[0], base[1], apex],
      [base[1], base[2], apex],
      [base[2], base[0], apex],
    ];
    const normal = new THREE.Vector3();
    const edge = new THREE.Vector3();
    for (const [a, b, c] of faces) {
      normal.crossVectors(b.clone().sub(a), edge.copy(c).sub(a)).normalize();
      for (const p of [a, b, c]) {
        const t = p === apex ? 1.1 : 0.7;
        this.positions.push(p.x, p.y, p.z);
        this.normals.push(normal.x, normal.y, normal.z);
        this.colors.push(this.paint.r * tone * t, this.paint.g * tone * t, this.paint.b * tone * t);
        this.surfaces.push(def.camo, def.roughness, def.metalness, def.bump);
      }
    }
  }

  /** A tapered capsule from `a` to `b`. */
  tube(a: V3, b: V3, ra: number, rb: number, surface: SurfaceKey, color: number, options: TubeOptions = {}): void {
    const from = new THREE.Vector3(...a);
    const dir = new THREE.Vector3(...b).sub(from);
    const length = dir.length();
    const g = new THREE.LatheGeometry(capsuleProfile(ra, rb, length, options.caps ?? 1), options.sides ?? 12);
    const turn = new THREE.Quaternion().setFromUnitVectors(Y_AXIS, dir.normalize());
    this.matrix.compose(from, turn, new THREE.Vector3(options.sx ?? 1, 1, options.sz ?? 1));
    // The squash is along the tube's own x and z, so it is applied before the turn (compose does scale first).
    this.addGeometry(g, surface, color, this.matrix, options);
    g.dispose();
  }

  /** An ellipsoid with half-axes `r` at `c`, turned by the Euler angles `rot` (XYZ order, rad). */
  ellipsoid(c: V3, r: V3, surface: SurfaceKey, color: number, rot: V3 = [0, 0, 0], options: PartOptions & { detail?: number } = {}): void {
    // `detail` 1 is 12 segments around by 7 from pole to pole (144 triangles); the default 0.8 is 8 by 6 (80). The segments around are a
    // multiple of 4, so the outline seen from the front reaches the full radius (a vertex on each axis).
    const detail = options.detail ?? 0.8;
    const g = new THREE.SphereGeometry(1, 4 * Math.max(2, Math.round(3 * detail)), Math.max(4, Math.round(7 * detail)));
    this.matrix.compose(new THREE.Vector3(...c), new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot, 'XYZ')), new THREE.Vector3(...r));
    this.addGeometry(g, surface, color, this.matrix, options);
    g.dispose();
  }

  /** A box of `size` with edges rounded to `radius`, at `c`, turned by `rot`. */
  box(c: V3, size: V3, radius: number, surface: SurfaceKey, color: number, rot: V3 = [0, 0, 0], options: PartOptions = {}): void {
    // Bevelled (44 triangles, soft edges); a box with no radius is a plain 12-triangle one with flat faces.
    const g = radius > 0.0015 ? bevelledBox(size[0], size[1], size[2], radius) : new THREE.BoxGeometry(size[0], size[1], size[2]);
    this.matrix.compose(new THREE.Vector3(...c), new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot, 'XYZ')), new THREE.Vector3(1, 1, 1));
    this.addGeometry(g, surface, color, this.matrix, options);
    g.dispose();
  }

  /**
   * A solid of revolution about +y, from `profile` ((radius, height) pairs, bottom to top, outside surface), scaled by `scale`
   * (x, y, z), turned by `rot` and moved to `c`.
   */
  lathe(
    profile: ReadonlyArray<readonly [number, number]>,
    c: V3,
    surface: SurfaceKey,
    color: number,
    options: PartOptions & { scale?: V3; rot?: V3; sides?: number } = {},
  ): void {
    const g = new THREE.LatheGeometry(profile.map(([r, h]) => new THREE.Vector2(r, h)), options.sides ?? 18);
    this.matrix.compose(
      new THREE.Vector3(...c),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...(options.rot ?? [0, 0, 0]), 'XYZ')),
      new THREE.Vector3(...(options.scale ?? [1, 1, 1])),
    );
    this.addGeometry(g, surface, color, this.matrix, options);
    g.dispose();
  }

  /**
   * Bake everything into one geometry: positions, normals, `color` (linear), the box-projected `uv`, and the `surface` attribute.
   * `shade`, when given, multiplies each vertex colour by a factor of its position and normal (cheap baked dirt and occlusion).
   */
  build(shade?: (x: number, y: number, z: number, nx: number, ny: number, nz: number) => number): THREE.BufferGeometry {
    const colors = this.colors.slice();
    if (shade) {
      for (let i = 0; i < this.positions.length / 3; i++) {
        const k = shade(
          this.positions[i * 3],
          this.positions[i * 3 + 1],
          this.positions[i * 3 + 2],
          this.normals[i * 3],
          this.normals[i * 3 + 1],
          this.normals[i * 3 + 2],
        );
        colors[i * 3] *= k;
        colors[i * 3 + 1] *= k;
        colors[i * 3 + 2] *= k;
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.setAttribute(SURFACE_ATTRIBUTE, new THREE.Float32BufferAttribute(this.surfaces, 4));
    projectUVs(geometry, ENEMY_UV_TILE_M);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }
}
