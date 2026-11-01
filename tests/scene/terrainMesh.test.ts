import { describe, expect, it } from 'vitest';
import type { ThemeId } from '../../src/mission/themes';
import { buildTerrainGeometry, terrainGridAxes } from '../../src/scene/terrain';
import { SECTOR_HALF_ANGLE_RAD, SECTOR_MAX_RANGE, createTerrainField } from '../../src/scene/terrainField';
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

  it('stays within the vertex budget', () => {
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

  for (const theme of THEME_IDS) {
    it(`${theme}: the rendered surface agrees with height() within 0.1 m at any target spot`, () => {
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
