import { describe, expect, it } from 'vitest';
import {
  SNIPER_BOUNDS,
  SNIPER_PARTS,
  SNIPER_REACH,
  sniperAimPoints,
  sniperBoundsObstacle,
  sniperHitSpheres,
  sniperWorldPoint,
  sniperZones,
} from '../../src/mission/sniperDims';
import { segmentBox } from '../../src/game/hit';
import { createRng } from '../../src/mission/random';

describe('sniper hit spheres', () => {
  it('cover every point of every body part', () => {
    const rng = createRng(77);
    const spheres = sniperHitSpheres();
    let checked = 0;
    for (const part of SNIPER_PARTS) {
      for (let i = 0; i < 4000; i++) {
        // A random point inside the ellipsoid (rejection sampling in the unit ball).
        let ux = 0;
        let uy = 0;
        let uz = 0;
        do {
          ux = rng() * 2 - 1;
          uy = rng() * 2 - 1;
          uz = rng() * 2 - 1;
        } while (ux * ux + uy * uy + uz * uz > 1);
        const p = { x: part.cx + ux * part.rx, y: part.cy + uy * part.ry, z: part.cz + uz * part.rz };
        const inside = spheres.some((s) => Math.hypot(p.x - s.x, p.y - s.y, p.z - s.z) <= s.radius);
        expect(inside, `${part.zone} point ${JSON.stringify(p)}`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBe(SNIPER_PARTS.length * 4000);
  });

  it('give every part its own zone name, and use only the four body zones', () => {
    expect(new Set(sniperHitSpheres().map((s) => s.name))).toEqual(new Set(['head', 'upperTorso', 'lowerTorso', 'limbs']));
    // The head sphere is the first sphere: a head shot is a head shot even where two spheres overlap.
    expect(sniperHitSpheres()[0].name).toBe('head');
  });

  it('overhang the visible body only slightly', () => {
    const rho = (zone: string): number => Math.max(...SNIPER_PARTS.filter((p) => p.zone === zone).map((p) => Math.max(p.rx, p.ry)));
    for (const s of sniperHitSpheres()) expect(s.radius).toBeLessThanOrEqual(rho(s.name) * 1.15 + 1e-9);
  });

  it('are few enough for a cheap bullet test', () => {
    expect(sniperHitSpheres().length).toBeLessThan(40);
  });

  it('lie inside the body bounds, give or take the overhang', () => {
    const b = SNIPER_BOUNDS;
    for (const s of sniperHitSpheres()) {
      expect(s.x - s.radius).toBeGreaterThanOrEqual(b.cx - b.hx - 0.06);
      expect(s.x + s.radius).toBeLessThanOrEqual(b.cx + b.hx + 0.06);
      expect(s.y + s.radius).toBeLessThanOrEqual(b.cy + b.hy + 0.06);
      expect(s.z - s.radius).toBeGreaterThanOrEqual(b.cz - b.hz - 0.06);
      expect(s.z + s.radius).toBeLessThanOrEqual(b.cz + b.hz + 0.06);
    }
  });
});

describe('sniper bounds', () => {
  it('enclose every body part and sit on the ground', () => {
    const b = SNIPER_BOUNDS;
    for (const p of SNIPER_PARTS) {
      expect(p.cx - p.rx).toBeGreaterThanOrEqual(b.cx - b.hx - 1e-9);
      expect(p.cx + p.rx).toBeLessThanOrEqual(b.cx + b.hx + 1e-9);
      expect(p.cy + p.ry).toBeLessThanOrEqual(b.cy + b.hy + 1e-9);
      expect(p.cz - p.rz).toBeGreaterThanOrEqual(b.cz - b.hz - 1e-9);
      expect(p.cz + p.rz).toBeLessThanOrEqual(b.cz + b.hz + 1e-9);
    }
    expect(b.cy - b.hy).toBeGreaterThanOrEqual(0);
    expect(b.cy - b.hy).toBeLessThan(0.05);
  });

  it('SNIPER_REACH reaches the farthest corner of the bounds', () => {
    const b = SNIPER_BOUNDS;
    expect(SNIPER_REACH).toBeGreaterThanOrEqual(Math.hypot(b.cx, b.cz + b.hz));
    expect(SNIPER_REACH).toBeLessThan(2.1);
  });

  it('turn with the pose and hold both aim points', () => {
    const pose = { x: 10, y: 3, z: -400, yaw: 0.4 };
    const aim = sniperAimPoints(pose);
    const obstacle = sniperBoundsObstacle(pose, 'sniper-0');
    expect(obstacle.id).toBe('sniper-0:bounds');
    // A segment that starts inside the box returns 0: both aim points are inside the bounds.
    for (const p of [aim.head, aim.upperTorso]) {
      expect(segmentBox(p, { x: p.x + 1e-6, y: p.y, z: p.z }, obstacle.box)).toBe(0);
    }
  });
});

describe('sniper pose', () => {
  it('puts the head toward the shooter at yaw = facingYaw', () => {
    // Facing yaw of a sniper at (0, -500): zero. Local +Z (the head end) points at world +Z, toward the origin.
    const head = sniperWorldPoint({ x: 0, y: 0, z: -500, yaw: 0 }, { x: 0, y: 0, z: 0.13 });
    expect(head.z).toBeCloseTo(-499.87, 9);
    // At +90 degrees local +Z points at world +X.
    const side = sniperWorldPoint({ x: 0, y: 0, z: 0, yaw: Math.PI / 2 }, { x: 0, y: 0, z: 1 });
    expect(side.x).toBeCloseTo(1, 9);
    expect(side.z).toBeCloseTo(0, 9);
    // Local +X maps to world (cos yaw, -sin yaw), like the props.
    const right = sniperWorldPoint({ x: 0, y: 0, z: 0, yaw: Math.PI / 2 }, { x: 1, y: 0, z: 0 });
    expect(right.x).toBeCloseTo(0, 9);
    expect(right.z).toBeCloseTo(-1, 9);
  });

  it('turns every zone sphere about the belly position', () => {
    const pose = { x: 5, y: 2, z: -300, yaw: 1 };
    const zones = sniperZones(pose);
    expect(zones).toHaveLength(sniperHitSpheres().length);
    zones.forEach((z, i) => {
      const s = sniperHitSpheres()[i];
      expect(Math.hypot(z.center.x - pose.x, z.center.z - pose.z)).toBeCloseTo(Math.hypot(s.x, s.z), 9);
      expect(z.center.y).toBeCloseTo(pose.y + s.y, 9);
    });
  });
});
