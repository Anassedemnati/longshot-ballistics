import { describe, expect, it } from 'vitest';
import { segmentSphere } from '../../src/game/hit';

const CENTER = { x: 0, y: 0, z: -10 };

describe('segmentSphere', () => {
  it('returns the entry parameter for a segment passing through the sphere', () => {
    // Straight down -Z from the origin to z = -20; sphere radius 1 at z = -10 -> entry at z = -9 (u = 0.45).
    const u = segmentSphere({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -20 }, CENTER, 1);
    expect(u).not.toBeNull();
    expect(u as number).toBeCloseTo(0.45, 12);
  });

  it('returns the first contact for an off-axis chord', () => {
    // Chord at y = 0.6 of a unit sphere: half-width sqrt(1 - 0.36) = 0.8 -> entry at z = -9.2 (u = 0.46).
    const u = segmentSphere({ x: 0, y: 0.6, z: 0 }, { x: 0, y: 0.6, z: -20 }, CENTER, 1);
    expect(u as number).toBeCloseTo(0.46, 12);
  });

  it('returns null for a segment that misses the sphere', () => {
    expect(segmentSphere({ x: 2, y: 0, z: 0 }, { x: 2, y: 0, z: -20 }, CENTER, 1)).toBeNull();
  });

  it('returns null when the segment stops short of the sphere', () => {
    expect(segmentSphere({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -5 }, CENTER, 1)).toBeNull();
  });

  it('returns null when the sphere is behind the segment', () => {
    expect(segmentSphere({ x: 0, y: 0, z: -20 }, { x: 0, y: 0, z: -30 }, CENTER, 1)).toBeNull();
  });

  it('returns 0 when the segment starts inside the sphere', () => {
    expect(segmentSphere({ x: 0, y: 0, z: -10.5 }, { x: 0, y: 0, z: -30 }, CENTER, 1)).toBe(0);
  });

  it('returns null for a zero-length segment outside the sphere', () => {
    const p = { x: 0, y: 0, z: 0 };
    expect(segmentSphere(p, p, CENTER, 1)).toBeNull();
  });
});
