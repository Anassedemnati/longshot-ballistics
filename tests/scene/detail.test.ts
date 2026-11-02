import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MISSION, clampMission } from '../../src/mission/config';
import { MAX_PEBBLES, MAX_TUFTS } from '../../src/mission/groundDetail';
import { generateLayout } from '../../src/mission/layout';
import type { ThemeId } from '../../src/mission/themes';
import { createGroundDetail, grassTuftPixels, groundRelief, periodicNoise, reliefHeights } from '../../src/scene/detail';
import { createTerrainField } from '../../src/scene/terrainField';

const THEMES: ThemeId[] = ['desert', 'arctic', 'valley'];

describe('reliefHeights / groundRelief', () => {
  it('periodic noise tiles: the same value one period over', () => {
    for (const [x, y] of [[0.3, 0.7], [1.9, 3.2], [-0.4, 2.5]]) {
      expect(periodicNoise(x + 4, y, 4, 6, 9)).toBeCloseTo(periodicNoise(x, y, 4, 6, 9), 9);
      expect(periodicNoise(x, y + 6, 4, 6, 9)).toBeCloseTo(periodicNoise(x, y, 4, 6, 9), 9);
      const n = periodicNoise(x, y, 4, 6, 9);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(1);
    }
  });

  it('each theme has its own deterministic, varied height texture', () => {
    const maps = THEMES.map((t) => reliefHeights(t, 64));
    for (const m of maps) {
      expect(m).toHaveLength(64 * 64);
      const mean = m.reduce((s, v) => s + v, 0) / m.length;
      const sd = Math.sqrt(m.reduce((s, v) => s + (v - mean) ** 2, 0) / m.length);
      expect(mean).toBeGreaterThan(100);
      expect(mean).toBeLessThan(156);
      expect(sd).toBeGreaterThan(12); // visible relief
      expect(sd).toBeLessThan(80); // but not clipped noise
    }
    expect(reliefHeights('desert', 64)).toEqual(maps[0]); // deterministic
    expect(maps[0]).not.toEqual(maps[1]);
    expect(maps[1]).not.toEqual(maps[2]);
  });

  it('groundRelief is a repeating linear-data texture', () => {
    for (const theme of THEMES) {
      const t = groundRelief(theme);
      expect(t.wrapS).toBe(THREE.RepeatWrapping);
      expect(t.wrapT).toBe(THREE.RepeatWrapping);
      expect(t.colorSpace).toBe(THREE.NoColorSpace);
      expect(t.image.width).toBe(256);
    }
  });
});

describe('grassTuftPixels', () => {
  it('has blades (opaque) and gaps (transparent), most of it empty, rooted at the bottom', () => {
    const size = 64;
    const px = grassTuftPixels(size);
    expect(px).toHaveLength(size * size * 4);
    let opaque = 0;
    let rootOpaque = 0;
    let topOpaque = 0;
    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        const a = px[(row * size + col) * 4 + 3];
        expect(a === 0 || a === 255).toBe(true);
        if (a === 255) {
          opaque++;
          if (row < 4) rootOpaque++; // row 0 is the ground
          if (row >= size - 4) topOpaque++;
        }
      }
    }
    expect(opaque / (size * size)).toBeGreaterThan(0.08);
    expect(opaque / (size * size)).toBeLessThan(0.5);
    expect(rootOpaque).toBeGreaterThan(topOpaque);
  });
});

describe('createGroundDetail scale', () => {
  it('draws a prefix share of the plan (an even thinning), all of it by default', () => {
    const config = clampMission({ ...DEFAULT_MISSION, theme: 'valley', seed: 3 });
    const field = createTerrainField('valley', 3);
    const layout = generateLayout(config, field);
    const full = createGroundDetail(field, layout, 3).plan;
    const half = createGroundDetail(field, layout, 3, 8, [], 0.5);
    expect(half.plan.pebbles).toEqual(full.pebbles.slice(0, Math.ceil(full.pebbles.length * 0.5)));
    expect(half.plan.tufts.length).toBe(Math.ceil(full.tufts.length * 0.5));
    expect((half.group.children[0] as THREE.InstancedMesh).count).toBe(half.plan.pebbles.length);
  });
});

describe('createGroundDetail', () => {
  for (const theme of THEMES) {
    it(`${theme}: one instanced mesh of pebbles${theme === 'valley' ? ' and one of grass tufts' : ''}, within the caps`, () => {
      const config = clampMission({ ...DEFAULT_MISSION, theme, seed: 3 });
      const field = createTerrainField(theme, 3);
      const layout = generateLayout(config, field);
      const { group, plan } = createGroundDetail(field, layout, 3);
      const meshes = group.children as THREE.InstancedMesh[];
      expect(meshes).toHaveLength(theme === 'valley' ? 2 : 1);
      const pebbles = meshes[0];
      expect(pebbles.isInstancedMesh).toBe(true);
      expect(pebbles.count).toBe(plan.pebbles.length);
      expect(pebbles.count).toBeLessThanOrEqual(MAX_PEBBLES);
      expect(pebbles.receiveShadow).toBe(true);
      if (theme === 'valley') {
        expect(meshes[1].count).toBe(plan.tufts.length);
        expect(meshes[1].count).toBeLessThanOrEqual(MAX_TUFTS);
        expect((meshes[1].material as THREE.MeshStandardMaterial).alphaTest).toBeGreaterThan(0);
      }
      // visual only: nothing in the group is a collider or a hit target
      expect(Object.keys(group.userData)).toHaveLength(0);
    });
  }
});
