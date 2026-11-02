import { describe, expect, it } from 'vitest';
import { DESERT_ATMO } from '../../src/ballistics/atmosphere';
import { RIFLES } from '../../src/ballistics/rifles';
import { findZeroElevation } from '../../src/ballistics/trajectory';
import type { Vec3, WindField } from '../../src/ballistics/types';
import { muzzleLaunch } from '../../src/game/aim';
import {
  aimOffsetMil,
  createPathBuffer,
  levelUp,
  nearestToCrosshair,
  predictPath,
  solveAim,
  spotterCall,
  spotterText,
} from '../../src/game/assistance';
import { BulletSystem } from '../../src/game/bullets';
import type { ImpactEvent } from '../../src/game/bullets';
import { windVector } from '../../src/mission/config';
import { UPPER_TORSO_CY } from '../../src/mission/dummyDims';
import { createTargetDummy } from '../../src/scene/target';

const DEG = Math.PI / 180;
const RIFLE_IDS = ['308', '338'] as const;
const ATMO = DESERT_ATMO;
const WIND_SPEED = 4.5;
const FLAT = (): number => 0;
/** A ridge-top eye over flat ground: every shot is a little downhill, like the game's elevated positions. */
const EYE: Vec3 = { x: 0, y: 12.4, z: 0 };

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
const unit = (a: Vec3): Vec3 => {
  const l = len(a);
  return { x: a.x / l, y: a.y / l, z: a.z / l };
};
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const windOf = (speed: number, clock: number): WindField => {
  const v = windVector(speed, clock);
  return () => v;
};
const setup = (id: (typeof RIFLE_IDS)[number]) => {
  const rifle = RIFLES[id];
  return { rifle, zero: findZeroElevation(rifle, ATMO) };
};

/** A point `range` m away from the eye along `bearingDeg` (0 = straight downrange, positive = to the right), on the ground. */
function groundPoint(range: number, bearingDeg: number): Vec3 {
  return { x: range * Math.sin(bearingDeg * DEG), y: 0, z: -range * Math.cos(bearingDeg * DEG) };
}

/** Fire along `dir` exactly as the game's fire() does (level view up) and return the first impact event. */
function shoot(
  dir: Vec3,
  rifleId: (typeof RIFLE_IDS)[number],
  wind: WindField,
  opts: { height?: (x: number, z: number) => number; dummy?: ReturnType<typeof createTargetDummy> },
): ImpactEvent {
  const { rifle, zero } = setup(rifleId);
  const bullets = new BulletSystem({
    atmo: ATMO,
    wind,
    terrainHeight: opts.height ?? FLAT,
    targets: () => (opts.dummy ? [opts.dummy.hitTarget] : []),
  });
  const { origin, velocity } = muzzleLaunch(EYE, dir, levelUp(dir), rifle, zero);
  bullets.fire(origin, velocity, rifle.bcG7);
  for (let i = 0; i < 400; i++) {
    const events = bullets.update(0.016);
    if (events.length > 0) return events[0];
  }
  throw new Error('the bullet neither hit nor expired');
}

describe('levelUp', () => {
  it('is the roll-free camera up: unit, perpendicular to the view, in the vertical plane', () => {
    for (const [yaw, pitch] of [[0, 0], [0.4, -0.2], [-2.5, 0.7], [3, -1.2]]) {
      const forward = { x: -Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(yaw) * Math.cos(pitch) };
      const up = levelUp(forward);
      expect(len(up)).toBeCloseTo(1, 12);
      expect(dot(up, forward)).toBeCloseTo(0, 12);
      // What the YXZ camera with no roll gives: R_y(yaw) R_x(pitch) (0, 1, 0).
      expect(up.x).toBeCloseTo(Math.sin(yaw) * Math.sin(pitch), 12);
      expect(up.y).toBeCloseTo(Math.cos(pitch), 12);
      expect(up.z).toBeCloseTo(Math.cos(yaw) * Math.sin(pitch), 12);
    }
  });

  it('refuses a view straight up or down', () => {
    expect(() => levelUp({ x: 0, y: 1, z: 0 })).toThrow();
  });
});

describe('predictPath', () => {
  it('lands where a real BulletSystem shot lands (within 5 cm at 800 m), in a crosswind and over sloping ground', () => {
    // Pitches (view down from the 12.4 m eye) that bring each rifle's shot to the ground about 800 m out.
    for (const [id, pitch] of [['308', -0.0046], ['338', -0.008]] as const) {
      const { rifle, zero } = setup(id);
      const wind = windOf(WIND_SPEED, 9);
      // The ground rises a little away from the shooter, so the bullet meets it about 800 m out.
      const ground = (x: number, z: number): number => -z * 0.004 - 2 + 0.002 * x;
      const forward = unit({ x: 0.02, y: pitch, z: -1 });
      const up = levelUp(forward);
      const path = predictPath(EYE, forward, up, rifle, ATMO, wind, zero, { groundHeight: ground, maxRange: 3000 });
      expect(path.impact).not.toBeNull();
      const impact = path.impact as Vec3;
      expect(Math.hypot(impact.x - EYE.x, impact.z - EYE.z)).toBeGreaterThan(780);
      expect(Math.hypot(impact.x - EYE.x, impact.z - EYE.z)).toBeLessThan(820);
      expect(Math.abs(impact.y - ground(impact.x, impact.z))).toBeLessThan(0.01);

      const bullets = new BulletSystem({ atmo: ATMO, wind, terrainHeight: ground, targets: () => [] });
      const { origin, velocity } = muzzleLaunch(EYE, forward, up, rifle, zero);
      bullets.fire(origin, velocity, rifle.bcG7);
      let event: ImpactEvent | undefined;
      for (let i = 0; i < 400 && !event; i++) event = bullets.update(0.016)[0];
      expect(event?.kind).toBe('terrain');
      if (event?.kind !== 'terrain') return;
      expect(len(sub(impact, event.point))).toBeLessThan(0.05);
      expect(Math.abs(path.time - event.time)).toBeLessThan(0.002);

      // The drawn line's coarser 5 ms step (5x cheaper) stays within the same 5 cm.
      const drawn = predictPath(EYE, forward, up, rifle, ATMO, wind, zero, { groundHeight: ground, maxRange: 3000, dt: 0.005, sampleEvery: 2 });
      expect(len(sub(drawn.impact as Vec3, event.point))).toBeLessThan(0.05);
      expect(Math.abs(drawn.points.length - path.points.length)).toBeLessThanOrEqual(2); // a vertex per 10 ms either way
    }
  });

  it('draws the path from the bore to the impact: ascending distances, the last point is the impact', () => {
    const { rifle, zero } = setup('308');
    const forward = unit({ x: 0, y: 0.002, z: -1 });
    const path = predictPath(EYE, forward, levelUp(forward), rifle, ATMO, windOf(0, 12), zero, { groundHeight: FLAT });
    expect(path.points.length).toBeGreaterThan(20);
    expect(path.points[0].y).toBeCloseTo(EYE.y - rifle.sightHeight, 3);
    const last = path.points[path.points.length - 1];
    expect(last).toEqual(path.impact);
    for (let i = 1; i < path.points.length; i++) expect(path.points[i].z).toBeLessThanOrEqual(path.points[i - 1].z);
  });

  it('ends at the range plane along the bearing when the ground is never reached, with no impact', () => {
    const { rifle, zero } = setup('338');
    const bearing = unit({ x: 0.14, y: 0, z: -0.99 });
    const forward = unit({ x: 0.14, y: 0.001, z: -0.99 });
    const path = predictPath(EYE, forward, levelUp(forward), rifle, ATMO, windOf(0, 12), zero, {
      groundHeight: () => -1000,
      maxRange: 600,
      bearing,
    });
    expect(path.impact).toBeNull();
    expect(path.atRange).not.toBeNull();
    const end = path.atRange as Vec3;
    expect((end.x - EYE.x) * bearing.x + (end.z - EYE.z) * bearing.z).toBeCloseTo(600, 6);
    expect(path.points[path.points.length - 1]).toEqual(end);
    expect(path.time).toBeGreaterThan(0.6);
    expect(path.time).toBeLessThan(0.9);
  });

  it('always ends: a shot fired backwards or straight up is cut by the range or the time limit', () => {
    const { rifle, zero } = setup('308');
    for (const forward of [unit({ x: 0, y: 0.1, z: 1 }), unit({ x: 0.1, y: 1, z: 0 })]) {
      const path = predictPath(EYE, forward, levelUp(forward), rifle, ATMO, windOf(0, 12), zero, { groundHeight: FLAT });
      expect(path.time).toBeLessThanOrEqual(6.01);
      expect(path.points.length).toBeLessThan(1000);
    }
  });

  it('with a buffer it writes the same points into preallocated vectors, call after call', () => {
    const { rifle, zero } = setup('308');
    const forward = unit({ x: 0.02, y: 0.003, z: -1 });
    const up = levelUp(forward);
    const options = { groundHeight: FLAT, dt: 0.005, sampleEvery: 2 };
    const plain = predictPath(EYE, forward, up, rifle, ATMO, windOf(3, 9), zero, options);
    expect(plain.count).toBe(plain.points.length);

    const buffer = createPathBuffer(700);
    const slots = [...buffer.points];
    const a = predictPath(EYE, forward, up, rifle, ATMO, windOf(3, 9), zero, { ...options, buffer });
    expect(a.points).toBe(buffer.points);
    expect(a.count).toBe(plain.count);
    for (let i = 0; i < a.count; i++) expect(a.points[i], `point ${i}`).toEqual(plain.points[i]);
    expect(a.impact).toEqual(plain.impact);

    // A second flight (another direction) reuses the very same objects: nothing is allocated per point.
    const other = unit({ x: -0.05, y: 0.001, z: -1 });
    const b = predictPath(EYE, other, levelUp(other), rifle, ATMO, windOf(3, 9), zero, { ...options, buffer });
    expect(buffer.points).toHaveLength(slots.length);
    buffer.points.forEach((p, i) => expect(p).toBe(slots[i]));
    const plainOther = predictPath(EYE, other, levelUp(other), rifle, ATMO, windOf(3, 9), zero, options);
    expect(b.count).toBe(plainOther.count);
    expect(b.points[b.count - 1]).toEqual(plainOther.points[plainOther.count - 1]);
  });

  it('a buffer that is too small keeps the first points and says how many it holds', () => {
    const { rifle, zero } = setup('308');
    const forward = unit({ x: 0, y: 0.002, z: -1 });
    const full = predictPath(EYE, forward, levelUp(forward), rifle, ATMO, windOf(0, 12), zero, { groundHeight: FLAT });
    const small = createPathBuffer(10);
    const cut = predictPath(EYE, forward, levelUp(forward), rifle, ATMO, windOf(0, 12), zero, { groundHeight: FLAT, buffer: small });
    expect(cut.count).toBe(10);
    for (let i = 0; i < 10; i++) expect(cut.points[i]).toEqual(full.points[i]);
  });
});

describe('solveAim', () => {
  const cases: Array<{ id: (typeof RIFLE_IDS)[number]; clock: number; range: number; bearing: number }> = [];
  for (const id of RIFLE_IDS) {
    for (const clock of [9, 3]) {
      for (const range of [300, 800, 1200]) {
        for (const bearing of [0, 8]) cases.push({ id, clock, range, bearing });
      }
    }
  }

  for (const { id, clock, range, bearing } of cases) {
    it(`a real shot along the solved direction hits the chest: .${id} at ${range} m, ${bearing} deg off axis, ${WIND_SPEED} m/s from ${clock} o'clock`, () => {
      const { rifle, zero } = setup(id);
      const wind = windOf(WIND_SPEED, clock);
      const ground = groundPoint(range, bearing);
      const dummy = createTargetDummy(ground, 0);
      const chest = { x: ground.x, y: ground.y + UPPER_TORSO_CY, z: ground.z };

      const dir = solveAim(EYE, chest, rifle, ATMO, wind, zero);
      expect(dir).not.toBeNull();
      const event = shoot(dir as Vec3, id, wind, { dummy });
      expect(event.kind).toBe('target');
      if (event.kind !== 'target') return;
      expect(event.targetId).toBe('dummy');
      expect(event.zone).toBe('upperTorso');

      // Not vacuous: without the correction (crosshair on the chest) the same shot is badly off at long range.
      if (range >= 800) {
        const plain = shoot(unit(sub(chest, EYE)), id, wind, { dummy });
        expect(plain.kind === 'target' && plain.zone === 'upperTorso').toBe(false);
      }
    });
  }

  it('converges to within a few mm of the target plane point', () => {
    const { rifle, zero } = setup('308');
    const wind = windOf(WIND_SPEED, 9);
    const chest = { x: 100, y: 1.4, z: -800 };
    const dir = solveAim(EYE, chest, rifle, ATMO, wind, zero) as Vec3;
    const horizontal = Math.hypot(chest.x - EYE.x, chest.z - EYE.z);
    const bearing = { x: (chest.x - EYE.x) / horizontal, y: 0, z: (chest.z - EYE.z) / horizontal };
    const path = predictPath(EYE, dir, levelUp(dir), rifle, ATMO, wind, zero, { maxRange: horizontal, bearing });
    expect(path.atRange).not.toBeNull();
    expect(len(sub(path.atRange as Vec3, chest))).toBeLessThan(0.01);
  });

  it('holds high and into the wind: left for wind from 9 (it blows the bullet right), right for wind from 3', () => {
    const { rifle, zero } = setup('308');
    const chest = { x: 0, y: UPPER_TORSO_CY, z: -800 };
    const sight = unit(sub(chest, EYE));
    const up = levelUp(sight);
    const fromLeft = aimOffsetMil(sight, up, solveAim(EYE, chest, rifle, ATMO, windOf(WIND_SPEED, 9), zero) as Vec3);
    const fromRight = aimOffsetMil(sight, up, solveAim(EYE, chest, rifle, ATMO, windOf(WIND_SPEED, 3), zero) as Vec3);
    expect(fromLeft.upMil).toBeGreaterThan(3);
    expect(fromLeft.rightMil).toBeLessThan(-0.3);
    expect(fromRight.rightMil).toBeGreaterThan(0.3);
    expect(fromRight.rightMil).toBeCloseTo(-fromLeft.rightMil, 1);
    expect(fromRight.upMil).toBeCloseTo(fromLeft.upMil, 1);
  });

  it('gives no solution for a target out of the bullet\'s reach or straight overhead', () => {
    const { rifle, zero } = setup('308');
    const calm = windOf(0, 12);
    expect(solveAim(EYE, { x: 0, y: 0, z: -40000 }, rifle, ATMO, calm, zero)).toBeNull();
    expect(solveAim(EYE, { x: 0, y: 50, z: 0 }, rifle, ATMO, calm, zero)).toBeNull();
  });
});

describe('spotter', () => {
  it('measures the solved direction against the crosshair in the reticle\'s own frame (up, right)', () => {
    const forward = unit({ x: -0.3, y: -0.05, z: -0.95 });
    const up = levelUp(forward);
    const right = unit(cross(forward, up));
    // A direction 1.2 mil above and 0.4 mil to the left of the view axis, built from the axes.
    const solved = unit({
      x: forward.x + Math.tan(1.2e-3) * up.x - Math.tan(0.4e-3) * right.x,
      y: forward.y + Math.tan(1.2e-3) * up.y - Math.tan(0.4e-3) * right.y,
      z: forward.z + Math.tan(1.2e-3) * up.z - Math.tan(0.4e-3) * right.z,
    });
    const offset = aimOffsetMil(forward, up, solved);
    expect(offset.upMil).toBeCloseTo(1.2, 6);
    expect(offset.rightMil).toBeCloseTo(-0.4, 6);
    expect(spotterCall(forward, up, solved)).toBe('Hold 1.2 mil high, 0.4 mil left');
  });

  it('matches the solved offset to 0.05 mil for real solutions (the vertical against the elevation difference)', () => {
    for (const id of RIFLE_IDS) {
      for (const [range, bearing, clock] of [[300, 0, 9], [800, 8, 3], [1200, -6, 9]] as const) {
        const { rifle, zero } = setup(id);
        const ground = groundPoint(range, bearing);
        const chest = { x: ground.x, y: UPPER_TORSO_CY, z: ground.z };
        const sight = unit(sub(chest, EYE));
        const up = levelUp(sight);
        const solved = solveAim(EYE, chest, rifle, ATMO, windOf(WIND_SPEED, clock), zero) as Vec3;
        const offset = aimOffsetMil(sight, up, solved);

        // Independent of the formula: the solved direction's elevation above the sight line, from the y components.
        const elevationMil = (Math.asin(solved.y) - Math.asin(sight.y)) * 1000;
        expect(Math.abs(offset.upMil - elevationMil)).toBeLessThan(0.05);
        // And horizontally the bearing difference, scaled by cos(pitch) into the view's frame.
        const bearingOf = (v: Vec3): number => Math.atan2(v.x, -v.z);
        const swingMil = (bearingOf(solved) - bearingOf(sight)) * Math.cos(Math.asin(sight.y)) * 1000;
        expect(Math.abs(offset.rightMil - swingMil)).toBeLessThan(0.05);

        // The call reads the same numbers, to the tenth.
        const text = spotterCall(sight, up, solved);
        const high = /([\d.]+) mil (high|low)/.exec(text);
        const side = /([\d.]+) mil (left|right)/.exec(text);
        expect(high).not.toBeNull();
        expect(Math.abs((high?.[2] === 'high' ? 1 : -1) * Number(high?.[1]) - offset.upMil)).toBeLessThan(0.051);
        if (side) expect(Math.abs((side[2] === 'right' ? 1 : -1) * Number(side[1]) - offset.rightMil)).toBeLessThan(0.051);
      }
    }
  });

  it('formats the call: high or low, left or right, only the parts that matter, "On target" when both are nil', () => {
    expect(spotterText({ upMil: 1.24, rightMil: 0.36 })).toBe('Hold 1.2 mil high, 0.4 mil right');
    expect(spotterText({ upMil: -3.04, rightMil: -0.7 })).toBe('Hold 3.0 mil low, 0.7 mil left');
    expect(spotterText({ upMil: 2.5, rightMil: 0.02 })).toBe('Hold 2.5 mil high');
    expect(spotterText({ upMil: -0.01, rightMil: 0.6 })).toBe('Hold 0.6 mil right');
    expect(spotterText({ upMil: 0.03, rightMil: -0.04 })).toBe('On target');
    expect(spotterText(null)).toBe('No solution');
  });

  it('says "On target" when the crosshair already is on the solved direction', () => {
    const { rifle, zero } = setup('308');
    const chest = { x: 0, y: UPPER_TORSO_CY, z: -500 };
    const solved = solveAim(EYE, chest, rifle, ATMO, windOf(0, 12), zero) as Vec3;
    expect(spotterCall(solved, levelUp(solved), solved)).toBe('On target');
  });
});

describe('nearestToCrosshair', () => {
  const targets = [
    { id: 'left', point: { x: -60, y: 0, z: -300 } },
    { id: 'centre', point: { x: 5, y: 0, z: -900 } },
    { id: 'right', point: { x: 80, y: 0, z: -300 } },
  ];

  it('picks the target at the smallest angle from the crosshair, whatever its range', () => {
    expect(nearestToCrosshair(EYE, { x: 0, y: 0, z: -1 }, targets)?.id).toBe('centre');
    expect(nearestToCrosshair(EYE, unit({ x: 1, y: 0, z: -3 }), targets)?.id).toBe('right');
    expect(nearestToCrosshair(EYE, unit({ x: -1, y: 0, z: -4 }), targets)?.id).toBe('left');
  });

  it('is null with nothing to pick', () => {
    expect(nearestToCrosshair(EYE, { x: 0, y: 0, z: -1 }, [])).toBeNull();
  });
});
