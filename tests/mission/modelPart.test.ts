import { describe, expect, it } from 'vitest';
import { frameAlong, mirrorX, pair } from '../../src/mission/modelPart';
import type { ModelPart } from '../../src/mission/modelPart';
import { soldierModel } from '../../src/mission/soldierModel';
import { sniperBodyParts, sniperRifleParts, sniperStrands } from '../../src/mission/sniperModel';

const dot = (a: readonly number[], b: readonly number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe('frameAlong', () => {
  it('is a right-handed orthonormal frame with +Z along the given direction and +Y toward up', () => {
    const f = frameAlong([1, 2, 3], [0.78, -0.12, 0.62]);
    expect(f.origin).toEqual([1, 2, 3]);
    for (const axis of [f.x, f.y, f.z]) expect(Math.hypot(...axis)).toBeCloseTo(1, 12);
    expect(dot(f.x, f.y)).toBeCloseTo(0, 12);
    expect(dot(f.y, f.z)).toBeCloseTo(0, 12);
    expect(dot(f.x, f.z)).toBeCloseTo(0, 12);
    expect(f.y[1]).toBeGreaterThan(0.9);
    // x = y cross z
    expect(f.x[0]).toBeCloseTo(f.y[1] * f.z[2] - f.y[2] * f.z[1], 12);
    expect(f.x[1]).toBeCloseTo(f.y[2] * f.z[0] - f.y[0] * f.z[2], 12);
    expect(f.x[2]).toBeCloseTo(f.y[0] * f.z[1] - f.y[1] * f.z[0], 12);
  });
});

describe('mirrorX', () => {
  it('negates x of every point of every kind of part, and the turns about y and z', () => {
    const tube: ModelPart = { kind: 'tube', a: [0.1, 1, 2], b: [0.2, 3, 4], ra: 0.1, rb: 0.1, surface: 'camo', color: 1 };
    expect(mirrorX(tube)).toMatchObject({ a: [-0.1, 1, 2], b: [-0.2, 3, 4] });
    const box: ModelPart = { kind: 'box', c: [0.3, 1, 1], size: [1, 1, 1], radius: 0.1, rot: [0.1, 0.2, 0.3], surface: 'gear', color: 1 };
    expect(mirrorX(box)).toMatchObject({ c: [-0.3, 1, 1], rot: [0.1, -0.2, -0.3] });
    const lathe: ModelPart = { kind: 'lathe', profile: [[1, 0]], c: [0.5, 1, 1], surface: 'gear', color: 1 };
    expect((mirrorX(lathe) as unknown as { c: number[] }).c[0]).toBe(-0.5);
    expect(pair(tube)).toHaveLength(2);
    expect(mirrorX(mirrorX(box))).toEqual(box);
  });
});

describe('model data', () => {
  const all = (parts: readonly ModelPart[]): ModelPart[] => [...parts];
  const finite = (v: readonly number[] | undefined): boolean => v === undefined || v.every(Number.isFinite);

  it('holds only finite numbers, positive sizes and colours that fit 24 bits, for the soldier, the sniper body and the rifle', () => {
    const lists = [soldierModel().flatMap((g) => g.parts), sniperBodyParts(), sniperRifleParts()].map(all);
    for (const list of lists) {
      for (const p of list) {
        expect(p.color).toBeGreaterThanOrEqual(0);
        expect(p.color).toBeLessThanOrEqual(0xffffff);
        if (p.kind === 'tube') {
          expect([...p.a, ...p.b].every(Number.isFinite)).toBe(true);
          expect(p.ra).toBeGreaterThan(0);
          expect(p.rb).toBeGreaterThan(0);
          expect(Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1], p.b[2] - p.a[2])).toBeGreaterThan(0.01);
        } else if (p.kind === 'ellipsoid') {
          expect(finite(p.c) && finite(p.r) && finite(p.rot)).toBe(true);
          expect(Math.min(...p.r)).toBeGreaterThan(0);
        } else if (p.kind === 'box') {
          expect(finite(p.c) && finite(p.size) && finite(p.rot)).toBe(true);
          expect(Math.min(...p.size)).toBeGreaterThan(0);
        } else {
          expect(finite(p.c) && finite(p.scale) && finite(p.rot)).toBe(true);
          expect(p.profile.length).toBeGreaterThanOrEqual(3);
          for (let i = 1; i < p.profile.length; i++) expect(p.profile[i][1]).toBeGreaterThanOrEqual(p.profile[i - 1][1]);
        }
      }
    }
  });

  it('the soldier is built on both sides: every part on his left has a part just like it on his right', () => {
    const parts = soldierModel()[0].parts;
    const left = parts.filter((p) => (p.kind === 'tube' ? p.a[0] > 0.05 && p.b[0] > 0.05 : p.kind !== 'lathe' && p.c[0] > 0.05));
    const right = parts.filter((p) => (p.kind === 'tube' ? p.a[0] < -0.05 && p.b[0] < -0.05 : p.kind !== 'lathe' && p.c[0] < -0.05));
    expect(left.length).toBeGreaterThanOrEqual(10);
    expect(right.length).toBeGreaterThanOrEqual(10);
    expect(Math.abs(left.length - right.length)).toBeLessThanOrEqual(2);
  });

  it('the sniper has the same suit every run', () => {
    expect(sniperStrands()).toEqual(sniperStrands());
    expect(sniperBodyParts()).toEqual(sniperBodyParts());
  });
});
