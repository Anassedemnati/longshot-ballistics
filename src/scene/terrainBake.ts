// Pure baked lighting of a height field (no three.js, no randomness): soft sun shadowing and a cheap
// horizon-based ambient occlusion, computed once at build time on a coarse regular grid and then
// interpolated onto the render mesh (terrain.ts stores the result in a vertex attribute the terrain
// shader multiplies into the direct and the indirect light). Never calls the original height function
// while marching: the field is sampled once into a `HeightGrid`, and every ray works on that.

export interface SunVector {
  /** Unit vector from the scene towards the sun (+Y up). */
  x: number;
  y: number;
  z: number;
}

/** Heights on a regular grid: node (i, j) sits at (x0 + i * dx, z0 + j * dz) and holds `heights[j * nx + i]`. */
export interface HeightGrid {
  heights: Float32Array;
  nx: number;
  nz: number;
  x0: number;
  z0: number;
  dx: number;
  dz: number;
  /** Highest node, m: a ray above it can no longer be blocked. */
  maxHeight: number;
}

/** Sample `height` on a regular grid covering [x0, x1] x [z0, z1] with nodes `step` m apart (the last row and column reach or pass the far edge). */
export function sampleHeightGrid(
  height: (x: number, z: number) => number,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  step: number,
): HeightGrid {
  const nx = Math.ceil((x1 - x0) / step) + 1;
  const nz = Math.ceil((z1 - z0) / step) + 1;
  const heights = new Float32Array(nx * nz);
  let maxHeight = -Infinity;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const h = height(x0 + i * step, z0 + j * step);
      heights[j * nx + i] = h;
      if (h > maxHeight) maxHeight = h;
    }
  }
  return { heights, nx, nz, x0, z0, dx: step, dz: step, maxHeight };
}

/** Bilinear value of node-parallel `values` (laid out like `grid.heights`) at (x, z); positions outside the grid clamp to its edge. */
export function interpolateGrid(grid: HeightGrid, values: ArrayLike<number>, x: number, z: number): number {
  const fx = Math.min(grid.nx - 1, Math.max(0, (x - grid.x0) / grid.dx));
  const fz = Math.min(grid.nz - 1, Math.max(0, (z - grid.z0) / grid.dz));
  const i = Math.min(grid.nx - 2, Math.floor(fx));
  const j = Math.min(grid.nz - 2, Math.floor(fz));
  const u = fx - i;
  const v = fz - j;
  const k = j * grid.nx + i;
  const a = values[k];
  const b = values[k + 1];
  const c = values[k + grid.nx];
  const d = values[k + grid.nx + 1];
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Terrain height of the grid at (x, z), m (bilinear, clamped at the edges). */
export function gridHeight(grid: HeightGrid, x: number, z: number): number {
  return interpolateGrid(grid, grid.heights, x, z);
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export interface SunOptions {
  /**
   * Penumbra sharpness: a ray that clears the terrain by less than 1 / softness (radians of elevation, about) is partly
   * shadowed. 32 is about 1.8 degrees: soft enough that the coarse grid shows no blocky edges, sharp enough to read as a shadow.
   */
  softness?: number;
}

/**
 * Share of the sun visible from the ground at (x, z): 1 in the open, 0 in the full shadow of the terrain towards the sun,
 * in between across a soft penumbra. Marches over `grid` towards the sun with steps that grow with distance.
 */
export function sunVisibility(grid: HeightGrid, x: number, z: number, sun: SunVector, options: SunOptions = {}): number {
  if (sun.y <= 0) return 0;
  const horizontal = Math.hypot(sun.x, sun.z);
  if (horizontal < 1e-9) return 1; // the sun straight overhead: nothing shades anything
  const softness = options.softness ?? 32;
  const dirX = sun.x / horizontal;
  const dirZ = sun.z / horizontal;
  const rise = sun.y / horizontal; // metres of height gained per metre travelled
  const h0 = gridHeight(grid, x, z);
  const xMax = grid.x0 + (grid.nx - 1) * grid.dx;
  const zMax = grid.z0 + (grid.nz - 1) * grid.dz;
  const minStep = Math.min(grid.dx, grid.dz) * 0.75;
  let visibility = 1;
  // The first sample sits one step out, so a slope never shades itself through its own bilinear patch.
  for (let s = minStep; ; s += Math.max(minStep, s * 0.06)) {
    const px = x + dirX * s;
    const pz = z + dirZ * s;
    if (px < grid.x0 || px > xMax || pz < grid.z0 || pz > zMax) break;
    const rayY = h0 + s * rise;
    if (rayY > grid.maxHeight) break;
    visibility = Math.min(visibility, clamp01((softness * (rayY - gridHeight(grid, px, pz))) / s));
    if (visibility <= 0) return 0;
  }
  return visibility;
}

export interface OcclusionOptions {
  /** How far the horizon is searched, m. */
  radius?: number;
  /** Directions around the point (evenly spaced). */
  directions?: number;
  /** Scales the mean occlusion before it is subtracted from 1. */
  strength?: number;
}

/**
 * Ambient light reaching (x, z) from the open sky, 1 (a ridge, open flat or evenly sloping ground) down towards 0 (a deep
 * gully, the foot of a high wall). Horizon-based: in each direction, how far the highest terrain within `radius` rises above
 * the ground's own tangent plane; convex ground (a ridge) never rises above it, so it is never occluded.
 */
export function ambientOcclusion(grid: HeightGrid, x: number, z: number, options: OcclusionOptions = {}): number {
  const radius = options.radius ?? 200;
  const directions = options.directions ?? 8;
  const strength = options.strength ?? 1.6;
  const h0 = gridHeight(grid, x, z);
  const gx = (gridHeight(grid, x + grid.dx, z) - gridHeight(grid, x - grid.dx, z)) / (2 * grid.dx);
  const gz = (gridHeight(grid, x, z + grid.dz) - gridHeight(grid, x, z - grid.dz)) / (2 * grid.dz);
  const step0 = Math.min(grid.dx, grid.dz);
  let occlusion = 0;
  for (let k = 0; k < directions; k++) {
    const angle = ((k + 0.5) / directions) * 2 * Math.PI;
    const dirX = Math.cos(angle);
    const dirZ = Math.sin(angle);
    const tangent = gx * dirX + gz * dirZ; // slope of the ground itself in this direction
    let horizon = tangent;
    for (let s = step0; s <= radius; s *= 1.6) {
      const tan = (gridHeight(grid, x + dirX * s, z + dirZ * s) - h0) / s;
      if (tan > horizon) horizon = tan;
    }
    // sin of the angle for a rise per metre `t` is t / sqrt(1 + t^2).
    occlusion += Math.max(0, horizon / Math.sqrt(1 + horizon * horizon) - tangent / Math.sqrt(1 + tangent * tangent));
  }
  return clamp01(1 - (occlusion / directions) * strength);
}

export interface LightBake {
  /** Sun visibility per grid node (0 shadow .. 1 open), laid out like the grid's heights. */
  sun: Float32Array;
  /** Ambient occlusion per grid node (0 occluded .. 1 open sky). */
  ao: Float32Array;
}

/** Sun visibility and ambient occlusion at every node of `grid`. */
export function bakeLighting(grid: HeightGrid, sun: SunVector, sunOptions: SunOptions = {}, aoOptions: OcclusionOptions = {}): LightBake {
  const count = grid.nx * grid.nz;
  const sunValues = new Float32Array(count);
  const aoValues = new Float32Array(count);
  for (let j = 0; j < grid.nz; j++) {
    for (let i = 0; i < grid.nx; i++) {
      const x = grid.x0 + i * grid.dx;
      const z = grid.z0 + j * grid.dz;
      sunValues[j * grid.nx + i] = sunVisibility(grid, x, z, sun, sunOptions);
      aoValues[j * grid.nx + i] = ambientOcclusion(grid, x, z, aoOptions);
    }
  }
  return { sun: sunValues, ao: aoValues };
}
