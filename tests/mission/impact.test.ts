import { describe, expect, it } from 'vitest';
import { distance, impactSoundDelay } from '../../src/audio/timing';
import type { ImpactEvent } from '../../src/game/bullets';
import type { ZoneName } from '../../src/game/hit';
import { applyImpact } from '../../src/mission/impact';
import type { ImpactState, ImpactTargetInfo } from '../../src/mission/impact';
import { newStats } from '../../src/mission/stats';

const SHOOTER = { x: 0, y: 12, z: 0 };
const SPEED_OF_SOUND = 340;
const POINT = { x: 3, y: 1, z: -400 };

/** A state with two soldiers and one vehicle target; `down` lists the ids that are already down. */
function state(down: string[] = [], over: Partial<ImpactState> = {}): ImpactState {
  const known: Record<string, ImpactTargetInfo['kind']> = { s1: 'soldier', s2: 'soldier', v1: 'vehicle' };
  return {
    stats: newStats(3),
    shooter: SHOOTER,
    speedOfSound: SPEED_OF_SOUND,
    nowMs: 5000,
    target: (id) => (known[id] ? { kind: known[id], down: down.includes(id) } : undefined),
    ...over,
  };
}

const onTarget = (id: string, zone: ZoneName, time = 0.43): ImpactEvent => ({
  bulletId: 1,
  kind: 'target',
  targetId: id,
  zone,
  point: POINT,
  time,
});

const RANGE = distance(POINT, SHOOTER);
const DELAY = impactSoundDelay(POINT, SHOOTER, SPEED_OF_SOUND);

describe('applyImpact: a soldier is hit', () => {
  it('knocks the soldier down, counts the hit and says which zone', () => {
    const r = applyImpact(onTarget('s1', 'upperTorso'), state());
    expect(r.killedTargetId).toBe('s1');
    expect(r.stats.hits).toBe(1);
    expect(r.stats.targetsDown).toBe(1);
    expect(r.stats.headshots).toBe(0);
    expect(r.stats.longestHitM).toBeCloseTo(RANGE, 9);
    expect(r.hud).toEqual({ result: 'HIT – Upper torso – 0.43 s', refreshTargets: true });
    expect(r.fx).toBeNull();
    expect(r.sound).toEqual({ kind: 'hit', delayS: DELAY, distanceM: RANGE });
  });

  it('counts a headshot and labels every zone', () => {
    const head = applyImpact(onTarget('s1', 'head'), state());
    expect(head.stats.headshots).toBe(1);
    expect(head.hud.result).toBe('HIT – Head – 0.43 s');
    expect(applyImpact(onTarget('s1', 'lowerTorso'), state()).hud.result).toBe('HIT – Lower torso – 0.43 s');
    expect(applyImpact(onTarget('s1', 'limbs', 1.5), state()).hud.result).toBe('HIT – Limb – 1.50 s');
  });

  it('does not kill a soldier twice: a second bullet that reaches the same soldier is a hit but not a kill', () => {
    const first = applyImpact(onTarget('s1', 'head'), state());
    expect(first.killedTargetId).toBe('s1');
    // run.ts executes the result (the dummy is now down) before the next event is applied.
    const second = applyImpact(onTarget('s1', 'upperTorso'), state(['s1'], { stats: first.stats }));
    expect(second.killedTargetId).toBeNull();
    expect(second.stats.hits).toBe(2);
    expect(second.stats.targetsDown).toBe(1);
    expect(second.hud.result).toBe('HIT – Upper torso – 0.43 s');
    expect(second.sound?.kind).toBe('hit');
  });

  it('stamps the end time once, on the kill of the last target', () => {
    const s = newStats(1, 1000);
    const r = applyImpact(onTarget('s1', 'head'), state([], { stats: s, nowMs: 9000 }));
    expect(r.stats.endMs).toBe(9000);
  });

  it('does not change the stats it was given', () => {
    const before = state();
    const copy = { ...before.stats };
    applyImpact(onTarget('s1', 'head'), before);
    expect(before.stats).toEqual(copy);
  });
});

describe('applyImpact: a vehicle target is hit', () => {
  it('disables the engine once, with sparks and a metal sound', () => {
    const r = applyImpact(onTarget('v1', 'engine'), state());
    expect(r.killedTargetId).toBe('v1');
    expect(r.stats.hits).toBe(1);
    expect(r.stats.targetsDown).toBe(1);
    expect(r.hud).toEqual({ result: 'VEHICLE DISABLED', refreshTargets: true });
    expect(r.fx).toEqual({ kind: 'sparks', point: POINT });
    expect(r.sound).toEqual({ kind: 'metal', delayS: DELAY, distanceM: RANGE });
  });

  it('does not disable it twice (a second bullet still sparks and counts as a hit)', () => {
    const first = applyImpact(onTarget('v1', 'engine'), state());
    const second = applyImpact(onTarget('v1', 'engine'), state(['v1'], { stats: first.stats }));
    expect(second.killedTargetId).toBeNull();
    expect(second.stats.hits).toBe(2);
    expect(second.stats.targetsDown).toBe(1);
    expect(second.hud.result).toBe('VEHICLE DISABLED');
    expect(second.fx?.kind).toBe('sparks');
    expect(second.sound?.kind).toBe('metal');
  });
});

describe('applyImpact: a target id nobody knows', () => {
  it('is still a hit in the stats but has no kill, text, effect or sound', () => {
    const r = applyImpact(onTarget('ghost', 'head'), state());
    expect(r.killedTargetId).toBeNull();
    expect(r.stats.hits).toBe(1);
    expect(r.stats.headshots).toBe(1);
    expect(r.stats.targetsDown).toBe(0);
    expect(r.hud).toEqual({ result: null, refreshTargets: true });
    expect(r.fx).toBeNull();
    expect(r.sound).toBeNull();
  });
});

describe('applyImpact: cover', () => {
  const metal: ImpactEvent = { bulletId: 2, kind: 'obstacle', obstacleId: 'veh-0:1', material: 'metal', point: POINT, time: 0.8 };
  const wall: ImpactEvent = { bulletId: 3, kind: 'obstacle', obstacleId: 'prop-0:0', material: 'wall', point: POINT, time: 0.8 };

  it('metal cover throws sparks and rings', () => {
    const s = state();
    const r = applyImpact(metal, s);
    expect(r.hud).toEqual({ result: 'Hit cover (metal)', refreshTargets: false });
    expect(r.fx).toEqual({ kind: 'sparks', point: POINT });
    expect(r.sound).toEqual({ kind: 'metal', delayS: DELAY, distanceM: RANGE });
    expect(r.killedTargetId).toBeNull();
    expect(r.stats).toBe(s.stats); // not a hit
  });

  it('a wall raises dust and thuds', () => {
    const s = state();
    const r = applyImpact(wall, s);
    expect(r.hud).toEqual({ result: 'Hit cover', refreshTargets: false });
    expect(r.fx).toEqual({ kind: 'dust', point: POINT });
    expect(r.sound).toEqual({ kind: 'dust', delayS: DELAY, distanceM: RANGE });
    expect(r.killedTargetId).toBeNull();
    expect(r.stats).toBe(s.stats);
  });
});

describe('applyImpact: ground and nothing', () => {
  it('terrain is a MISS with dust', () => {
    const s = state();
    const r = applyImpact({ bulletId: 4, kind: 'terrain', point: POINT, time: 1.1 }, s);
    expect(r.hud).toEqual({ result: 'MISS', refreshTargets: false });
    expect(r.fx).toEqual({ kind: 'dust', point: POINT });
    expect(r.sound).toEqual({ kind: 'dust', delayS: DELAY, distanceM: RANGE });
    expect(r.killedTargetId).toBeNull();
    expect(r.stats).toBe(s.stats);
  });

  it('a bullet that flew out of range is a silent MISS', () => {
    const s = state();
    const r = applyImpact({ bulletId: 5, kind: 'expired', time: 6 }, s);
    expect(r.hud).toEqual({ result: 'MISS', refreshTargets: false });
    expect(r.fx).toBeNull();
    expect(r.sound).toBeNull();
    expect(r.killedTargetId).toBeNull();
    expect(r.stats).toBe(s.stats);
  });
});

describe('applyImpact: the sound delay and distance', () => {
  it('follow the impact point and the speed of sound', () => {
    const near = applyImpact({ bulletId: 6, kind: 'terrain', point: { x: 0, y: 12, z: -34 }, time: 0.1 }, state());
    expect(near.sound?.distanceM).toBeCloseTo(34, 9);
    expect(near.sound?.delayS).toBeCloseTo(0.1, 9);
  });
});
