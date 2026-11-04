import { describe, expect, it } from 'vitest';
import { boxExitDistance, segmentBox, segmentSphere } from '../../src/game/hit';

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

describe('boxExitDistance', () => {
  const box = { center: { x: 0, y: 0, z: -10 }, halfSize: { x: 1, y: 1, z: 2 }, yaw: 0 };
  it('is the distance to the far face along the ray, from outside or inside', () => {
    expect(boxExitDistance(box, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 })).toBeCloseTo(12, 9);
    expect(boxExitDistance(box, { x: 0, y: 0, z: -10 }, { x: 0, y: 0, z: -1 })).toBeCloseTo(2, 9);
    expect(boxExitDistance(box, { x: 0, y: 0, z: -10 }, { x: 1, y: 0, z: 0 })).toBeCloseTo(1, 9);
  });

  it('is 0 for a ray that misses or points away', () => {
    expect(boxExitDistance(box, { x: 5, y: 0, z: 0 }, { x: 0, y: 0, z: -1 })).toBe(0);
    expect(boxExitDistance(box, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 })).toBe(0);
  });

  it('agrees with segmentBox on a turned box: the exit point lies on its surface', () => {
    const turned = { ...box, yaw: 0.7 };
    const from = { x: 0.3, y: 0.2, z: 0 };
    const dir = { x: 0.02, y: 0, z: -1 };
    const n = Math.hypot(dir.x, dir.z);
    const unit = { x: dir.x / n, y: 0, z: dir.z / n };
    const t = boxExitDistance(turned, from, unit);
    const at = (d: number) => ({ x: from.x + unit.x * d, y: from.y, z: from.z + unit.z * d });
    expect(segmentBox(at(t - 0.01), at(t - 0.005), turned)).toBe(0); // just inside
    expect(segmentBox(at(t + 0.005), at(t + 0.01), turned)).toBeNull(); // just past
  });
});
