import { describe, expect, it } from 'vitest';
import { HVT, HvtParty, escapeFloorS } from '../../src/game/hvt';
import type { EscapePoint, HvtPartyOptions, RoutePoint } from '../../src/game/hvt';

// The HVT's party (game/hvt.ts): his walk, his guards, the alarm, the run to the escape point and its window.

/** Open ground: a route is the straight line. */
const OPEN = { path: (_fx: number, _fz: number, tx: number, tz: number) => [tx, tz] };
/** The shooter, straight downrange of the compound (toward +Z of it). */
const SHOOTER = { x: 0, z: 0 };
const ROUTE: RoutePoint[] = [
  { x: -10, z: -600, waitS: 4 },
  { x: 0, z: -594, waitS: 0 },
  { x: 10, z: -600, waitS: 4 },
  { x: 0, z: -608, waitS: 0 },
];
const ESCAPES: EscapePoint[] = [
  { kind: 'vehicle', x: 12, z: -601, covered: true },
  { kind: 'door', x: -11, z: -600, covered: false },
];

function party(extra: Partial<HvtPartyOptions> = {}): HvtParty {
  return new HvtParty({ route: ROUTE, escapes: ESCAPES, guards: 3, map: OPEN, seed: 5, ...extra });
}

function run(p: HvtParty, seconds: number, each?: (t: number) => void): void {
  const dt = 1 / 30;
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    p.update(dt);
    each?.(i * dt);
  }
}

describe('the HVT before the alarm', () => {
  it('walks his route at a walking pace, stops on it, and keeps his guards 2-6 m round him', () => {
    const p = party();
    let maxSpeed = 0;
    let stopped = 0;
    let worstNear = Infinity;
    let worstFar = 0;
    run(p, 60, (t) => {
      maxSpeed = Math.max(maxSpeed, p.officer.speed);
      if (p.officer.speed < 0.05) stopped++;
      if (t < 5) return; // the guards' first steps into their places
      for (const g of p.guards) {
        const d = Math.hypot(g.x - p.officer.x, g.z - p.officer.z);
        worstNear = Math.min(worstNear, d);
        worstFar = Math.max(worstFar, d);
      }
    });
    expect(maxSpeed).toBeGreaterThan(1.2);
    expect(maxSpeed).toBeLessThanOrEqual(HVT.walkMps + 1e-9);
    expect(stopped / 1800).toBeGreaterThan(0.15); // he stands a good part of the time
    expect(worstNear).toBeGreaterThan(1.2); // a guard swings close by as he turns, never into him
    expect(worstFar).toBeLessThan(6.5);
    expect(p.status).toBe('idle');
    expect(p.officer.handsBehind).toBe(true);
  });

  it('is the same walk for the same seed', () => {
    const a = party();
    const b = party();
    run(a, 20);
    run(b, 20);
    expect([b.officer.x, b.officer.z, b.guards[0].x]).toEqual([a.officer.x, a.officer.z, a.guards[0].x]);
  });
});

describe('the alarm', () => {
  it('a report they can place: after a human reaction the guards close in between him and the shooter', () => {
    const p = party();
    run(p, 3);
    p.alarm({ directional: true, shooterX: SHOOTER.x, shooterZ: SHOOTER.z });
    expect(p.status).toBe('alarmed');
    run(p, 0.25);
    expect(p.status).toBe('alarmed'); // nobody reacts within a quarter second
    run(p, 2.5);
    expect(p.status).toBe('fleeing');
    const o = p.officer;
    const toShooter = { x: SHOOTER.x - o.x, z: SHOOTER.z - o.z };
    const l = Math.hypot(toShooter.x, toShooter.z);
    for (const g of p.guards) {
      const d = Math.hypot(g.x - o.x, g.z - o.z);
      expect(d).toBeLessThan(2.5);
      // On the shooter's side of him.
      expect(((g.x - o.x) * toShooter.x + (g.z - o.z) * toShooter.z) / l).toBeGreaterThan(-0.2);
    }
  });

  it('a crack they cannot place: they close in all round him', () => {
    const p = party();
    run(p, 3);
    p.alarm({ directional: false, shooterX: 0, shooterZ: 0 });
    run(p, 2.5);
    expect(p.threatKnown).toBe(false);
    const o = p.officer;
    // The guards' mean offset is small: they surround him rather than stand on one side.
    let mx = 0;
    let mz = 0;
    for (const g of p.guards) {
      mx += (g.x - o.x) / p.guards.length;
      mz += (g.z - o.z) / p.guards.length;
      expect(Math.hypot(g.x - o.x, g.z - o.z)).toBeLessThan(2.5);
    }
    expect(Math.hypot(mx, mz)).toBeLessThan(0.9);
  });

  it('runs for the covered escape point, crouched, and is gone when the window (15-40 s) is up', () => {
    const p = party();
    run(p, 9); // out in front of the compound, a little nearer the door than the jeep
    expect(Math.hypot(p.officer.x + 11, p.officer.z + 600)).toBeLessThan(Math.hypot(p.officer.x - 12, p.officer.z + 601));
    p.alarm({ directional: true, shooterX: 0, shooterZ: 0 });
    run(p, 1.2);
    expect(p.escapePoint?.kind).toBe('vehicle'); // covered, though the door is nearer
    expect(p.officer.stance).toBe('crouch');
    const window = p.escapeWindow;
    expect(window).toBeGreaterThanOrEqual(HVT.escapeMinS);
    expect(window).toBeLessThanOrEqual(HVT.escapeMaxS);
    run(p, window - 2.5);
    expect(p.status).toBe('fleeing');
    expect(Math.hypot(p.officer.x - 12, p.officer.z + 601)).toBeLessThan(0.5); // waiting at the jeep
    run(p, 1.5);
    expect(p.status).toBe('escaped');
    expect(p.escapeIn).toBe(0);
  });

  it('a long run takes what it takes, and a wounded man limps at half the pace', () => {
    const far: EscapePoint[] = [{ kind: 'door', x: -40, z: -620, covered: false }];
    const healthy = party({ escapes: far });
    const hurt = party({ escapes: far });
    for (const p of [healthy, hurt]) {
      run(p, 1);
      p.alarm({ directional: false, shooterX: 0, shooterZ: 0 });
    }
    hurt.wound({ directional: false, shooterX: 0, shooterZ: 0 });
    expect(hurt.status).toBe('wounded');
    run(healthy, 4);
    run(hurt, 4);
    expect(healthy.officer.speed).toBeGreaterThan(HVT.fleeMps * 0.9);
    expect(hurt.officer.speed).toBeLessThan(HVT.fleeMps * HVT.woundedFactor + 0.01);
    expect(hurt.escapeIn).toBeGreaterThan(healthy.escapeIn + 5);
    expect(hurt.escapeWindow).toBeLessThan(HVT.escapeMaxS * 1.6);
  });

  it('gives a farther compound a longer window: 15 s to 300 m, 25 s at 700 m, never more than 30 s as a floor', () => {
    expect(escapeFloorS(150)).toBe(15);
    expect(escapeFloorS(300)).toBe(15);
    expect(escapeFloorS(700)).toBeCloseTo(25, 9);
    expect(escapeFloorS(1500)).toBe(30);
    const p = party({ escapeFloorS: escapeFloorS(700) });
    run(p, 9);
    p.alarm({ directional: false, shooterX: 0, shooterZ: 0 });
    run(p, 1.2);
    expect(p.escapeWindow).toBeCloseTo(25, 0);
  });

  it('is down for good once killed, and a dead guard stops guarding', () => {
    const p = party();
    run(p, 2);
    p.killGuard(1);
    expect(p.guardsAlive).toBe(2);
    p.kill();
    expect(p.status).toBe('down');
    p.alarm({ directional: true, shooterX: 0, shooterZ: 0 });
    run(p, 30);
    expect(p.status).toBe('down');
  });
});
