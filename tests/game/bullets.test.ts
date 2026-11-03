import { describe, expect, it } from 'vitest';
import reference from '../fixtures/reference.json';
import { STANDARD_ATMO } from '../../src/ballistics/atmosphere';
import { DEFAULT_DT } from '../../src/ballistics/integrator';
import { RIFLES } from '../../src/ballistics/rifles';
import { findZeroElevation } from '../../src/ballistics/trajectory';
import type { Vec3, WindField } from '../../src/ballistics/types';
import { BulletSystem, pointSegmentDistanceSq } from '../../src/game/bullets';
import type { BulletSystemOptions, ImpactEvent } from '../../src/game/bullets';
import type { HitTarget } from '../../src/game/hit';

const NO_WIND: WindField = () => ({ x: 0, y: 0, z: 0 });
const RIFLE = RIFLES['308'];
const BC = RIFLE.bcG7;
const MV = RIFLE.muzzleVelocity;
const ZERO_ELEV = findZeroElevation(RIFLE, STANDARD_ATMO);
/** Bore position relative to the line of sight (y = 0). */
const MUZZLE: Vec3 = { x: 0, y: -RIFLE.sightHeight, z: 0 };

function ball(id: string, center: Vec3, radius: number): HitTarget {
  return { id, zones: [{ name: 'upperTorso', center, radius }] };
}

function makeSystem(overrides: Partial<BulletSystemOptions> = {}): BulletSystem {
  return new BulletSystem({
    atmo: STANDARD_ATMO,
    wind: NO_WIND,
    terrainHeight: () => -100,
    targets: () => [],
    ...overrides,
  });
}

/** Zero-elevation velocity along -Z. */
function zeroVelocity(): Vec3 {
  return { x: 0, y: MV * Math.sin(ZERO_ELEV), z: -MV * Math.cos(ZERO_ELEV) };
}

/** Keep updating until at least one event arrives (or the safety cap is hit). */
function runUntilEvents(sys: BulletSystem, frameDt: number, maxFrames = 2000): ImpactEvent[] {
  const all: ImpactEvent[] = [];
  for (let i = 0; i < maxFrames && all.length === 0; i++) {
    all.push(...sys.update(frameDt));
  }
  return all;
}

const longShotCase = reference.cases.find(
  (c) => c.rifle === '308' && c.air === 'standard' && c.windFromLeftMps === 0,
);
const longShot = longShotCase?.samples.find((s) => s.range === 800);

describe('BulletSystem', () => {
  it('defaults: 1 ms substeps and ids that increase per bullet', () => {
    expect(DEFAULT_DT).toBe(0.001);
    const sys = makeSystem();
    const a = sys.fire(MUZZLE, zeroVelocity(), BC);
    const b = sys.fire(MUZZLE, zeroVelocity(), BC);
    expect(b).not.toBe(a);
    expect(sys.active.map((x) => x.id)).toEqual([a, b]);
    expect(sys.active[0].state.t).toBe(0);
    expect(sys.active[0].state.pos).toEqual(MUZZLE);
  });

  it('zero check: a bullet fired at the zero elevation hits a 0.1 m sphere at 100 m on the line of sight', () => {
    const sys = makeSystem({ targets: () => [ball('t1', { x: 0, y: 0, z: -100 }, 0.1)] });
    const id = sys.fire(MUZZLE, zeroVelocity(), BC);
    const events = runUntilEvents(sys, 0.016);
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.kind).toBe('target');
    if (e.kind !== 'target') throw new Error('unreachable');
    expect(e.bulletId).toBe(id);
    expect(e.targetId).toBe('t1');
    expect(e.zone).toBe('upperTorso');
    expect(e.time).toBeGreaterThan(0.12);
    expect(e.time).toBeLessThan(0.14);
    expect(e.point.z).toBeLessThan(-99.89);
    expect(e.point.z).toBeGreaterThan(-100.11);
    expect(sys.active).toHaveLength(0);
  });

  it('long shot: 800 m hit time within 1% of the reference fixture', () => {
    expect(longShot, 'fixture sample 308/standard/wind0 @800 m missing').toBeDefined();
    const ref = longShot as NonNullable<typeof longShot>;
    const sys = makeSystem({ targets: () => [ball('far', { x: 0, y: ref.height, z: -800 }, 0.25)] });
    sys.fire(MUZZLE, zeroVelocity(), BC);
    const events = runUntilEvents(sys, 0.016);
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.kind).toBe('target');
    expect(Math.abs(e.time - ref.time)).toBeLessThanOrEqual(0.01 * ref.time);
  });

  it('dt spike: update(5) is clamped to 0.1 s of flight and the bullet is not tunnelled through the target', () => {
    const ref = longShot as NonNullable<typeof longShot>;
    const sys = makeSystem({ targets: () => [ball('far', { x: 0, y: ref.height, z: -800 }, 0.25)] });
    sys.fire(MUZZLE, zeroVelocity(), BC);

    const first = sys.update(5.0);
    expect(first).toEqual([]);
    expect(sys.active).toHaveLength(1);
    const t = sys.active[0].state.t;
    expect(t).toBeLessThanOrEqual(0.1 + 1e-9);
    expect(t).toBeGreaterThanOrEqual(0.1 - DEFAULT_DT - 1e-9);

    const events = runUntilEvents(sys, 5.0, 100);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('target');
    expect(Math.abs(events[0].time - ref.time)).toBeLessThanOrEqual(0.01 * ref.time);
  });

  it('fixed substeps: the remainder of a short frame is carried to the next update', () => {
    const sys = makeSystem();
    sys.fire(MUZZLE, zeroVelocity(), BC);
    sys.update(0.0004);
    expect(sys.active[0].state.t).toBe(0);
    sys.update(0.0004);
    expect(sys.active[0].state.t).toBe(0);
    sys.update(0.0004); // 1.2 ms accumulated -> exactly one 1 ms step
    expect(sys.active[0].state.t).toBeCloseTo(0.001, 12);
    sys.update(0.0095); // 0.2 ms carried + 9.5 ms = 9.7 ms -> 9 more steps, 0.7 ms left over
    expect(sys.active[0].state.t).toBeCloseTo(0.010, 9);
    sys.update(0.0003); // 0.7 + 0.3 -> one more step
    expect(sys.active[0].state.t).toBeCloseTo(0.011, 9);
  });

  it('sky shot: 45 degrees up expires at 6 s of flight', () => {
    const sys = makeSystem({ terrainHeight: () => -1000 });
    const a = Math.PI / 4;
    const id = sys.fire({ x: 0, y: 1.5, z: 0 }, { x: 0, y: MV * Math.sin(a), z: -MV * Math.cos(a) }, BC);
    const events = runUntilEvents(sys, 0.1);
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.kind).toBe('expired');
    expect(e.bulletId).toBe(id);
    expect(Math.abs(e.time - 6)).toBeLessThanOrEqual(DEFAULT_DT);
    expect(sys.active).toHaveLength(0);
  });

  it('honours a custom maxFlightTime', () => {
    const sys = makeSystem({ terrainHeight: () => -1000, maxFlightTime: 0.5 });
    sys.fire({ x: 0, y: 1.5, z: 0 }, { x: 0, y: 100, z: -100 }, BC);
    const events = runUntilEvents(sys, 0.1);
    expect(events[0].kind).toBe('expired');
    expect(Math.abs(events[0].time - 0.5)).toBeLessThanOrEqual(DEFAULT_DT);
  });

  it('terrain: a bullet fired 2 degrees down hits flat ground at y = 0 within 1 cm', () => {
    const sys = makeSystem({ terrainHeight: () => 0 });
    const a = (2 * Math.PI) / 180;
    const id = sys.fire({ x: 0, y: 1.5, z: 0 }, { x: 0, y: -MV * Math.sin(a), z: -MV * Math.cos(a) }, BC);
    const events = runUntilEvents(sys, 0.016);
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.kind).toBe('terrain');
    if (e.kind !== 'terrain') throw new Error('unreachable');
    expect(e.bulletId).toBe(id);
    expect(Math.abs(e.point.y)).toBeLessThanOrEqual(0.01);
    // 1.5 m / tan(2 deg) ~ 43 m downrange, ~54 ms of flight.
    expect(e.point.z).toBeLessThan(-42);
    expect(e.point.z).toBeGreaterThan(-45);
    expect(e.time).toBeGreaterThan(0.05);
    expect(e.time).toBeLessThan(0.06);
    expect(sys.active).toHaveLength(0);
  });

  it('terrain: follows sloped ground, sampling height at the crossing point', () => {
    // Ground height climbs 5 cm per metre downrange (z is negative downrange), from -10 m at the shooter.
    const ground = (_x: number, z: number): number => -0.05 * z - 10;
    const sys = makeSystem({ terrainHeight: ground });
    sys.fire({ x: 0, y: 5, z: 0 }, { x: 0, y: 0, z: -MV }, BC);
    const events = runUntilEvents(sys, 0.016);
    const e = events[0];
    expect(e.kind).toBe('terrain');
    if (e.kind !== 'terrain') throw new Error('unreachable');
    expect(Math.abs(e.point.y - ground(e.point.x, e.point.z))).toBeLessThanOrEqual(0.01);
  });

  describe('target vs terrain within one substep (10 ms substeps, ~8 m per step)', () => {
    const A = (2 * Math.PI) / 180;
    const START: Vec3 = { x: 0, y: 1.5, z: 0 };
    const VEL: Vec3 = { x: 0, y: -MV * Math.sin(A), z: -MV * Math.cos(A) };

    function fly(sphereCenter: Vec3 | null): ImpactEvent {
      const sys = makeSystem({
        dt: 0.01,
        terrainHeight: () => 0,
        targets: () => (sphereCenter ? [ball('s', sphereCenter, 0.15)] : []),
      });
      sys.fire(START, VEL, BC);
      return runUntilEvents(sys, 0.1, 100)[0];
    }

    it('a sphere entered before the ground crossing wins', () => {
      const ground = fly(null);
      if (ground.kind !== 'terrain') throw new Error('expected a terrain probe');
      // 0.4 m up-path of the crossing, centred on the flight line: contact begins ~0.25 m before the crossing.
      const e = fly({ x: 0, y: ground.point.y, z: ground.point.z + 0.4 });
      expect(e.kind).toBe('target');
      expect(e.time).toBeLessThan(ground.time);
    });

    it('the ground wins when the sphere is only reached after the crossing', () => {
      const ground = fly(null);
      if (ground.kind !== 'terrain') throw new Error('expected a terrain probe');
      // Centred 0.6 m past the crossing and 5 cm underground: the bullet reaches it only after passing y = 0.
      const e = fly({ x: 0, y: -0.05, z: ground.point.z - 0.6 });
      expect(e.kind).toBe('terrain');
    });
  });

  it('terrain wins when the ground is crossed before the target is reached', () => {
    const sys = makeSystem({
      terrainHeight: () => 0,
      targets: () => [ball('behind', { x: 0, y: 0, z: -100 }, 0.3)],
    });
    const a = (2 * Math.PI) / 180;
    sys.fire({ x: 0, y: 1.5, z: 0 }, { x: 0, y: -MV * Math.sin(a), z: -MV * Math.cos(a) }, BC);
    const events = runUntilEvents(sys, 0.016);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('terrain');
  });

  it('picks the earliest zone along the segment and reports its name', () => {
    const sys = makeSystem({
      targets: () => [
        {
          id: 'man',
          zones: [
            { name: 'lowerTorso', center: { x: 0, y: 0, z: -100.5 }, radius: 0.2 },
            { name: 'head', center: { x: 0, y: 0, z: -100 }, radius: 0.2 },
          ],
        },
      ],
    });
    sys.fire(MUZZLE, zeroVelocity(), BC);
    const e = runUntilEvents(sys, 0.016)[0];
    expect(e.kind).toBe('target');
    if (e.kind !== 'target') throw new Error('unreachable');
    expect(e.zone).toBe('head');
    expect(e.targetId).toBe('man');
  });

  it('two bullets fired 0.05 s apart hit two targets with different bullet ids', () => {
    const targets = [
      ball('left', { x: -1, y: 0, z: -100 }, 0.1),
      ball('right', { x: 1, y: 0, z: -100 }, 0.1),
    ];
    const sys = makeSystem({ targets: () => targets });
    const idLeft = sys.fire({ x: -1, y: -RIFLE.sightHeight, z: 0 }, zeroVelocity(), BC);
    sys.update(0.05);
    const idRight = sys.fire({ x: 1, y: -RIFLE.sightHeight, z: 0 }, zeroVelocity(), BC);
    expect(idRight).not.toBe(idLeft);

    const events: ImpactEvent[] = [];
    for (let i = 0; i < 100 && events.length < 2; i++) events.push(...sys.update(0.016));
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.kind)).toEqual(['target', 'target']);
    expect(new Set(events.map((e) => e.bulletId)).size).toBe(2);
    for (const e of events) {
      if (e.kind !== 'target') throw new Error('unreachable');
      expect(e.targetId).toBe(e.bulletId === idLeft ? 'left' : 'right');
    }
    expect(sys.active).toHaveLength(0);
    // Each event carries its own bullet's flight time (not the system clock), so they match.
    expect(Math.abs(events[0].time - events[1].time)).toBeLessThanOrEqual(DEFAULT_DT);
  });

  it('treats NaN, negative and non-finite frame times as 0 and is not poisoned afterwards', () => {
    const sys = makeSystem();
    sys.fire(MUZZLE, zeroVelocity(), BC);
    for (const bad of [Number.NaN, -1, -0.5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(sys.update(bad)).toEqual([]);
      expect(sys.active[0].state.t).toBe(0);
    }
    sys.update(0.01); // a good frame still advances exactly 10 substeps
    expect(sys.active[0].state.t).toBeCloseTo(0.01, 9);
  });

  it('constructor rejects a substep that is zero, negative or not finite', () => {
    for (const dt of [0, -0.001, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => makeSystem({ dt })).toThrow();
    }
    expect(() => makeSystem({ dt: 0.002 })).not.toThrow();
  });

  it('removes a bullet on its first event and emits nothing afterwards', () => {
    const sys = makeSystem({ targets: () => [ball('t1', { x: 0, y: 0, z: -100 }, 0.1)] });
    sys.fire(MUZZLE, zeroVelocity(), BC);
    expect(runUntilEvents(sys, 0.016)).toHaveLength(1);
    expect(sys.update(0.1)).toEqual([]);
    expect(sys.active).toHaveLength(0);
  });
});

describe('BulletSystem: closest pass to the watch points', () => {
  /** Fly one zero-elevation bullet down -Z until it ends, against `opts`; returns its only event. */
  function fly(opts: Partial<BulletSystemOptions>): ImpactEvent {
    const sys = makeSystem(opts);
    sys.fire(MUZZLE, zeroVelocity(), BC);
    const events = runUntilEvents(sys, 0.016);
    expect(events).toHaveLength(1);
    return events[0];
  }
  const wall = (z: number): HitTarget => ball('wall', { x: 0, y: 0, z }, 0.3);

  it('adds nothing to the events, not even the field, without watch points', () => {
    const e = fly({ targets: () => [wall(-200)] });
    expect(e.kind).toBe('target');
    expect('closestWatchM' in e).toBe(false);
  });

  it('is Infinity on every event when there is nothing to watch', () => {
    expect(fly({ targets: () => [wall(-200)], watchPoints: () => [] }).closestWatchM).toBe(Infinity);
  });

  it('measures the closest the bullet came to a point beside its path', () => {
    // The zero check puts the bullet on the line of sight (y = 0) at 100 m: a point 2 m to the side of it there is 2 m away.
    const e = fly({ targets: () => [wall(-200)], watchPoints: () => [{ x: 2, y: 0, z: -100 }] });
    expect(e.closestWatchM).toBeGreaterThan(1.9);
    expect(e.closestWatchM).toBeLessThan(2.1);
  });

  it('keeps the nearest of several points, wherever along the flight they are', () => {
    const near = { x: 1.5, y: 0, z: -150 };
    const e = fly({
      targets: () => [wall(-200)],
      watchPoints: () => [{ x: 6, y: 0, z: -50 }, near, { x: 9, y: 0, z: -120 }],
    });
    expect(e.closestWatchM).toBeGreaterThan(1.4);
    expect(e.closestWatchM).toBeLessThan(1.9);
  });

  it('measures to the segment, not to the substep ends: a point between two substeps (0.8 m apart) is still found', () => {
    const e = fly({ targets: () => [wall(-200)], watchPoints: () => [{ x: 0.2, y: 0, z: -100.3 }] });
    expect(e.closestWatchM).toBeLessThan(0.3);
  });

  it('stops measuring where the bullet ends: a point just past the impact is that far away, not zero', () => {
    const e = fly({ targets: () => [wall(-100)], watchPoints: () => [{ x: 0, y: 0, z: -110 }] });
    expect(e.kind).toBe('target');
    expect(e.closestWatchM).toBeGreaterThan(9.5);
    expect(e.closestWatchM).toBeLessThan(10.7);
  });

  it('a point the bullet never got near is far, and a bullet that hits the point itself reads about 0', () => {
    expect(fly({ targets: () => [wall(-200)], watchPoints: () => [{ x: 300, y: 0, z: -100 }] }).closestWatchM).toBeGreaterThan(290);
    expect(fly({ targets: () => [ball('t', { x: 0, y: 0, z: -100 }, 0.3)], watchPoints: () => [{ x: 0, y: 0, z: -100 }] }).closestWatchM).toBeLessThan(0.4);
  });

  it('is there on terrain, obstacle and expired events too', () => {
    const watch = () => [{ x: 3, y: 0, z: -20 }];
    const terrain = fly({ terrainHeight: (_x, z) => (z < -60 ? 10 : -100), watchPoints: watch });
    expect(terrain.kind).toBe('terrain');
    expect(terrain.closestWatchM).toBeGreaterThan(2.9);
    expect(terrain.closestWatchM).toBeLessThan(3.2);
    const box = {
      id: 'box',
      material: 'wall' as const,
      box: { center: { x: 0, y: 0, z: -60 }, halfSize: { x: 2, y: 2, z: 0.5 }, yaw: 0 },
    };
    const obstacle = fly({ obstacles: () => [box], watchPoints: watch });
    expect(obstacle.kind).toBe('obstacle');
    expect(obstacle.closestWatchM).toBeGreaterThan(2.9);
    expect(obstacle.closestWatchM).toBeLessThan(3.2);
    const expired = fly({ maxFlightTime: 0.05, watchPoints: watch });
    expect(expired.kind).toBe('expired');
    expect(expired.closestWatchM).toBeGreaterThan(2.9);
    expect(expired.closestWatchM).toBeLessThan(3.2);
  });

  it('reads the watch points once per update, and the watched list may be refilled in place between updates', () => {
    const points = [{ x: 0, y: 0, z: -300 }];
    let reads = 0;
    const sys = makeSystem({
      watchPoints: () => {
        reads++;
        return points;
      },
      targets: () => [wall(-100)],
    });
    sys.fire(MUZZLE, zeroVelocity(), BC);
    sys.update(0.05); // 50 substeps: still in the air
    expect(reads).toBe(1);
    points.length = 0; // the sniper went down
    const events: ImpactEvent[] = [];
    for (let i = 0; i < 100 && events.length === 0; i++) events.push(...sys.update(0.016));
    expect(events[0].closestWatchM).toBeGreaterThan(190); // the 50 m flown while he was still up put the bullet 250 m or more away
  });

  it('every bullet has its own closest pass', () => {
    const broad = ball('broad', { x: 0, y: 0, z: -200 }, 10); // wide enough for both bullets
    const sys = makeSystem({ targets: () => [broad], watchPoints: () => [{ x: 0, y: 0, z: -100 }] });
    sys.fire(MUZZLE, zeroVelocity(), BC);
    sys.fire({ ...MUZZLE, x: 5 }, zeroVelocity(), BC);
    const events: ImpactEvent[] = [];
    for (let i = 0; i < 200 && events.length < 2; i++) events.push(...sys.update(0.016));
    expect(events).toHaveLength(2);
    const [straight, wide] = events.sort((a, b) => a.bulletId - b.bulletId);
    expect(straight.closestWatchM).toBeLessThan(0.3);
    expect(wide.closestWatchM).toBeGreaterThan(4.7);
    expect(wide.closestWatchM).toBeLessThan(5.3);
  });
});

describe('pointSegmentDistanceSq', () => {
  const a = { x: 0, y: 0, z: 0 };
  const b = { x: 10, y: 0, z: 0 };

  it('is the perpendicular distance beside the segment', () => {
    expect(pointSegmentDistanceSq({ x: 4, y: 3, z: 0 }, a, b)).toBeCloseTo(9, 12);
    expect(pointSegmentDistanceSq({ x: 4, y: 3, z: 4 }, a, b)).toBeCloseTo(25, 12);
  });

  it('is the distance to the nearer end past either end', () => {
    expect(pointSegmentDistanceSq({ x: 13, y: 4, z: 0 }, a, b)).toBeCloseTo(25, 12);
    expect(pointSegmentDistanceSq({ x: -3, y: 0, z: 4 }, a, b)).toBeCloseTo(25, 12);
  });

  it('is 0 on the segment, and the distance to the point for a segment of no length', () => {
    expect(pointSegmentDistanceSq({ x: 7, y: 0, z: 0 }, a, b)).toBe(0);
    expect(pointSegmentDistanceSq({ x: 3, y: 4, z: 0 }, a, a)).toBeCloseTo(25, 12);
  });
});
