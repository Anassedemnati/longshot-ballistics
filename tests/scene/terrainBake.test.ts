import { describe, expect, it } from 'vitest';
import {
  ambientOcclusion,
  bakeLighting,
  gridHeight,
  interpolateGrid,
  sampleHeightGrid,
  sunVisibility,
} from '../../src/scene/terrainBake';
import type { SunVector } from '../../src/scene/terrainBake';

const DEG = Math.PI / 180;

/** Unit vector towards a sun `elevation` degrees up, in the direction (`dirX`, `dirZ`) on the ground plane. */
function sunTowards(elevation: number, dirX: number, dirZ: number): SunVector {
  const len = Math.hypot(dirX, dirZ);
  const c = Math.cos(elevation * DEG);
  return { x: (dirX / len) * c, y: Math.sin(elevation * DEG), z: (dirZ / len) * c };
}

const grid = (height: (x: number, z: number) => number, half = 600, step = 8) => sampleHeightGrid(height, -half, half, -half, half, step);

/** A 50 m high wall across x in [0, 20]: flat, open ground on either side. */
const wall = (x: number): number => (x >= 0 && x <= 20 ? 50 : 0);

describe('sampleHeightGrid / interpolateGrid / gridHeight', () => {
  it('samples the function at the nodes and records the highest', () => {
    const g = sampleHeightGrid((x, z) => x * 0.5 + z, 0, 40, 0, 20, 10);
    expect([g.nx, g.nz]).toEqual([5, 3]);
    expect(g.heights[0]).toBe(0);
    expect(g.heights[1 * g.nx + 2]).toBeCloseTo(20 * 0.5 + 10, 5);
    expect(g.maxHeight).toBeCloseTo(40 * 0.5 + 20, 5);
  });

  it('is bilinear: exact for a plane, clamped outside the grid', () => {
    const g = sampleHeightGrid((x, z) => 3 + 0.25 * x - 0.5 * z, -100, 100, -100, 100, 10);
    for (const [x, z] of [
      [0, 0],
      [13.7, -42.2],
      [-99, 77],
    ]) {
      expect(gridHeight(g, x, z)).toBeCloseTo(3 + 0.25 * x - 0.5 * z, 4);
    }
    expect(gridHeight(g, 500, 0)).toBeCloseTo(gridHeight(g, 100, 0), 9);
    expect(gridHeight(g, 0, -500)).toBeCloseTo(gridHeight(g, 0, -100), 9);
    expect(interpolateGrid(g, g.heights, 5, 5)).toBe(gridHeight(g, 5, 5));
  });
});

describe('sunVisibility', () => {
  const g = grid(wall);
  const sun = sunTowards(30, 1, 0); // the sun in +X, 30 degrees up

  it('is 0 in the shadow behind a wall (the wall is between the point and the sun)', () => {
    // 50 m of wall at 30 degrees shades about 87 m of ground on the far side: x in [-87, 0].
    for (const x of [-4, -30, -60]) expect(sunVisibility(g, x, 0, sun), `x=${x}`).toBeLessThan(0.05);
  });

  it('is 1 in the open: on flat ground, beyond the end of the shadow, and on the sunny side of the wall', () => {
    for (const x of [-250, -120, 40, 100, 400]) expect(sunVisibility(g, x, 0, sun), `x=${x}`).toBeGreaterThan(0.99);
    expect(sunVisibility(grid(() => 0), 0, 0, sun)).toBe(1);
  });

  it('grades through a penumbra at the end of the shadow of a smooth ridge', () => {
    const hill = grid((x) => 60 * Math.exp(-((x / 40) ** 2)));
    let previous = 2;
    let partial = 0;
    let dark = 0;
    let lit = 0;
    for (let x = -200; x <= -50; x += 2) {
      const v = sunVisibility(hill, x, 0, sun);
      expect(v).toBeLessThanOrEqual(previous + 1e-9); // never lighter as the point moves towards the ridge
      if (v > 0.02 && v < 0.98) partial++;
      if (v <= 0.02) dark++;
      if (v >= 0.98) lit++;
      previous = v;
    }
    expect(partial).toBeGreaterThanOrEqual(3);
    expect(dark).toBeGreaterThan(5);
    expect(lit).toBeGreaterThan(5);
  });

  it('follows the sun: a sun in -X shades the other side of the wall, a sun straight overhead shades nothing, a sun below the horizon everything', () => {
    const west = sunTowards(30, -1, 0);
    expect(sunVisibility(g, 40, 0, west)).toBeLessThan(0.05);
    expect(sunVisibility(g, -40, 0, west)).toBeGreaterThan(0.99);
    expect(sunVisibility(g, -20, 0, { x: 0, y: 1, z: 0 })).toBe(1);
    expect(sunVisibility(g, 300, 0, { x: 0.5, y: -0.1, z: 0.5 })).toBe(0);
  });

  it('a low sun shades further than a high one', () => {
    const at = (elevation: number): number => sunVisibility(g, -120, 0, sunTowards(elevation, 1, 0));
    expect(at(20)).toBeLessThan(0.05);
    expect(at(55)).toBeGreaterThan(0.99);
  });

  it('does not shade a slope facing the sun by its own ground, and shades one facing away from it', () => {
    const slope = grid((x) => 0.2 * x); // 11 degrees, rising towards +X
    expect(sunVisibility(slope, 0, 0, sunTowards(30, 1, 0))).toBeGreaterThan(0.99);
    expect(sunVisibility(slope, 0, 0, sunTowards(10, 1, 0))).toBeLessThan(0.05); // the sun is below the slope's own horizon
    expect(sunVisibility(slope, 0, 0, sunTowards(30, -1, 0))).toBeGreaterThan(0.99);
  });

  it('works at the edge of the grid (rays that leave the map are not blocked)', () => {
    expect(sunVisibility(g, 596, 0, sun)).toBeGreaterThan(0.99);
    expect(sunVisibility(g, -600, -600, sun)).toBeGreaterThan(0.99);
  });
});

describe('ambientOcclusion', () => {
  // A gully along z: a parabola 20 m wide across x. A ridge along z: its mirror image.
  const gully = grid((x) => 0.05 * x * x, 300, 4);
  const ridge = grid((x) => -0.05 * x * x, 300, 4);

  it('is lower in a gully than on a ridge', () => {
    const inGully = ambientOcclusion(gully, 0, 0);
    const onRidge = ambientOcclusion(ridge, 0, 0);
    expect(inGully).toBeLessThan(onRidge - 0.1);
    expect(inGully).toBeLessThan(0.9);
    expect(onRidge).toBeGreaterThan(0.99);
  });

  it('is 1 on flat ground and on an even slope', () => {
    expect(ambientOcclusion(grid(() => 5), 10, 10)).toBeCloseTo(1, 9);
    expect(ambientOcclusion(grid((x, z) => 0.3 * x - 0.1 * z), 10, 10)).toBeGreaterThan(0.97);
  });

  it('is low at the foot of a high wall, and higher with distance from it', () => {
    const w = grid((x) => (x > 0 ? 200 : 0), 600, 8);
    const near = ambientOcclusion(w, -10, 0);
    const far = ambientOcclusion(w, -190, 0);
    expect(near).toBeLessThan(far);
    expect(near).toBeLessThan(0.9);
  });

  it('stays within 0..1', () => {
    const rough = grid((x, z) => 30 * Math.sin(x * 0.05) * Math.cos(z * 0.04), 300, 6);
    for (let x = -280; x <= 280; x += 40) {
      for (let z = -280; z <= 280; z += 40) {
        const v = ambientOcclusion(rough, x, z);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('bakeLighting', () => {
  it('bakes sun and occlusion per grid node, deterministically, within 0..1', () => {
    const g = grid(wall, 300, 10);
    const sun = sunTowards(30, 1, 0);
    const a = bakeLighting(g, sun);
    const b = bakeLighting(g, sun);
    expect(a.sun.length).toBe(g.nx * g.nz);
    expect(a.ao.length).toBe(g.nx * g.nz);
    expect(Array.from(a.sun)).toEqual(Array.from(b.sun));
    expect(Array.from(a.ao)).toEqual(Array.from(b.ao));
    for (let k = 0; k < a.sun.length; k++) {
      expect(a.sun[k]).toBeGreaterThanOrEqual(0);
      expect(a.sun[k]).toBeLessThanOrEqual(1);
      expect(a.ao[k]).toBeGreaterThanOrEqual(0);
      expect(a.ao[k]).toBeLessThanOrEqual(1);
    }
    // Node (i, j) = (-30 / 10 + 30, 30): x = -30, z = 0 is behind the wall, x = 100 in the open.
    const at = (x: number): number => 30 * g.nx + Math.round((x + 300) / 10);
    expect(a.sun[at(-30)]).toBeLessThan(0.05);
    expect(a.sun[at(100)]).toBeGreaterThan(0.99);
    expect(a.sun[at(-30)]).toBeCloseTo(sunVisibility(g, -30, 0, sun), 5);
    expect(a.ao[at(-30)]).toBeCloseTo(ambientOcclusion(g, -30, 0), 5);
  });
});
