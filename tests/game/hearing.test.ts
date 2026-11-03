import { describe, expect, it } from 'vitest';
import { DESERT_ATMO, makeAtmosphere } from '../../src/ballistics/atmosphere';
import { RIFLES } from '../../src/ballistics/rifles';
import { simulateToRanges } from '../../src/ballistics/trajectory';
import type { Atmosphere, Rifle, Vec3, WindField } from '../../src/ballistics/types';
import { BulletSystem } from '../../src/game/bullets';
import type { BulletPass, ImpactEvent } from '../../src/game/bullets';
import { CueQueue, HEARING, crackDelay, crackHeard, reportArrival } from '../../src/game/hearing';
import type { Cue } from '../../src/game/hearing';

// The hearing model (game/hearing.ts) and the closest passes the bullets measure for it (game/bullets.ts): when the report, the crack and the
// impact of a shot reach the men it is fired at, flown through the real G7/RK4 ballistics.

const NO_WIND: WindField = () => ({ x: 0, y: 0, z: 0 });
const FLAT_FAR_BELOW = (): number => -1000;
/** The arctic theme's air: the coldest, so the slowest sound of the three. */
const ARCTIC_ATMO = makeAtmosphere(-15, 1013.25);

/** Barrel elevation (rad) that puts the bullet on the line of sight (y = 0) at `range`, from (0, -sightHeight, 0) along -Z. */
function elevationFor(rifle: Rifle, atmo: Atmosphere, range: number): number {
  let lo = -0.05;
  let hi = 0.2;
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi);
    const [sample] = simulateToRanges(rifle, atmo, NO_WIND, mid, [range]);
    if (sample !== undefined && sample.height >= 0) hi = mid;
    else lo = mid;
  }
  return 0.5 * (lo + hi);
}

interface Flight {
  impact: ImpactEvent;
  passes: BulletPass[];
}

/** Fire `rifle` from the origin at a man (a 0.25 m sphere) at `range` straight down -Z, with listeners at `listeners`; fly it to its end. */
function fly(rifle: Rifle, atmo: Atmosphere, range: number, listeners: Vec3[]): Flight {
  const target: Vec3 = { x: 0, y: 0, z: -range };
  const bullets = new BulletSystem({
    atmo,
    wind: NO_WIND,
    terrainHeight: FLAT_FAR_BELOW,
    targets: () => [{ id: 'man', zones: [{ name: 'upperTorso', center: target, radius: 0.25 }] }],
    listeners: () => listeners,
    passRadiusM: HEARING.crackRadiusM,
    maxFlightTime: 10,
  });
  const e = elevationFor(rifle, atmo, range);
  bullets.fire({ x: 0, y: -rifle.sightHeight, z: 0 }, { x: 0, y: rifle.muzzleVelocity * Math.sin(e), z: -rifle.muzzleVelocity * Math.cos(e) }, rifle.bcG7);
  const passes: BulletPass[] = [];
  for (let i = 0; i < 2000; i++) {
    const events = bullets.update(0.016);
    for (const p of bullets.passes) passes.push({ ...p });
    if (events.length > 0) return { impact: events[0], passes };
  }
  throw new Error('the bullet never ended');
}

/** The earliest moment, s after the shot, any cue of it reaches a listener at `listener` (Infinity: none does). */
function firstCue(flight: Flight, listenerIndex: number, listener: Vec3, atmo: Atmosphere, suppressed: boolean): number {
  let first = Infinity;
  const report = reportArrival(Math.hypot(listener.x, listener.y, listener.z), atmo.speedOfSound, suppressed);
  if (report) first = report.delayS;
  for (const p of flight.passes) {
    if (p.listener === listenerIndex && crackHeard(p.distanceM, p.speed, atmo.speedOfSound)) first = Math.min(first, crackDelay(p.time, p.distanceM, atmo.speedOfSound));
  }
  return first;
}

describe('the hearing model', () => {
  it('a supersonic first shot always lands before the man it is fired at, or the guard beside him, hears anything', () => {
    const rifle = RIFLES['308'];
    for (const atmo of [DESERT_ATMO, ARCTIC_ATMO]) {
      for (const range of [100, 300, 600, 800, 1000]) {
        const man: Vec3 = { x: 0, y: 0, z: -range };
        const guard: Vec3 = { x: 3, y: 0, z: -range - 1 };
        const flight = fly(rifle, atmo, range, [man, guard]);
        expect(flight.impact.kind, `${range} m`).toBe('target');
        for (const [i, who] of [man, guard].entries()) {
          for (const suppressed of [false, true]) {
            expect(firstCue(flight, i, who, atmo, suppressed), `${range} m, listener ${i}, suppressed ${suppressed}`).toBeGreaterThanOrEqual(flight.impact.time);
          }
        }
      }
    }
  });

  it("an unsuppressed subsonic shot's report reaches the target before its own bullet, which never cracks", () => {
    const rifle = RIFLES['127s'];
    let lead = 0;
    for (const range of [100, 200, 300]) {
      const man: Vec3 = { x: 0, y: 0, z: -range };
      const flight = fly(rifle, DESERT_ATMO, range, [man]);
      expect(flight.impact.kind).toBe('target');
      const report = reportArrival(range, DESERT_ATMO.speedOfSound, false);
      expect(report).not.toBeNull();
      expect(report?.directional).toBe(true);
      // The farther he is, the longer he has between the report and the bullet: at 300 m about a fifth of a second to start moving.
      const now = flight.impact.time - (report?.delayS ?? Infinity);
      expect(now).toBeGreaterThan(lead);
      lead = now;
      for (const p of flight.passes) expect(crackHeard(p.distanceM, p.speed, DESERT_ATMO.speedOfSound)).toBe(false);
    }
    expect(lead).toBeGreaterThan(0.15);
  });

  it('a suppressed shot beyond the report range is not heard at all: only a crack or an impact can alarm', () => {
    const c = DESERT_ATMO.speedOfSound;
    expect(reportArrival(HEARING.suppressedReportM + 1, c, true)).toBeNull();
    expect(reportArrival(600, c, true)).toBeNull();
    // Inside the range a weak cue that gives no direction; unsuppressed, a directional report at any mission range.
    expect(reportArrival(150, c, true)).toEqual({ delayS: 150 / c, directional: false });
    expect(reportArrival(1500, c, false)).toEqual({ delayS: 1500 / c, directional: true });
    // A suppressed supersonic .308 at 600 m still cracks past a guard 10 m from its target.
    const guard: Vec3 = { x: 10, y: 0, z: -600 };
    const flight = fly(RIFLES['308'], DESERT_ATMO, 600, [guard]);
    expect(Number.isFinite(firstCue(flight, 0, guard, DESERT_ATMO, true))).toBe(true);
    // A listener 40 m from the path hears nothing from a suppressed shot at that range.
    const far: Vec3 = { x: 40, y: 0, z: -600 };
    expect(firstCue(fly(RIFLES['308'], DESERT_ATMO, 600, [far]), 0, far, DESERT_ATMO, true)).toBe(Infinity);
  });

  it('the .308 is supersonic to past 800 m and goes transonic before 1200 m; the crack follows it', () => {
    const rifle = RIFLES['308'];
    const [at800, at1200] = simulateToRanges(rifle, DESERT_ATMO, NO_WIND, elevationFor(rifle, DESERT_ATMO, 1200), [800, 1200]);
    expect(at800.velocity).toBeGreaterThan(DESERT_ATMO.speedOfSound);
    expect(at1200.velocity).toBeLessThan(DESERT_ATMO.speedOfSound);
    expect(crackHeard(10, at800.velocity, DESERT_ATMO.speedOfSound)).toBe(true);
    expect(crackHeard(10, at1200.velocity, DESERT_ATMO.speedOfSound)).toBe(false);
    expect(crackHeard(HEARING.crackRadiusM + 1, 800, DESERT_ATMO.speedOfSound)).toBe(false);
  });

  it('the cue queue hands each cue out once, in arrival order, when its time has come', () => {
    const q = new CueQueue<'a' | 'b'>();
    const cue = (at: number, group: 'a' | 'b'): Cue<'a' | 'b'> => ({ kind: 'report', group, at, directional: true, suppressed: false });
    q.schedule(cue(2, 'a'));
    q.schedule(cue(0.5, 'b'));
    q.schedule(cue(1, 'a'));
    q.schedule(cue(NaN, 'a'));
    const got: number[] = [];
    q.deliver(0.4, (c) => got.push(c.at));
    expect(got).toEqual([]);
    q.deliver(1, (c) => got.push(c.at));
    expect(got).toEqual([0.5, 1]);
    q.deliver(10, (c) => got.push(c.at));
    expect(got).toEqual([0.5, 1, 2]);
    expect(q.pending).toBe(0);
  });
});

describe('closest passes measured by the bullets', () => {
  it('reports the distance, flight time and speed at the closest pass once, as the bullet goes by', () => {
    const rifle = RIFLES['308'];
    const listener: Vec3 = { x: 10, y: 0, z: -300 };
    const flight = fly(rifle, DESERT_ATMO, 600, [listener]);
    expect(flight.passes).toHaveLength(1);
    const [p] = flight.passes;
    const [at300] = simulateToRanges(rifle, DESERT_ATMO, NO_WIND, elevationFor(rifle, DESERT_ATMO, 600), [300]);
    expect(p.distanceM).toBeGreaterThan(9.5);
    expect(p.distanceM).toBeLessThan(10.5);
    expect(p.time).toBeCloseTo(at300.time, 2);
    expect(p.speed).toBeGreaterThan(at300.velocity - 3);
    expect(p.speed).toBeLessThan(at300.velocity + 3);
    // Reported as soon as the bullet is past him, long before it lands.
    expect(p.time).toBeLessThan(flight.impact.time - 0.3);
  });

  it('reports nothing for a listener beyond the radius, and nothing without listeners', () => {
    expect(fly(RIFLES['308'], DESERT_ATMO, 600, [{ x: 40, y: 0, z: -300 }]).passes).toHaveLength(0);
    expect(fly(RIFLES['308'], DESERT_ATMO, 600, []).passes).toHaveLength(0);
  });

  it('reuses its pass records from frame to frame (no allocation per frame)', () => {
    const listeners: Vec3[] = [{ x: 5, y: 0, z: -100 }];
    const bullets = new BulletSystem({ atmo: DESERT_ATMO, wind: NO_WIND, terrainHeight: FLAT_FAR_BELOW, targets: () => [], listeners: () => listeners });
    const list = bullets.passes;
    const seen = new Set<BulletPass>();
    for (let shot = 0; shot < 3; shot++) {
      bullets.fire({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -800 }, 0.24);
      for (let i = 0; i < 60; i++) {
        bullets.update(0.016);
        for (const p of bullets.passes) seen.add(p);
      }
    }
    expect(bullets.passes).toBe(list);
    expect(seen.size).toBe(1); // three passes, one record
  });
});
