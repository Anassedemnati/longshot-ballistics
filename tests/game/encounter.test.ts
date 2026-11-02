import { describe, expect, it } from 'vitest';
import { ENCOUNTER, Encounter } from '../../src/game/encounter';

/** Run `seconds` of game time in 0.1 s frames with the given state; returns every event, in order. */
function run(e: Encounter, seconds: number, alive = 1, covered = false, paused = false) {
  const events: string[] = [];
  const frames = Math.round(seconds * 10);
  for (let i = 0; i < frames; i++) events.push(...e.update(0.1, alive, covered, paused));
  return events;
}

describe('Encounter: the numbers', () => {
  it('starts at full health with nothing detected', () => {
    const e = new Encounter();
    expect(e.health).toBe(100);
    expect(e.detection).toBe(0);
    expect(e.ended).toBe(false);
    expect(e.failed).toBe(false);
    expect(ENCOUNTER).toMatchObject({
      healthMax: 100,
      detectShot: 35,
      detectShotSuppressed: 9,
      exposedPerS: 4,
      coverPerS: 9,
      fireThreshold: 65,
      sniperIntervalS: 4,
      sniperDamage: 18,
      bombardIntervalS: 12,
      bombardWarningS: 4,
      bombardDamage: 45,
      bombardDamageCover: 5,
    });
  });
});

describe('Encounter: detection', () => {
  it('rises 35 per unsuppressed shot and 9 per suppressed shot', () => {
    const a = new Encounter();
    a.shot(false);
    expect(a.detection).toBe(35);
    a.shot(false);
    expect(a.detection).toBe(70);
    const b = new Encounter();
    b.shot(true);
    expect(b.detection).toBe(9);
    b.shot(true);
    expect(b.detection).toBe(18);
  });

  it('never leaves 0..100', () => {
    const e = new Encounter();
    for (let i = 0; i < 5; i++) e.shot(false);
    expect(e.detection).toBe(100);
    e.setDetection(250);
    expect(e.detection).toBe(100);
    e.setDetection(-3);
    expect(e.detection).toBe(0);
    e.setDetection(Number.NaN);
    expect(e.detection).toBe(0);
    run(e, 3, 1, true);
    expect(e.detection).toBe(0);
  });

  it('rises 4 per second while exposed and falls 9 per second in cover', () => {
    const e = new Encounter();
    run(e, 5, 1, false);
    expect(e.detection).toBeCloseTo(20, 9);
    run(e, 2, 1, true);
    expect(e.detection).toBeCloseTo(2, 9);
  });

  it('reads 26 after one second in cover from 35', () => {
    const e = new Encounter();
    e.shot(false);
    e.update(1, 3, true, false);
    expect(e.detection).toBe(26);
  });
});

describe('Encounter: sniper fire', () => {
  it('stays quiet below 65 %', () => {
    const e = new Encounter();
    e.setDetection(64);
    // 4 per second exposed: it crosses 65 after a quarter of a second; so keep the player in cover.
    expect(run(e, 3, 1, true)).toEqual([]);
    expect(e.health).toBe(100);
  });

  it('fires every 4 s once detected at 65 % or more: -18 health when exposed', () => {
    const e = new Encounter();
    e.setDetection(100);
    const events = run(e, 12, 1, false);
    expect(events.filter((x) => x === 'shot')).toHaveLength(3);
    expect(e.health).toBe(100 - 3 * 18 - 0); // the first bombardment lands 16 s in
  });

  it('a shot against a player in cover does no damage', () => {
    const e = new Encounter();
    e.setDetection(100);
    // Cover bleeds detection at 9/s, so hold it up like a player who keeps shooting.
    let shots = 0;
    for (let i = 0; i < 45; i++) {
      e.setDetection(100);
      shots += e.update(0.1, 1, true, false).filter((x) => x === 'shot').length;
    }
    expect(shots).toBe(1);
    expect(e.health).toBe(100);
  });

  it('reports the seconds to the next shot', () => {
    const e = new Encounter();
    e.setDetection(100);
    expect(e.fireIn).toBe(4);
    run(e, 1.5);
    expect(e.fireIn).toBeCloseTo(2.5, 9);
  });
});

describe('Encounter: bombardment', () => {
  it('calls a bombardment every 12 s with a 4 s warning, then -45 when exposed', () => {
    const e = new Encounter();
    e.setDetection(100);
    run(e, 11.9);
    expect(e.warning).toBe(0);
    run(e, 0.1);
    expect(e.warning).toBeCloseTo(4, 9);
    // 3 s into the warning (15 s): still 3 shots... the 4th is not due yet; no blast yet.
    const early = run(e, 3.8);
    expect(early).not.toContain('blast');
    expect(e.warning).toBeGreaterThan(0);
    const healthBefore = e.health;
    const late = run(e, 0.2);
    expect(late).toContain('blast');
    expect(e.warning).toBe(0);
    expect(e.health).toBeLessThanOrEqual(healthBefore - 45);
  });

  it('a bombardment in cover does 5, not 45', () => {
    const e = new Encounter();
    e.setDetection(100);
    e.mortarClock = 11.9;
    expect(e.update(0.1, 3, false, false)).toEqual([]);
    expect(e.warning).toBeCloseTo(4, 9);
    const events = e.update(4, 3, true, false);
    expect(events).toContain('blast');
    expect(e.health).toBe(95);
  });

  it('the exposed bombardment takes exactly 45', () => {
    const e = new Encounter();
    e.setDetection(100);
    e.mortarClock = 11.9;
    e.update(0.1, 3, false, false);
    e.sniperClock = -100; // keep the sniper out of this count
    const events = e.update(4, 3, false, false);
    expect(events).toEqual(['blast']);
    expect(e.health).toBe(55);
  });

  it('a pending warning still lands after the detection has fallen', () => {
    const e = new Encounter();
    e.setDetection(100);
    e.mortarClock = 11.9;
    e.update(0.1, 3, false, false);
    e.setDetection(0);
    const events = e.update(4.5, 3, true, false);
    expect(events).toContain('blast');
    expect(e.health).toBe(95);
  });
});

describe('Encounter: pause, end and failure', () => {
  it('changes nothing while paused', () => {
    const e = new Encounter();
    e.setDetection(100);
    e.mortarClock = 11.95;
    e.sniperClock = 3.95;
    const before = JSON.stringify(e);
    for (let i = 0; i < 100; i++) expect(e.update(0.1, 2, false, true)).toEqual([]);
    expect(JSON.stringify(e)).toBe(before);
    expect(e.health).toBe(100);
  });

  it('a shot still counts while paused (the debug hook can fire without a pointer lock)', () => {
    const e = new Encounter();
    e.shot(false);
    expect(e.detection).toBe(35);
  });

  it('ends when no sniper is left alive, and then nothing more happens', () => {
    const e = new Encounter();
    e.setDetection(100);
    expect(e.update(1, 0, false, false)).toEqual([]);
    expect(e.ended).toBe(true);
    expect(e.failed).toBe(false);
    expect(run(e, 30, 0, false)).toEqual([]);
    expect(run(e, 30, 3, false)).toEqual([]);
    expect(e.health).toBe(100);
    e.shot(false);
    expect(e.detection).toBeLessThanOrEqual(100);
  });

  it('ends in failure when the health reaches 0, and stays at 0', () => {
    const e = new Encounter();
    e.setDetection(100);
    e.health = 10;
    const events = run(e, 5);
    expect(events).toContain('shot');
    expect(e.health).toBe(0);
    expect(e.ended).toBe(true);
    expect(e.failed).toBe(true);
    expect(run(e, 30)).toEqual([]);
    expect(e.health).toBe(0);
  });

  it('a lethal bombardment ends it too', () => {
    const e = new Encounter();
    e.setDetection(100);
    e.health = 40;
    e.mortarClock = 11.95;
    e.sniperClock = -100;
    e.update(0.1, 2, false, false);
    e.update(4, 2, false, false);
    expect(e.health).toBe(0);
    expect(e.failed).toBe(true);
    expect(e.ended).toBe(true);
  });

  it('ignores a bad frame time', () => {
    const e = new Encounter();
    e.setDetection(50);
    expect(e.update(Number.NaN, 1, false, false)).toEqual([]);
    expect(e.update(-1, 1, false, false)).toEqual([]);
    expect(e.detection).toBe(50);
  });
});
