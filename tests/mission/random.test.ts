import { describe, expect, it } from 'vitest';
import { createRng, randInt } from '../../src/mission/random';

/** Canonical mulberry32, written independently of the implementation under test. */
function referenceMulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('createRng', () => {
  it('is deterministic for a seed', () => {
    const a = createRng(1);
    const b = createRng(1);
    for (let i = 0; i < 100; i++) expect(a()).toBe(b());
  });

  it('matches the canonical mulberry32 sequence', () => {
    for (const seed of [1, 42, 0xdeadbeef]) {
      const ours = createRng(seed);
      const ref = referenceMulberry32(seed);
      for (let i = 0; i < 100; i++) expect(ours()).toBe(ref());
    }
  });

  it('stays in [0, 1)', () => {
    const rng = createRng(7);
    for (let i = 0; i < 5000; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('gives different sequences for different seeds', () => {
    const a = createRng(1);
    const b = createRng(2);
    const first = [a(), a(), a()];
    const second = [b(), b(), b()];
    expect(first).not.toEqual(second);
  });
});

describe('randInt', () => {
  it('returns integers within the inclusive bounds and reaches both ends', () => {
    const rng = createRng(3);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const v = randInt(rng, 1, 6);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(6);
      seen.add(v);
    }
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('returns the only value when min = max', () => {
    expect(randInt(createRng(9), 5, 5)).toBe(5);
  });
});
