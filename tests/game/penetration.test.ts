import { describe, expect, it } from 'vitest';
import { KEEP_MAX, KEEP_MIN, continuedVelocity, exitPoint } from '../../src/game/penetration';
import type { HitZone } from '../../src/game/hit';
import { createRng } from '../../src/mission/random';

const ball = (x: number, y: number, z: number, radius: number): HitZone => ({ name: 'upperTorso', center: { x, y, z }, radius });

describe('exitPoint', () => {
  it('leaves a single sphere on the far side of the line it went in on', () => {
    const out = exitPoint([ball(0, 0, 0, 0.1)], { x: 0, y: 0, z: 0.1 }, { x: 0, y: 0, z: -1 });
    expect(out.z).toBeCloseTo(-0.1, 9);
    expect(out.x).toBeCloseTo(0, 9);
  });

  it('follows a run of overlapping spheres to the end of the body, and stops at a real gap', () => {
    const zones = [ball(0, 0, 0, 0.1), ball(0, 0, -0.15, 0.1), ball(0, 0, -0.3, 0.1), ball(0, 0, -1, 0.1)]; // the last one is another body
    const out = exitPoint(zones, { x: 0, y: 0, z: 0.1 }, { x: 0, y: 0, z: -1 });
    expect(out.z).toBeCloseTo(-0.4, 9);
  });

  it('a grazing hit comes out close to where it went in, and a long run is cut at maxLength', () => {
    const graze = exitPoint([ball(0, 0, 0, 0.1)], { x: 0.0999, y: 0, z: 0.01 }, { x: 0, y: 0, z: -1 });
    expect(Math.hypot(graze.x - 0.0999, graze.z - 0.01)).toBeLessThan(0.05);
    const tube = Array.from({ length: 40 }, (_, i) => ball(0, 0, -i * 0.1, 0.1));
    const out = exitPoint(tube, { x: 0, y: 0, z: 0.1 }, { x: 0, y: 0, z: -1 }, 0.8);
    expect(out.z).toBeCloseTo(0.1 - 0.8, 9);
  });
});

describe('continuedVelocity', () => {
  it('keeps 60-75 % of the speed and stays within a few degrees of the line', () => {
    const rng = createRng(3);
    const v = { x: 100, y: -20, z: -780 };
    const speed = Math.hypot(v.x, v.y, v.z);
    for (let i = 0; i < 200; i++) {
      const w = continuedVelocity(v, rng);
      const k = Math.hypot(w.x, w.y, w.z) / speed;
      expect(k).toBeGreaterThan(KEEP_MIN - 0.06);
      expect(k).toBeLessThan(KEEP_MAX + 0.06);
      const cos = (w.x * v.x + w.y * v.y + w.z * v.z) / (Math.hypot(w.x, w.y, w.z) * speed);
      expect(Math.acos(Math.min(1, cos))).toBeLessThan(0.12);
    }
  });
});
