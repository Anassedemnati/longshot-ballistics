import { describe, expect, it } from 'vitest';
import type { ImpactEvent } from '../../src/game/bullets';
import type { ZoneName } from '../../src/game/hit';
import { accuracy, elapsedMs, isComplete, newStats, recordImpact, recordShot, startClock } from '../../src/mission/stats';
import type { MissionStats } from '../../src/mission/stats';

const P = { x: 0, y: 0, z: -500 };
const target = (zone: ZoneName, id = 'soldier-0'): ImpactEvent => ({
  bulletId: 1,
  kind: 'target',
  targetId: id,
  zone,
  point: P,
  time: 0.9,
});
const obstacle: ImpactEvent = { bulletId: 2, kind: 'obstacle', obstacleId: 'prop-0:0', material: 'wall', point: P, time: 0.8 };
const terrain: ImpactEvent = { bulletId: 3, kind: 'terrain', point: P, time: 1.1 };
const expired: ImpactEvent = { bulletId: 4, kind: 'expired', time: 6 };

describe('newStats', () => {
  it('starts empty with the clock running', () => {
    expect(newStats(5, 1000)).toEqual({
      shots: 0,
      hits: 0,
      headshots: 0,
      targetsDown: 0,
      targetsTotal: 5,
      longestHitM: 0,
      startMs: 1000,
      endMs: null,
    });
  });
});

describe('the mission clock', () => {
  it('is stopped until started: newStats without a time has no start', () => {
    const s = newStats(3);
    expect(s.startMs).toBeNull();
    expect(elapsedMs(s)).toBe(0);
  });

  it('startClock starts it once; a second call keeps the first start', () => {
    const s = newStats(3);
    const started = startClock(s, 5000);
    expect(started.startMs).toBe(5000);
    expect(s.startMs).toBeNull(); // immutable
    expect(startClock(started, 9000)).toBe(started);
    expect(startClock(started, 9000).startMs).toBe(5000);
  });

  it('startClock accepts 0 as a real start time', () => {
    expect(startClock(startClock(newStats(1), 0), 700).startMs).toBe(0);
  });

  it('time is counted from the start, not from when the stats were created (idle time is not mission time)', () => {
    let s = newStats(1); // created at 0 ms, e.g. when the page finished loading
    s = startClock(s, 40_000); // the player's first shot, 40 s later
    s = recordShot(s);
    s = recordImpact(s, target('head'), true, 500, 47_500);
    expect(s.endMs).toBe(47_500);
    expect(elapsedMs(s)).toBe(7_500);
  });

  it('is the time so far (0) while no target has gone down, and never negative', () => {
    expect(elapsedMs(startClock(newStats(2), 1234))).toBe(0);
    expect(elapsedMs({ ...newStats(1, 5000), endMs: 4000 })).toBe(0);
  });

  it('a completed mission whose clock never started reports 0, not NaN', () => {
    const s = recordImpact(newStats(1), target('head'), true, 100, 3000);
    expect(s.endMs).toBe(3000);
    expect(elapsedMs(s)).toBe(0);
  });
});

describe('recordShot', () => {
  it('counts shots and returns a new object', () => {
    const s = newStats(2, 0);
    const next = recordShot(recordShot(s));
    expect(next.shots).toBe(2);
    expect(s.shots).toBe(0);
  });
});

describe('recordImpact', () => {
  it('counts a target hit, a headshot and the longest hit range', () => {
    let s = newStats(3, 0);
    s = recordShot(s);
    s = recordImpact(s, target('head'), true, 734, 2000);
    expect(s).toMatchObject({ shots: 1, hits: 1, headshots: 1, targetsDown: 1, longestHitM: 734, endMs: null });
  });

  it('only the head counts as a headshot', () => {
    let s = newStats(5, 0);
    for (const zone of ['upperTorso', 'lowerTorso', 'limbs', 'engine'] as const) {
      s = recordImpact(s, target(zone), true, 100, 10);
    }
    expect(s.hits).toBe(4);
    expect(s.headshots).toBe(0);
  });

  it('keeps the longest hit when a nearer one comes later', () => {
    let s = newStats(3, 0);
    s = recordImpact(s, target('upperTorso'), true, 900, 10);
    s = recordImpact(s, target('upperTorso'), true, 450, 20);
    expect(s.longestHitM).toBe(900);
    s = recordImpact(s, target('upperTorso'), true, 1200, 30);
    expect(s.longestHitM).toBe(1200);
  });

  it('a hit that does not down the target still counts as a hit but not as a target down', () => {
    const s = recordImpact(newStats(2, 0), target('limbs'), false, 300, 10);
    expect(s).toMatchObject({ hits: 1, targetsDown: 0, longestHitM: 300 });
  });

  it('obstacle, terrain and expired events are not hits', () => {
    let s = newStats(2, 0);
    for (const e of [obstacle, terrain, expired]) s = recordImpact(s, e, false, 800, 10);
    expect(s).toEqual(newStats(2, 0));
  });

  it('even with killed = true an obstacle event downs nothing', () => {
    expect(recordImpact(newStats(2, 0), obstacle, true, 800, 10).targetsDown).toBe(0);
  });

  it('does not change its input', () => {
    const s = newStats(2, 0);
    const copy: MissionStats = { ...s };
    recordImpact(s, target('head'), true, 100, 10);
    expect(s).toEqual(copy);
  });

  it('stamps the end time when the last target goes down, and never moves it', () => {
    let s = newStats(2, 100);
    s = recordImpact(s, target('upperTorso'), true, 500, 1500);
    expect(s.endMs).toBeNull();
    s = recordImpact(s, target('head', 'soldier-1'), true, 600, 2500);
    expect(s.endMs).toBe(2500);
    const later = recordImpact(s, target('head'), true, 600, 9000);
    expect(later.endMs).toBe(2500);
  });

  it('never counts more targets down than there are', () => {
    let s = newStats(1, 0);
    s = recordImpact(s, target('head'), true, 100, 10);
    s = recordImpact(s, target('head'), true, 100, 20);
    expect(s.targetsDown).toBe(1);
  });
});

describe('accuracy', () => {
  it('is hits / shots, and 0 with no shots', () => {
    expect(accuracy(newStats(1, 0))).toBe(0);
    let s = newStats(3, 0);
    for (let i = 0; i < 4; i++) s = recordShot(s);
    s = recordImpact(s, target('upperTorso'), true, 100, 1);
    expect(accuracy(s)).toBeCloseTo(0.25, 12);
  });
});

describe('isComplete', () => {
  it('is true once every target is down', () => {
    let s = newStats(2, 0);
    expect(isComplete(s)).toBe(false);
    s = recordImpact(s, target('upperTorso'), true, 100, 1);
    expect(isComplete(s)).toBe(false);
    s = recordImpact(s, target('upperTorso', 'soldier-1'), true, 100, 2);
    expect(isComplete(s)).toBe(true);
  });

  it('a mission with no targets is never complete (nothing to win)', () => {
    expect(isComplete(newStats(0, 0))).toBe(false);
  });
});

describe('a scripted mission', () => {
  it('shots, hits, headshots, accuracy, longest hit and completion add up', () => {
    let s = newStats(3, 0);
    s = recordShot(s); // 1: terrain miss
    s = recordImpact(s, terrain, false, 700, 1000);
    s = recordShot(s); // 2: cover
    s = recordImpact(s, obstacle, false, 700, 2000);
    s = recordShot(s); // 3: limb hit at 640 m
    s = recordImpact(s, target('limbs'), true, 640, 3000);
    s = recordShot(s); // 4: headshot at 812 m
    s = recordImpact(s, target('head', 'soldier-1'), true, 812, 4000);
    s = recordShot(s); // 5: engine at 590 m
    s = recordImpact(s, target('engine', 'vehicle-0'), true, 590, 5000);
    expect(s).toMatchObject({
      shots: 5,
      hits: 3,
      headshots: 1,
      targetsDown: 3,
      longestHitM: 812,
      endMs: 5000,
    });
    expect(accuracy(s)).toBeCloseTo(0.6, 12);
    expect(isComplete(s)).toBe(true);
  });
});
