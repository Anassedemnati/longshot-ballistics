import { describe, expect, it } from 'vitest';
import type { ImpactEvent } from '../../src/game/bullets';
import type { ZoneName } from '../../src/game/hit';
import {
  accuracy,
  elapsedMs,
  isComplete,
  markAssistsUsed,
  newStats,
  recordFailure,
  recordImpact,
  recordShot,
  startClock,
} from '../../src/mission/stats';
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
      assistsUsed: false,
      failed: false,
    });
  });
});

describe('markAssistsUsed', () => {
  it('flags the mission once an aim assist was ever on, without touching the rest', () => {
    const s = recordShot(newStats(2, 500));
    const used = markAssistsUsed(s);
    expect(used.assistsUsed).toBe(true);
    expect({ ...used, assistsUsed: false }).toEqual(s);
    expect(s.assistsUsed).toBe(false); // immutable
    expect(markAssistsUsed(used)).toBe(used); // already flagged: same object
  });

  it('survives later shots and impacts', () => {
    let s = markAssistsUsed(newStats(1, 0));
    s = recordShot(s);
    s = recordImpact(s, target('head'), true, 400, 9000);
    expect(s.assistsUsed).toBe(true);
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

describe('a mission with enemy snipers', () => {
  it('counts the snipers among the targets: the total is soldiers + vehicle targets + snipers', () => {
    // 3 soldiers, 1 vehicle target, 2 snipers.
    let s = newStats(6, 0);
    expect(isComplete(s)).toBe(false);
    for (let i = 0; i < 5; i++) s = recordImpact(s, target('upperTorso', `t-${i}`), true, 400, 100 + i);
    expect(s).toMatchObject({ targetsDown: 5, targetsTotal: 6, endMs: null });
    expect(isComplete(s)).toBe(false);
    s = recordImpact(s, target('head', 'sniper-1'), true, 700, 900);
    expect(isComplete(s)).toBe(true);
    expect(s.endMs).toBe(900);
    expect(s.failed).toBe(false);
  });
});

describe('a failed mission', () => {
  it('recordFailure marks it failed and stops the clock at that moment', () => {
    let s = startClock(newStats(4), 1000);
    s = recordShot(s);
    const failed = recordFailure(s, 31_000);
    expect(failed.failed).toBe(true);
    expect(failed.endMs).toBe(31_000);
    expect(elapsedMs(failed)).toBe(30_000);
    expect(failed.shots).toBe(1);
    expect(s.failed).toBe(false); // immutable
  });

  it('is never complete, even when the last target falls afterwards', () => {
    let s = recordFailure(startClock(newStats(1), 0), 5000);
    s = recordImpact(s, target('head'), true, 500, 6000);
    expect(s.targetsDown).toBe(1);
    expect(isComplete(s)).toBe(false);
    expect(s.endMs).toBe(5000);
  });

  it('keeps the first end time when it is failed twice, and does not undo a completed mission', () => {
    const failed = recordFailure(startClock(newStats(2), 0), 4000);
    expect(recordFailure(failed, 9000).endMs).toBe(4000);
    let done = startClock(newStats(1), 0);
    done = recordImpact(done, target('head'), true, 500, 3000);
    expect(isComplete(done)).toBe(true);
    expect(recordFailure(done, 8000)).toBe(done);
  });

  it('with a stopped clock the failed mission lasted 0 s', () => {
    expect(elapsedMs(recordFailure(newStats(2), 8000))).toBe(0);
  });
});
