import type * as THREE from 'three';

// The silhouette of a mesh seen from a direction, measured from its real triangles: the triangles are projected into
// an image plane and filled into a fine grid, and a hit sphere's disc (the circle it casts in that plane) is then
// checked against the grid. One convex hull per part would pass falsely for anything bent (an arm, a pouch on a vest),
// so this is what proves that the DRAWN body covers every hit sphere to within MAX_OVERHANG.

/** A filled-in image of a mesh: `mask[i * nv + j]` is 1 where cell (i, j) has a triangle over it. */
export interface Silhouette {
  mask: Uint8Array;
  nu: number;
  nv: number;
  u0: number;
  v0: number;
  cell: number;
}

/** A point of the model frame in the image plane. */
export type Projection = (x: number, y: number, z: number) => [number, number];

/** Rasterise the triangles of `geometry` (unindexed or indexed) seen through `project`, on a grid of `cell` metres. */
export function rasterize(geometry: THREE.BufferGeometry, project: Projection, cell = 0.0025): Silhouette {
  const position = geometry.getAttribute('position');
  const index = geometry.index;
  const count = index ? index.count : position.count;
  const us = new Float64Array(position.count);
  const vs = new Float64Array(position.count);
  let uMin = Infinity;
  let vMin = Infinity;
  let uMax = -Infinity;
  let vMax = -Infinity;
  for (let i = 0; i < position.count; i++) {
    const [u, v] = project(position.getX(i), position.getY(i), position.getZ(i));
    us[i] = u;
    vs[i] = v;
    uMin = Math.min(uMin, u);
    uMax = Math.max(uMax, u);
    vMin = Math.min(vMin, v);
    vMax = Math.max(vMax, v);
  }
  const margin = 0.1;
  const u0 = uMin - margin;
  const v0 = vMin - margin;
  const nu = Math.ceil((uMax - u0 + margin) / cell);
  const nv = Math.ceil((vMax - v0 + margin) / cell);
  const mask = new Uint8Array(nu * nv);
  for (let t = 0; t + 2 < count; t += 3) {
    const a = index ? index.getX(t) : t;
    const b = index ? index.getX(t + 1) : t + 1;
    const c = index ? index.getX(t + 2) : t + 2;
    const ax = us[a], ay = vs[a], bx = us[b], by = vs[b], cx = us[c], cy = vs[c];
    const minI = Math.max(0, Math.floor((Math.min(ax, bx, cx) - u0) / cell));
    const maxI = Math.min(nu - 1, Math.floor((Math.max(ax, bx, cx) - u0) / cell));
    const minJ = Math.max(0, Math.floor((Math.min(ay, by, cy) - v0) / cell));
    const maxJ = Math.min(nv - 1, Math.floor((Math.max(ay, by, cy) - v0) / cell));
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    // Whatever the triangle, the cells under its corners count (a sliver thinner than a cell still shows).
    for (const [px, py] of [[ax, ay], [bx, by], [cx, cy]]) {
      const i = Math.floor((px - u0) / cell);
      const j = Math.floor((py - v0) / cell);
      if (i >= 0 && i < nu && j >= 0 && j < nv) mask[i * nv + j] = 1;
    }
    if (Math.abs(area) < 1e-12) continue;
    for (let i = minI; i <= maxI; i++) {
      const px = u0 + (i + 0.5) * cell;
      for (let j = minJ; j <= maxJ; j++) {
        const py = v0 + (j + 0.5) * cell;
        const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area;
        const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 >= 0 && w1 >= 0 && w2 >= 0) mask[i * nv + j] = 1;
      }
    }
  }
  return { mask, nu, nv, u0, v0, cell };
}

/** True when some covered cell centre lies within `d` of (u, v). */
export function covered(s: Silhouette, u: number, v: number, d: number): boolean {
  const ci = Math.floor((u - s.u0) / s.cell);
  const cj = Math.floor((v - s.v0) / s.cell);
  const reach = Math.ceil(d / s.cell) + 1;
  for (let i = Math.max(0, ci - reach); i <= Math.min(s.nu - 1, ci + reach); i++) {
    for (let j = Math.max(0, cj - reach); j <= Math.min(s.nv - 1, cj + reach); j++) {
      if (s.mask[i * s.nv + j] && Math.hypot(u - (s.u0 + (i + 0.5) * s.cell), v - (s.v0 + (j + 0.5) * s.cell)) <= d) return true;
    }
  }
  return false;
}

/** A disc a hit sphere casts in an image plane. */
export interface Disc {
  u: number;
  v: number;
  r: number;
  label: string;
}

/**
 * The discs whose rim is farther than `tolerance` from the silhouette, with the rim point that is (up to 5 per call). The rim
 * is sampled at `samples` angles; points below `vFloor` (under the ground) are not asked about.
 */
export function overhangs(s: Silhouette, discs: readonly Disc[], tolerance: number, samples = 120, vFloor = -Infinity): string[] {
  const out: string[] = [];
  const slack = s.cell * Math.SQRT1_2;
  for (const disc of discs) {
    for (let k = 0; k < samples; k++) {
      const a = (k / samples) * 2 * Math.PI;
      const u = disc.u + Math.cos(a) * disc.r;
      const v = disc.v + Math.sin(a) * disc.r;
      if (v < vFloor) continue;
      if (!covered(s, u, v, tolerance + slack)) out.push(`${disc.label} at (${u.toFixed(3)}, ${v.toFixed(3)})`);
    }
  }
  return out;
}
