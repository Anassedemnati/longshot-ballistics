import { describe, expect, it } from 'vitest';
import { sectorDistance } from '../../src/scene/terrainField';
import { ROCK_OUTCROPS, SHOOTER_POS, terrainHeight } from '../../src/scene/terrainHeight';
import * as terrainModule from '../../src/scene/terrain';

describe('terrainHeight', () => {
  it('is deterministic: the same input gives the same output', () => {
    for (const [x, z] of [
      [0, 0],
      [123.4, -567.8],
      [-1500, -2900],
      [37.25, 410],
    ]) {
      expect(terrainHeight(x, z)).toBe(terrainHeight(x, z));
    }
    // Seeded and pure: a fresh evaluation order does not change values.
    const a = terrainHeight(250, -900);
    terrainHeight(-40, -10);
    expect(terrainHeight(250, -900)).toBe(a);
  });

  it('is finite everywhere on the 4 km x 4 km map', () => {
    for (let x = -2000; x <= 2000; x += 250) {
      for (let z = -3000; z <= 1000; z += 250) {
        expect(Number.isFinite(terrainHeight(x, z))).toBe(true);
      }
    }
  });

  it('has a ~12 m rise around the shooter and the dunes starting to build beside the sector, before the walls start', () => {
    expect(terrainHeight(0, 0)).toBeGreaterThan(11);
    expect(terrainHeight(0, 0)).toBeLessThan(13);
    // The dunes fade in over 140 m beyond the sector edge and the valley walls start 60 m outside it: here they are
    // still low (a third of their full 3-6 m) but already varying.
    let min = Infinity;
    let max = -Infinity;
    for (let x = -1800; x <= 1800; x += 40) {
      for (let z = -2800; z <= 800; z += 40) {
        if (Math.abs(x) < 60 || sectorDistance(x, z) > 60 || Math.hypot(x, z) < 100) continue;
        const h = terrainHeight(x, z);
        min = Math.min(min, h);
        max = Math.max(max, h);
      }
    }
    expect(max - min).toBeGreaterThan(1);
    expect(max - min).toBeLessThan(14); // dunes + rock outcrops
  });

  it('is walled in: 55-250 m ridgelines rise on both sides, behind the shooter and beyond the far end', () => {
    for (const [x, z] of [
      [-1500, -800],
      [1500, -800],
      [-1000, 400],
      [0, -2900],
    ]) {
      expect(terrainHeight(x, z), `(${x}, ${z})`).toBeGreaterThan(50);
    }
    let max = 0;
    for (let x = -1950; x <= 1950; x += 50) for (let z = -2950; z <= 950; z += 50) max = Math.max(max, terrainHeight(x, z));
    expect(max).toBeGreaterThan(150);
    expect(max).toBeLessThan(275);
  });

  it('puts the prone eye 0.4 m above the top of the rise, on the lane axis', () => {
    expect(SHOOTER_POS.x).toBe(0);
    expect(SHOOTER_POS.z).toBe(0);
    expect(SHOOTER_POS.y).toBeCloseTo(terrainHeight(0, 0) + 0.4, 9);
    // It really is the top: the ground falls away in every direction.
    for (const [x, z] of [
      [3, 0],
      [-3, 0],
      [0, 3],
      [0, -3],
    ]) {
      expect(terrainHeight(x, z)).toBeLessThan(terrainHeight(0, 0) + 0.05);
    }
  });

  it('keeps rock outcrops off the range lane', () => {
    expect(ROCK_OUTCROPS.length).toBeGreaterThanOrEqual(3);
    for (const rock of ROCK_OUTCROPS) expect(Math.abs(rock.x)).toBeGreaterThan(rock.radius + 20);
  });

  it('line of sight from the shooter to the target chest is clear for every range 100-1500', () => {
    const ranges: number[] = [];
    for (let r = 100; r <= 1500; r += 100) ranges.push(r);
    // Off-grid ranges matter too: the player can type any range in the URL.
    ranges.push(137, 333, 777, 1111, 1499);

    for (const r of ranges) {
      const end = { x: 0, y: terrainHeight(0, -r) + 1.35, z: -r };
      const samples = 200;
      const total = Math.hypot(end.x - SHOOTER_POS.x, end.y - SHOOTER_POS.y, end.z - SHOOTER_POS.z);
      for (let i = 1; i <= samples; i++) {
        const u = i / samples;
        if ((1 - u) * total <= 2) continue; // the last 2 m are the target's own patch of ground
        const x = SHOOTER_POS.x + (end.x - SHOOTER_POS.x) * u;
        const y = SHOOTER_POS.y + (end.y - SHOOTER_POS.y) * u;
        const z = SHOOTER_POS.z + (end.z - SHOOTER_POS.z) * u;
        const ground = terrainHeight(x, z);
        // 15 cm of clearance: the bullet leaves 4 cm below the sight line.
        expect(ground, `range ${r} m, sample ${i}: ground ${ground} vs line ${y}`).toBeLessThan(y - 0.15);
      }
    }
  });

  it('is nearly flat along the lane so the target stands on level ground', () => {
    for (let z = -1550; z <= -100; z += 25) {
      expect(Math.abs(terrainHeight(0, z))).toBeLessThan(0.5);
      expect(Math.abs(terrainHeight(0, z) - terrainHeight(1, z - 1))).toBeLessThan(0.05);
    }
  });
});

describe('terrain module', () => {
  it('re-exports the pure terrain functions used by the bullets', () => {
    expect(terrainModule.terrainHeight).toBe(terrainHeight);
    expect(terrainModule.SHOOTER_POS).toBe(SHOOTER_POS);
    expect(typeof terrainModule.createTerrainMesh).toBe('function');
  });
});
