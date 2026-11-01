import { describe, expect, it } from 'vitest';
import { STANDARD_ATMO } from '../../src/ballistics/atmosphere';
import { RIFLES } from '../../src/ballistics/rifles';
import { findZeroElevation } from '../../src/ballistics/trajectory';
import type { Vec3, WindField } from '../../src/ballistics/types';
import { BulletSystem } from '../../src/game/bullets';
import type { BulletSystemOptions, ImpactEvent } from '../../src/game/bullets';
import { segmentBox } from '../../src/game/hit';
import type { Box, HitTarget, HitZone, Obstacle } from '../../src/game/hit';

const NO_WIND: WindField = () => ({ x: 0, y: 0, z: 0 });
const RIFLE = RIFLES['308'];
const BC = RIFLE.bcG7;
const MV = RIFLE.muzzleVelocity;
const ZERO_ELEV = findZeroElevation(RIFLE, STANDARD_ATMO);
/** Bore position relative to the line of sight (y = 0). */
const MUZZLE: Vec3 = { x: 0, y: -RIFLE.sightHeight, z: 0 };
const V = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

function makeSystem(overrides: Partial<BulletSystemOptions> = {}): BulletSystem {
  return new BulletSystem({
    atmo: STANDARD_ATMO,
    wind: NO_WIND,
    terrainHeight: () => -100,
    targets: () => [],
    ...overrides,
  });
}

function zeroVelocity(): Vec3 {
  return { x: 0, y: MV * Math.sin(ZERO_ELEV), z: -MV * Math.cos(ZERO_ELEV) };
}

function runUntilEvents(sys: BulletSystem, frameDt: number, maxFrames = 2000): ImpactEvent[] {
  const all: ImpactEvent[] = [];
  for (let i = 0; i < maxFrames && all.length === 0; i++) {
    all.push(...sys.update(frameDt));
  }
  return all;
}

function ball(id: string, center: Vec3, radius: number): HitTarget {
  return { id, zones: [{ name: 'upperTorso', center, radius }] };
}

/** A wall 10 m wide, 10 m tall and 0.3 m thick whose near face is at z = -(range - 0.15). */
function wall(range: number, id = 'wall-1', material: Obstacle['material'] = 'wall'): Obstacle {
  return { id, material, box: { center: V(0, 0, -range), halfSize: V(5, 5, 0.15), yaw: 0 } };
}

describe('segmentBox', () => {
  const AXIS: Box = { center: V(0, 0, -10), halfSize: V(1, 1, 0.5), yaw: 0 };

  it('axis-aligned hit: returns the entry parameter on the near face', () => {
    // z from 0 to -20; the near face is at z = -9.5 -> u = 0.475.
    const u = segmentBox(V(0, 0, 0), V(0, 0, -20), AXIS);
    expect(u).not.toBeNull();
    expect(u as number).toBeCloseTo(0.475, 12);
  });

  it('axis-aligned hit from the other side enters on the far face', () => {
    const u = segmentBox(V(0, 0, -20), V(0, 0, 0), AXIS);
    expect(u as number).toBeCloseTo(0.475, 12);
  });

  it('hits a diagonal segment that clips a corner region', () => {
    // Enters through the side x = -1 at u = 0.5 (z = -10.2, inside the z slab); the z slab ends at u = 0.65.
    const u = segmentBox(V(-3, 0, -9.2), V(1, 0, -11.2), AXIS);
    expect(u).not.toBeNull();
    expect(u as number).toBeCloseTo(0.5, 12);
  });

  it('axis-aligned miss: beside, above, short of, and behind the box', () => {
    expect(segmentBox(V(2, 0, 0), V(2, 0, -20), AXIS)).toBeNull(); // beside
    expect(segmentBox(V(0, 1.5, 0), V(0, 1.5, -20), AXIS)).toBeNull(); // above
    expect(segmentBox(V(0, 0, 0), V(0, 0, -9), AXIS)).toBeNull(); // stops short
    expect(segmentBox(V(0, 0, -11), V(0, 0, -20), AXIS)).toBeNull(); // starts behind it, moving away
  });

  it('returns 0 when the segment starts inside the box', () => {
    expect(segmentBox(V(0.2, -0.3, -10.1), V(0, 0, -30), AXIS)).toBe(0);
  });

  it('handles segments parallel to a slab (zero direction component)', () => {
    // Along X at y = 0, z = -10: inside the y and z slabs the whole way -> enters at x = -1.
    const hit = segmentBox(V(-5, 0, -10), V(5, 0, -10), AXIS);
    expect(hit as number).toBeCloseTo(0.4, 12);
    // Along X but outside the z slab: miss, however long the segment.
    expect(segmentBox(V(-5, 0, -11), V(5, 0, -11), AXIS)).toBeNull();
    // Exactly on a face plane counts as touching (no NaN from 0/0).
    expect(segmentBox(V(-5, 1, -10), V(5, 1, -10), AXIS) as number).toBeCloseTo(0.4, 12);
    // Zero-length segment: inside -> 0, outside -> null.
    expect(segmentBox(V(0, 0, -10), V(0, 0, -10), AXIS)).toBe(0);
    expect(segmentBox(V(0, 0, 0), V(0, 0, 0), AXIS)).toBeNull();
  });

  describe('rotated 45 degrees about +Y (right-handed, like three.js rotation.y)', () => {
    // Thin long box: long axis is local Z. Local +Z maps to world (sin yaw, 0, cos yaw) = (+0.707, 0, +0.707).
    const SQ = Math.SQRT1_2;
    const rotated: Box = { center: V(0, 0, -10), halfSize: V(0.1, 1, 2), yaw: Math.PI / 4 };

    it('hit depends on the yaw sign: the long axis runs along x = z + 10', () => {
      // Crosses the box's centre-line at (1, -9). Entry where local x = 0.707 (x - 1) = -0.1 -> x = 0.8586.
      const a = V(0.5, 0, -9);
      const b = V(1.5, 0, -9);
      const u = segmentBox(a, b, rotated);
      expect(u).not.toBeNull();
      expect(u as number).toBeCloseTo(0.5 - 0.1 * Math.SQRT2, 12);
      // The mirror box (yaw -45 degrees) puts the long axis along x = -(z + 10): the same segment misses.
      expect(segmentBox(a, b, { ...rotated, yaw: -Math.PI / 4 })).toBeNull();
      // And so does the unrotated box (its thin side faces the segment endpoints' x range at z = -9).
      expect(segmentBox(a, b, { ...rotated, yaw: 0 })).toBeNull();
    });

    it('a segment along -Z at x = 1 hits the rotated box but misses it unrotated', () => {
      expect(segmentBox(V(1, 0, 0), V(1, 0, -20), rotated)).not.toBeNull();
      expect(segmentBox(V(1, 0, 0), V(1, 0, -20), { ...rotated, yaw: 0 })).toBeNull();
    });

    it('entry on the rotated face is exact', () => {
      // Along -Z from z = 0 at x = 1, with w = z + 10: local x = SQ * (1 - w) rises from -6.4 and first
      // reaches the -0.1 face at w = 1 + 0.1 / SQ (local z = SQ * (1 + w) = 1.51, inside the 2 m half length).
      const u = segmentBox(V(1, 0, 0), V(1, 0, -20), rotated) as number;
      const w = 1 + 0.1 / SQ;
      expect(u).toBeCloseTo((10 - w) / 20, 12);
    });

    it('misses beyond the end of the long axis', () => {
      // Along -Z at x = 3: the centre-line reaches x = 3 only at s = 4.24 > 2 (plus thickness).
      expect(segmentBox(V(3, 0, 0), V(3, 0, -20), rotated)).toBeNull();
    });

    it('a 90 degree yaw sends local +X (the long axis here) onto the world Z axis', () => {
      const flat: Box = { center: V(0, 0, -10), halfSize: V(3, 1, 0.1), yaw: Math.PI / 2 };
      // The box now spans z in [-13, -7] and only x in [-0.1, 0.1]: a segment along X hits it for |z + 10| < 3.
      expect(segmentBox(V(-5, 0, -8), V(5, 0, -8), flat)).not.toBeNull();
      expect(segmentBox(V(-5, 0, -12.5), V(5, 0, -12.5), flat)).not.toBeNull();
      expect(segmentBox(V(-5, 0, -13.5), V(5, 0, -13.5), flat)).toBeNull();
      expect(segmentBox(V(-5, 0, -6.5), V(5, 0, -6.5), flat)).toBeNull();
      // Unrotated, the same box is 6 m wide in x and thin in z: that last segment would hit at z = -10 only.
      expect(segmentBox(V(-5, 0, -8), V(5, 0, -8), { ...flat, yaw: 0 })).toBeNull();
    });
  });
});

describe('BulletSystem obstacles', () => {
  const RANGE = 400;
  const FACE_Z = -(RANGE - 0.15);

  function fireThrough(sys: BulletSystem, frameDt = 0.016): ImpactEvent {
    sys.fire(MUZZLE, zeroVelocity(), BC);
    const events = runUntilEvents(sys, frameDt, 500);
    expect(events).toHaveLength(1);
    return events[0];
  }

  it('a 0.3 m wall at 400 m stops the bullet at its near face', () => {
    const obstacles = [wall(RANGE)];
    const sys = makeSystem({ obstacles: () => obstacles });
    const id = sys.fire(MUZZLE, zeroVelocity(), BC);
    const events = runUntilEvents(sys, 0.016);
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.kind).toBe('obstacle');
    if (e.kind !== 'obstacle') throw new Error('unreachable');
    expect(e.bulletId).toBe(id);
    expect(e.obstacleId).toBe('wall-1');
    expect(e.material).toBe('wall');
    expect(Math.abs(e.point.z - FACE_Z)).toBeLessThanOrEqual(0.2);
    expect(Math.abs(e.point.x)).toBeLessThan(0.05);
    expect(e.time).toBeGreaterThan(0.5); // ~0.5 s of flight to 400 m
    expect(e.time).toBeLessThan(0.7);
    expect(sys.active).toHaveLength(0);
  });

  it('carries the metal material of a vehicle-style obstacle', () => {
    const sys = makeSystem({ obstacles: () => [wall(RANGE, 'car-1', 'metal')] });
    const e = fireThrough(sys);
    expect(e.kind).toBe('obstacle');
    if (e.kind !== 'obstacle') throw new Error('unreachable');
    expect(e.obstacleId).toBe('car-1');
    expect(e.material).toBe('metal');
  });

  it('a target sphere 2 m behind the wall is not hit, but is hit when the wall is removed', () => {
    // Centre 2 m behind the wall, radius 1.5: its near surface (z = -400.5) is clear of the 0.3 m slab.
    const behind = ball('behind', V(0, 0, -(RANGE + 2)), 1.5);
    // Control: without the wall the shot reaches the sphere.
    const control = fireThrough(makeSystem({ targets: () => [behind] }));
    expect(control.kind).toBe('target');
    // With the wall the same shot stops short of it.
    const e = fireThrough(makeSystem({ targets: () => [behind], obstacles: () => [wall(RANGE)] }));
    expect(e.kind).toBe('obstacle');
  });

  it('a target in front of the wall is hit, not the wall', () => {
    const front = ball('front', V(0, 0, -(RANGE - 10)), 2);
    const e = fireThrough(makeSystem({ targets: () => [front], obstacles: () => [wall(RANGE)] }));
    expect(e.kind).toBe('target');
    if (e.kind !== 'target') throw new Error('unreachable');
    expect(e.targetId).toBe('front');
    expect(e.point.z).toBeGreaterThan(FACE_Z);
  });

  it('a wall beside the flight line does not interfere', () => {
    const aside: Obstacle = { ...wall(RANGE), box: { ...wall(RANGE).box, center: V(20, 0, -RANGE) } };
    const e = fireThrough(makeSystem({ obstacles: () => [aside], terrainHeight: () => -1 }));
    expect(e.kind).toBe('terrain');
  });

  it('terrain crossed before the wall wins; a wall nearer than the crossing wins', () => {
    const ground = fireThrough(makeSystem({ terrainHeight: () => -0.5 }));
    expect(ground.kind).toBe('terrain');
    if (ground.kind !== 'terrain') throw new Error('unreachable');
    expect(ground.point.z).toBeGreaterThan(-(RANGE - 30)); // the ground is reached well before the wall
    const early = fireThrough(makeSystem({ terrainHeight: () => -0.5, obstacles: () => [wall(RANGE)] }));
    expect(early.kind).toBe('terrain');
    const nearWall = wall(Math.abs(ground.point.z) - 20, 'near');
    const e = fireThrough(makeSystem({ terrainHeight: () => -0.5, obstacles: () => [nearWall] }));
    expect(e.kind).toBe('obstacle');
  });

  it('frame spike: update(5) (clamped to 0.1 s) never lets the bullet slip through the wall', () => {
    const obstacles = [wall(RANGE)];
    const sys = makeSystem({ obstacles: () => obstacles });
    sys.fire(MUZZLE, zeroVelocity(), BC);
    expect(sys.update(5)).toEqual([]);
    const events = runUntilEvents(sys, 5, 100);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('obstacle');
  });

  it('coarse 10 ms substeps (~8 m per step) still cannot tunnel a 0.3 m wall', () => {
    const sys = makeSystem({ dt: 0.01, obstacles: () => [wall(RANGE)] });
    const e = fireThrough(sys, 0.1);
    expect(e.kind).toBe('obstacle');
    if (e.kind !== 'obstacle') throw new Error('unreachable');
    expect(Math.abs(e.point.z - FACE_Z)).toBeLessThanOrEqual(0.2);
  });

  it('stops on a wall rotated 45 degrees, near its far end, with the yaw sign respected', () => {
    // Half width 5 along local X; at yaw +45 degrees that axis runs along world (0.707, 0, -0.707), so
    // the wall plane is z = centre.z - x and its end is 3.5 m off the centre. Shot at x = +3.3 (local 4.7).
    const wallAt = (yaw: number): Obstacle => ({
      id: 'diag',
      material: 'wall',
      box: { center: V(0, 0, -RANGE + 3.3), halfSize: V(5, 5, 0.15), yaw },
    });
    const shootAt = (x: number, yaw: number): ImpactEvent => {
      const sys = makeSystem({ obstacles: () => [wallAt(yaw)] });
      sys.fire(V(x, MUZZLE.y, 0), zeroVelocity(), BC);
      return runUntilEvents(sys, 0.016, 500)[0];
    };
    const plus = shootAt(3.3, Math.PI / 4);
    expect(plus.kind).toBe('obstacle');
    if (plus.kind !== 'obstacle') throw new Error('unreachable');
    expect(Math.abs(plus.point.z - -RANGE)).toBeLessThan(0.5); // plane z = -396.7 - 3.3
    // The mirrored wall has its plane at z = centre.z + x: the same shot meets it 6.6 m sooner.
    const minus = shootAt(3.3, -Math.PI / 4);
    expect(minus.kind).toBe('obstacle');
    if (minus.kind !== 'obstacle') throw new Error('unreachable');
    expect(Math.abs(minus.point.z - (-RANGE + 6.6))).toBeLessThan(0.5);
    // Beyond the end of either wall (x = 7.3) the shot is not blocked.
    expect(shootAt(7.3, Math.PI / 4).kind).toBe('terrain');
    expect(shootAt(7.3, -Math.PI / 4).kind).toBe('terrain');
  });

  it('the obstacle list is read once per update() and may be the very same array every frame', () => {
    let reads = 0;
    const obstacles = [wall(RANGE)];
    const sys = makeSystem({
      obstacles: () => {
        reads++;
        return obstacles;
      },
    });
    sys.fire(MUZZLE, zeroVelocity(), BC);
    sys.update(0.05);
    sys.update(0.05);
    expect(reads).toBe(2);
    expect(runUntilEvents(sys, 0.016)[0].kind).toBe('obstacle');
  });

  it('default (no obstacles option) behaves exactly as before', () => {
    const open = ball('t1', V(0, 0, -100), 0.1);
    const a = makeSystem({ targets: () => [open] });
    const b = makeSystem({ targets: () => [open], obstacles: () => [] });
    expect(fireThrough(a)).toEqual(fireThrough(b));
  });

  it('an obstacle far from the path is skipped by the broad phase (its orientation is never read)', () => {
    let yawReads = 0;
    const counting = (center: Vec3): Obstacle => ({
      id: 'counted',
      material: 'wall',
      box: {
        center,
        halfSize: V(2, 2, 2),
        get yaw(): number {
          yawReads++;
          return 0;
        },
      },
    });
    const far = counting(V(50, 0, -200));
    const sys = makeSystem({ obstacles: () => [far], terrainHeight: () => -1.5 });
    expect(fireThrough(sys).kind).toBe('terrain');
    expect(yawReads).toBe(0);
    // Control: the same obstacle on the flight line runs the narrow test and stops the bullet.
    const near = counting(V(0, 0, -200));
    const sys2 = makeSystem({ obstacles: () => [near] });
    expect(fireThrough(sys2).kind).toBe('obstacle');
    expect(yawReads).toBeGreaterThan(0);
  });
});

describe('HitTarget bounds (broad phase)', () => {
  /** A 66-sphere "soldier" along -Z whose winning zone (head) is not the first in the list. */
  function soldier(id: string, x: number, z: number, withBounds: boolean): HitTarget {
    const zones: HitZone[] = [];
    for (let i = 0; i < 65; i++) {
      zones.push({
        name: i % 2 ? 'limbs' : 'lowerTorso',
        center: V(x + 0.5 + 0.01 * i, -3 - 0.01 * i, z), // well off the flight line
        radius: 0.05,
      });
    }
    zones.push({ name: 'head', center: V(x, 0, z - 0.3), radius: 0.1 });
    zones.push({ name: 'upperTorso', center: V(x, 0, z - 0.7), radius: 0.15 });
    const target: HitTarget = { id, zones };
    return withBounds ? { ...target, bounds: { center: V(x, -1, z - 0.4), radius: 3.5 } } : target;
  }

  function fly(targets: HitTarget[], dt?: number): ImpactEvent {
    const sys = makeSystem({ targets: () => targets, dt });
    sys.fire(MUZZLE, zeroVelocity(), BC);
    return runUntilEvents(sys, 0.016)[0];
  }

  it('a target with bounds is hit exactly as without: same zone, same event', () => {
    const plain = fly([soldier('s', 0, -150, false)]);
    const bounded = fly([soldier('s', 0, -150, true)]);
    expect(plain.kind).toBe('target');
    if (plain.kind !== 'target') throw new Error('unreachable');
    expect(plain.zone).toBe('head');
    expect(bounded).toEqual(plain);
  });

  it('the same holds with coarse 10 ms substeps', () => {
    expect(fly([soldier('s', 0, -150, true)], 0.01)).toEqual(fly([soldier('s', 0, -150, false)], 0.01));
  });

  it('skips the zones entirely unless the path touches the bounds sphere', () => {
    let reads = 0;
    const counting = (t: HitTarget): HitTarget => ({
      id: t.id,
      bounds: t.bounds,
      get zones(): HitZone[] {
        reads++;
        return t.zones;
      },
    });
    // Off to the side, 30 m from the flight line, bounds radius 3.5.
    fly([counting(soldier('side', 30, -150, true))]);
    expect(reads).toBe(0);
    // Control: no bounds -> zones are read on every substep.
    reads = 0;
    fly([counting(soldier('side', 30, -150, false))]);
    expect(reads).toBeGreaterThan(100);
    // Control: bounds on the flight line -> zones are read (only near the soldier).
    reads = 0;
    const e = fly([counting(soldier('on', 0, -150, true))]);
    expect(e.kind).toBe('target');
    expect(reads).toBeGreaterThan(0);
    expect(reads).toBeLessThan(20);
  });

  it('ten bounded soldiers plus twelve walls: five bullets resolve exactly as with the brute-force path', () => {
    const build = (withBounds: boolean): HitTarget[] => {
      const list: HitTarget[] = [];
      for (let i = 0; i < 10; i++) list.push(soldier(`s${i}`, (i - 5) * 4, -150 - 5 * i, withBounds));
      list[5] = soldier('s5', 0, -200, withBounds); // the one on the flight line (x = 0)
      return list;
    };
    const walls: Obstacle[] = [];
    for (let i = 0; i < 12; i++) {
      walls.push({ id: `w${i}`, material: 'wall', box: { center: V(30 + 12 * i, 0, -250), halfSize: V(5, 5, 0.15), yaw: 0 } });
    }
    const run = (targets: HitTarget[], obstacles: Obstacle[]): ImpactEvent[] => {
      const sys = makeSystem({ targets: () => targets, obstacles: () => obstacles });
      for (let k = 0; k < 5; k++) sys.fire(MUZZLE, zeroVelocity(), BC);
      const events: ImpactEvent[] = [];
      for (let i = 0; i < 200 && events.length < 5; i++) events.push(...sys.update(0.016));
      return events;
    };
    const fast = run(build(true), walls);
    expect(fast).toHaveLength(5);
    for (const e of fast) {
      expect(e.kind).toBe('target');
      if (e.kind === 'target') expect(e.targetId).toBe('s5');
    }
    expect(fast).toEqual(run(build(false), []));
  });
});
