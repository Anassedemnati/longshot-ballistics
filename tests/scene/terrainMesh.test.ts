import { describe, expect, it } from 'vitest';
import type { ThemeId } from '../../src/mission/themes';
import { SKY_LOOKS, sunDirectionOf } from '../../src/scene/sky';
import { buildTerrainGeometry, terrainGridAxes } from '../../src/scene/terrain';
import { SECTOR_HALF_ANGLE_RAD, SECTOR_MAX_RANGE, createTerrainField, sectorDistance } from '../../src/scene/terrainField';
import type { TerrainField } from '../../src/scene/terrainField';

const THEME_IDS: ThemeId[] = ['desert', 'arctic', 'valley'];
const DEG = Math.PI / 180;

function lowerIndex(lines: number[], v: number): number {
  let lo = 0;
  let hi = lines.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lines[mid] <= v) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Height of the rendered surface at (x, z): barycentric on the same triangle split the index buffer uses. */
function meshHeight(xs: number[], zs: number[], positions: ArrayLike<number>, x: number, z: number): number {
  const nx = xs.length;
  const i = lowerIndex(xs, x);
  const j = lowerIndex(zs, z);
  const y = (ii: number, jj: number): number => positions[(jj * nx + ii) * 3 + 1];
  const u = (x - xs[i]) / (xs[i + 1] - xs[i]);
  const v = (z - zs[j]) / (zs[j + 1] - zs[j]);
  // Triangles are (a, c, b) and (b, c, d): a = (i, j), b = (i + 1, j), c = (i, j + 1), d = (i + 1, j + 1); the diagonal runs b-c.
  if (u + v <= 1) return y(i, j) + (y(i + 1, j) - y(i, j)) * u + (y(i, j + 1) - y(i, j)) * v;
  return y(i + 1, j + 1) + (y(i, j + 1) - y(i + 1, j + 1)) * (1 - u) + (y(i + 1, j) - y(i + 1, j + 1)) * (1 - v);
}

describe('terrain mesh grid', () => {
  const { xs, zs } = terrainGridAxes();

  it('stays within the vertex budget', { timeout: 30_000 }, () => {
    expect(xs.length * zs.length).toBeLessThanOrEqual(250_000);
    const geometry = buildTerrainGeometry(createTerrainField('valley', 3));
    expect(geometry.getAttribute('position').count).toBe(xs.length * zs.length);
  });

  it('spaces vertices at most 6 m apart across the whole sector and a margin around it', () => {
    const half = SECTOR_MAX_RANGE * Math.sin(SECTOR_HALF_ANGLE_RAD + 3 * DEG);
    for (let k = 0; k + 1 < xs.length; k++) {
      if (xs[k] >= -half && xs[k + 1] <= half) expect(xs[k + 1] - xs[k]).toBeLessThanOrEqual(6);
    }
    for (let k = 0; k + 1 < zs.length; k++) {
      if (zs[k] >= -(SECTOR_MAX_RANGE + 50) && zs[k + 1] <= 120) expect(zs[k + 1] - zs[k]).toBeLessThanOrEqual(6);
    }
    expect(xs[0]).toBeLessThanOrEqual(-2000);
    expect(xs[xs.length - 1]).toBeGreaterThanOrEqual(2000);
    expect(zs[0]).toBeLessThanOrEqual(-3000);
    expect(zs[zs.length - 1]).toBeGreaterThanOrEqual(1000);
  });

  it('spaces vertices at most 3 m apart around the origin (the mountain spur) and at most 25 m apart anywhere', () => {
    for (const lines of [xs, zs]) {
      for (let k = 0; k + 1 < lines.length; k++) {
        const step = lines[k + 1] - lines[k];
        expect(step).toBeLessThanOrEqual(25 + 1e-9);
        if (lines[k] >= -100 && lines[k + 1] <= 100) expect(step).toBeLessThanOrEqual(3 + 1e-9);
      }
    }
  });

  for (const theme of THEME_IDS) {
    it(`${theme}: the mountain spur and the valley walls are rendered, not smoothed away`, { timeout: 30_000 }, () => {
      const field = createTerrainField(theme, 1, 'mountain');
      const positions = buildTerrainGeometry(field).getAttribute('position').array;
      // The spur: crags within a metre of height() on its steep, rough flanks (a 3 m grid on 60 degree slopes).
      let spur = 0;
      for (let r = 7; r < 90; r += 1.3) {
        for (let k = 0; k < 40; k++) {
          const a = (k / 40) * 2 * Math.PI + r;
          const x = r * Math.cos(a);
          const z = r * Math.sin(a);
          spur = Math.max(spur, Math.abs(meshHeight(xs, zs, positions, x, z) - field.height(x, z)));
        }
      }
      expect(spur, `${theme} spur`).toBeLessThanOrEqual(1.2);
      // The walls: on the coarse 25 m grid the surface is within 20 m of height() at worst (strata are the finest feature)
      // and within 1.5 m on average (rms), so the ridgelines are all there.
      let worst = 0;
      let sumSquares = 0;
      let n = 0;
      for (let x = -1990; x < 1990; x += 37) {
        for (let z = -2990; z < 990; z += 41) {
          if (sectorDistance(x, z) < 200) continue;
          const e = Math.abs(meshHeight(xs, zs, positions, x, z) - field.height(x, z));
          worst = Math.max(worst, e);
          sumSquares += e * e;
          n++;
        }
      }
      expect(worst, `${theme} wall worst`).toBeLessThanOrEqual(20);
      expect(Math.sqrt(sumSquares / n), `${theme} wall rms`).toBeLessThanOrEqual(1.5);
    });

    it(`${theme}: the rendered surface agrees with height() within 0.1 m at any target spot`, { timeout: 30_000 }, () => {
      for (const seed of [1, 20261101]) {
        const field: TerrainField = createTerrainField(theme, seed);
        const positions = buildTerrainGeometry(field).getAttribute('position').array;
        let worst = 0;
        for (let bearing = -10; bearing <= 10; bearing += 2.5) {
          for (let range = 100; range <= 1500; range += 37) {
            const x = range * Math.sin(bearing * DEG);
            const z = -range * Math.cos(bearing * DEG);
            worst = Math.max(worst, Math.abs(meshHeight(xs, zs, positions, x, z) - field.height(x, z)));
          }
        }
        expect(worst, `${theme} seed ${seed}`).toBeLessThanOrEqual(0.1);
      }
    });
  }
});

describe('terrain mesh baked lighting', () => {
  const stats = (geometry: ReturnType<typeof buildTerrainGeometry>) => {
    const bake = geometry.getAttribute('bake');
    let sunMin = 1;
    let sunMax = 0;
    let aoMin = 1;
    let aoMax = 0;
    let shaded = 0;
    for (let k = 0; k < bake.count; k++) {
      const sun = bake.getX(k);
      const ao = bake.getY(k);
      sunMin = Math.min(sunMin, sun);
      sunMax = Math.max(sunMax, sun);
      aoMin = Math.min(aoMin, ao);
      aoMax = Math.max(aoMax, ao);
      if (sun < 0.5) shaded++;
    }
    return { bake, sunMin, sunMax, aoMin, aoMax, shadedShare: shaded / bake.count };
  };

  /** The sun of the sky and the shadow light: the bake must be cast for this one. */
  const realSun = (theme: ThemeId) => sunDirectionOf(SKY_LOOKS[theme]);

  for (const theme of THEME_IDS) {
    it(`${theme}: stores sun visibility and ambient occlusion per vertex, in 0..1, for the theme's own sun`, { timeout: 30_000 }, () => {
      const { xs, zs } = terrainGridAxes();
      const geometry = buildTerrainGeometry(createTerrainField(theme, 1), realSun(theme));
      const { bake, sunMin, sunMax, aoMin, aoMax } = stats(geometry);
      expect(bake.itemSize).toBe(2);
      expect(bake.count).toBe(xs.length * zs.length);
      expect(sunMin).toBeGreaterThanOrEqual(0);
      expect(sunMax).toBeLessThanOrEqual(1);
      expect(aoMin).toBeGreaterThanOrEqual(0);
      expect(aoMax).toBeLessThanOrEqual(1);
      // Gullies and wall feet are occluded, open ground and ridges are not.
      expect(aoMin).toBeLessThan(0.75);
      expect(aoMax).toBeGreaterThan(0.99);
    });

    it(`${theme}: the default bake is the sky's sun`, { timeout: 30_000 }, () => {
      const field = createTerrainField(theme, 1);
      const byDefault = buildTerrainGeometry(field).getAttribute('bake');
      const explicit = buildTerrainGeometry(field, realSun(theme)).getAttribute('bake');
      for (let k = 0; k < byDefault.count; k += 313) expect(byDefault.getX(k)).toBe(explicit.getX(k));
    });
  }

  for (const theme of ['desert', 'arctic'] as const) {
    it(`${theme}: a low sun (${SKY_LOOKS[theme].sunElevationDeg} deg) has the walls throw their shade across the floor, and the open ground stays sunlit`, { timeout: 30_000 }, () => {
      const { sunMin, sunMax, shadedShare } = stats(buildTerrainGeometry(createTerrainField(theme, 1), realSun(theme)));
      expect(sunMin).toBeLessThan(0.05);
      expect(sunMax).toBeGreaterThan(0.99);
      expect(shadedShare).toBeGreaterThan(0.02);
      expect(shadedShare).toBeLessThan(0.7);
    });
  }

  it('valley: the 48 degree sun stands above the steepest wall slope, so the walls cast none; the same walls shade the floor under a sun at 24 degrees (the earlier valley sun) or lower', { timeout: 60_000 }, () => {
    const field = createTerrainField('valley', 1);
    const look = SKY_LOOKS.valley;
    expect(look.sunElevationDeg).toBeGreaterThanOrEqual(45); // the picture's sun: if this moves, the expectations below must follow
    const high = stats(buildTerrainGeometry(field, realSun('valley')));
    expect(high.sunMin).toBeGreaterThan(0.95); // lit everywhere: the valley carries the baked occlusion only
    expect(high.aoMin).toBeLessThan(0.75);
    const low = stats(buildTerrainGeometry(field, sunDirectionOf({ ...look, sunElevationDeg: 24 })));
    expect(low.sunMin).toBeLessThan(0.05);
    expect(low.sunMax).toBeGreaterThan(0.99);
    expect(low.shadedShare).toBeGreaterThan(0.02);
    expect(low.shadedShare).toBeLessThan(0.7);
  });

  it('follows the sun it is given: an overhead sun shades nothing, a sun below the horizon everything outside the sector (inside it the shade is softened), and the AO does not depend on it', { timeout: 30_000 }, () => {
    const field = createTerrainField('desert', 1);
    const overhead = stats(buildTerrainGeometry(field, { x: 0, y: 1, z: 0 }));
    const night = stats(buildTerrainGeometry(field, { x: 0.6, y: -0.2, z: 0.77 }));
    expect(overhead.sunMin).toBe(1);
    expect(night.sunMin).toBe(0);
    expect(night.sunMax).toBeLessThan(0.5); // only the sector's floor, which keeps just part of a shadow, is lighter than that
    for (let k = 0; k < overhead.bake.count; k += 997) expect(night.bake.getY(k)).toBe(overhead.bake.getY(k));
  });
});
