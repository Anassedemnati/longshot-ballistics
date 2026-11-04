import { describe, expect, it } from 'vitest';
import { RIFLES } from '../../src/ballistics/rifles';
import {
  KEEP_MAX,
  KEEP_MIN,
  MIN_THROUGH_SPEED,
  REFERENCE_SPEED,
  continuedVelocity,
  downsSecondTarget,
  exitPoint,
  punchThrough,
} from '../../src/game/penetration';
import type { Box } from '../../src/game/hit';
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
  it('keeps 60-75 % of the speed (the .308 at the reference speed) and stays within a few degrees of the line', () => {
    const rng = createRng(3);
    const v = { x: 0, y: -0.2 * REFERENCE_SPEED / 7.9, z: -REFERENCE_SPEED };
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

const keptShare = (massG: number, speed: number, seed = 5): number => {
  const rng = createRng(seed);
  let sum = 0;
  for (let i = 0; i < 100; i++) {
    const w = continuedVelocity({ x: 0, y: 0, z: -speed }, rng, massG);
    sum += Math.hypot(w.x, w.y, w.z) / speed;
  }
  return sum / 100;
};

describe('continuedVelocity: momentum decides what is kept', () => {
  it('a heavy bullet keeps more of its speed through a body than a light one at the same speed', () => {
    const m308 = keptShare(RIFLES['308'].bulletMassG, 600);
    const m338 = keptShare(RIFLES['338'].bulletMassG, 600);
    const m50 = keptShare(RIFLES['50'].bulletMassG, 600);
    expect(m338).toBeGreaterThan(m308);
    expect(m50).toBeGreaterThan(m338);
    expect(m50).toBeGreaterThan(0.85);
  });

  it('a slow bullet keeps less than a fast one, and never more than it had', () => {
    const mass = RIFLES['308'].bulletMassG;
    expect(keptShare(mass, 350)).toBeLessThan(keptShare(mass, 750));
    expect(keptShare(RIFLES['50'].bulletMassG, 900)).toBeLessThanOrEqual(0.95 * 1.05);
  });
});

describe('downsSecondTarget', () => {
  const after = (id: keyof typeof RIFLES, impactSpeed: number): boolean => {
    const rng = createRng(9);
    return downsSecondTarget(RIFLES[id].bulletMassG, continuedVelocity({ x: 0, y: 0, z: -impactSpeed }, rng, RIFLES[id].bulletMassG));
  };

  it('the heavy calibres carry on and down the man behind, even far out; the .308 does not', () => {
    expect(after('50', 480)).toBe(true); // .50 BMG at 1500 m
    expect(after('127', 400)).toBe(true);
    expect(after('408', 460)).toBe(true);
    expect(after('308', 480)).toBe(false); // .308 at 600 m
    expect(after('308', 330)).toBe(false);
  });
});

describe('punchThrough', () => {
  const box: Box = { center: { x: 0, y: 1, z: -100 }, halfSize: { x: 1.2, y: 0.8, z: 2 }, yaw: 0.3 };
  const entryOf = (): { x: number; y: number; z: number } => {
    // Where the line x = 0, y = 1 enters the box from the shooter's side (+z).
    const c = Math.cos(box.yaw);
    const s = Math.sin(box.yaw);
    // Local z of a point (0, z) is s*0 + c*(z - cz); local x is -s*(z - cz): find the first face crossed coming from +z.
    const tZ = box.halfSize.z / c;
    const tX = box.halfSize.x / Math.abs(s);
    return { x: 0, y: 1, z: box.center.z + Math.min(tZ, tX) - 1e-9 };
  };

  it('carries a .50 BMG out past the far face, slower, and stops a .308', () => {
    const v = { x: 0, y: 0, z: -700 };
    const on = punchThrough(box, entryOf(), v, RIFLES['50'].bulletMassG, createRng(1));
    expect(on).not.toBeNull();
    if (!on) return;
    const speed = Math.hypot(on.velocity.x, on.velocity.y, on.velocity.z);
    expect(speed).toBeLessThan(700 * 0.85);
    expect(speed).toBeGreaterThan(700 * 0.6);
    expect(on.origin.z).toBeLessThan(box.center.z - 1); // out the far side
    expect(punchThrough(box, entryOf(), v, RIFLES['308'].bulletMassG, createRng(1))).toBeNull();
  });

  it('gets the .408 and the 12.7 mm through too, and nothing that would come out under MIN_THROUGH_SPEED', () => {
    for (const id of ['408', '127'] as const) {
      const on = punchThrough(box, entryOf(), { x: 0, y: 0, z: -650 }, RIFLES[id].bulletMassG, createRng(2));
      expect(on).not.toBeNull();
    }
    const slow = punchThrough(box, entryOf(), { x: 0, y: 0, z: -200 }, RIFLES['408'].bulletMassG, createRng(2));
    if (slow) expect(Math.hypot(slow.velocity.x, slow.velocity.y, slow.velocity.z)).toBeGreaterThan(MIN_THROUGH_SPEED * 0.9);
  });
});
