import { describe, expect, it } from 'vitest';
import { AWARENESS, ENCOUNTER, Encounter, bulletCueBump } from '../../src/game/encounter';

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

  it('loses the aim when the detection falls below 65 %: the next shot takes the full 4 s again', () => {
    const e = new Encounter();
    e.setDetection(100);
    run(e, 3, 1, false); // 3 s of aiming
    expect(e.sniperClock).toBeCloseTo(3, 9);
    e.setDetection(40);
    expect(e.update(0.1, 1, true, false)).toEqual([]); // the snipers lose him: both clocks start over
    expect(e.sniperClock).toBe(0);
    expect(e.mortarClock).toBe(0);
    e.setDetection(100);
    expect(run(e, 3.8, 1, false)).toEqual([]); // not one second after he is found again, but four
    expect(run(e, 0.3, 1, false)).toEqual(['shot']);
  });

  it('allocates nothing on a frame where nothing happens: the same empty list every time', () => {
    const e = new Encounter();
    const a = e.update(0.1, 1, false, false);
    const b = e.update(0.1, 1, false, false);
    expect(a).toEqual([]);
    expect(b).toBe(a);
    expect(e.update(0.1, 1, false, true)).toBe(a); // paused
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

describe('Encounter: awareness', () => {
  it('starts unaware, goes searching, then firing: in that order, as the detection rises with no shot fired', () => {
    const e = new Encounter();
    expect(e.awareness).toBe('unaware');
    const seen: string[] = [e.awareness];
    let firstSearching = -1;
    let firstFiring = -1;
    for (let i = 0; i < 400; i++) {
      e.update(0.1, 1, false, false);
      if (e.awareness !== seen[seen.length - 1]) seen.push(e.awareness);
      if (firstSearching < 0 && e.awareness === 'searching') firstSearching = (i + 1) / 10;
      if (firstFiring < 0 && e.awareness === 'firing') firstFiring = (i + 1) / 10;
    }
    expect(seen).toEqual(['unaware', 'searching', 'firing']);
    expect(firstSearching).toBeCloseTo(AWARENESS.searchThreshold / ENCOUNTER.exposedPerS, 0); // 5 s
    expect(firstFiring).toBeCloseTo(ENCOUNTER.fireThreshold / ENCOUNTER.exposedPerS, 0); // 16.25 s
  });

  it('without a ghillie suit the old behaviour is untouched: 4 % a second, firing at 65 % after about 16 s', () => {
    const e = new Encounter();
    run(e, 16);
    expect(e.detection).toBeCloseTo(64, 6);
    expect(e.firing).toBe(false);
    run(e, 0.3);
    expect(e.firing).toBe(true);
    expect(new Encounter({ camo: false }).camo).toBe(false);
    expect(new Encounter().camo).toBe(false);
  });

  it('any shot alerts the snipers for good, a suppressed one included, and cover does not calm them again', () => {
    const e = new Encounter();
    e.shot(true);
    expect(e.detection).toBe(9);
    expect(e.awareness).toBe('searching'); // 9 % is below the search threshold: the shot itself is what they heard
    run(e, 5, 1, true); // ducked: the detection falls to 0
    expect(e.detection).toBe(0);
    expect(e.awareness).toBe('searching');
  });

  it('is firing whenever the detection is at the fire threshold, camo or not', () => {
    for (const camo of [false, true]) {
      const e = new Encounter({ camo });
      e.setDetection(ENCOUNTER.fireThreshold);
      expect(e.awareness).toBe('firing');
      e.setDetection(ENCOUNTER.fireThreshold - 0.1);
      expect(e.awareness).not.toBe('firing');
    }
  });

  it('without a suit the exposure alone makes them search at the search threshold', () => {
    const e = new Encounter();
    e.setDetection(AWARENESS.searchThreshold - 0.1);
    expect(e.awareness).toBe('unaware');
    e.setDetection(AWARENESS.searchThreshold);
    expect(e.awareness).toBe('searching');
  });
});

describe('Encounter: the ghillie suit', () => {
  it('holds the passive detection at its cap for as long as he holds fire: ten minutes exposed never go past 30 %', () => {
    const e = new Encounter({ camo: true });
    for (let i = 0; i < 6000; i++) {
      e.update(0.1, 1, false, false);
      expect(e.detection).toBeLessThanOrEqual(AWARENESS.camoCap + 1e-9);
    }
    expect(e.detection).toBeCloseTo(AWARENESS.camoCap, 9);
    expect(e.awareness).toBe('unaware');
    expect(e.firing).toBe(false);
    expect(e.health).toBe(100);
    expect(e.warning).toBe(0);
  });

  it('gains 1 % a second up to the cap before the first shot', () => {
    const e = new Encounter({ camo: true });
    run(e, 10);
    expect(e.detection).toBeCloseTo(10 * AWARENESS.camoUnawarePerS, 6);
    expect(e.awareness).toBe('unaware');
  });

  it('cover still bleeds the detection off at the usual 9 % a second', () => {
    const e = new Encounter({ camo: true });
    run(e, 20);
    expect(e.detection).toBeCloseTo(20, 6);
    run(e, 1, 1, true);
    expect(e.detection).toBeCloseTo(11, 6);
    run(e, 5, 1, true);
    expect(e.detection).toBe(0);
  });

  it('the cap limits the passive gain only: a value set above it is neither pushed up nor pulled down', () => {
    const e = new Encounter({ camo: true });
    e.setDetection(50);
    run(e, 10);
    expect(e.detection).toBe(50);
    expect(e.awareness).toBe('unaware');
    run(e, 1, 1, true);
    expect(e.detection).toBeCloseTo(41, 6);
  });

  it('after the first shot the exposure gains 1.5 % a second, uncapped, and the snipers are searching', () => {
    const e = new Encounter({ camo: true });
    run(e, 40); // the cap: 30 %
    e.shot({ suppressed: false });
    expect(e.awareness).toBe('searching');
    const before = e.detection;
    run(e, 10);
    expect(e.detection).toBeCloseTo(before + 10 * AWARENESS.camoSearchingPerS, 6);
  });

  it('plays out: a suit hides a still player for minutes, one shot starts the search, a second brings fire', () => {
    const e = new Encounter({ camo: true });
    run(e, 120); // two minutes in plain view
    expect(e.awareness).toBe('unaware');
    e.shot({ suppressed: false });
    e.update(0.1, 1, false, false);
    expect(e.detection).toBeCloseTo(30 + 28 + 0.15, 6);
    expect(e.awareness).toBe('searching');
    e.shot({ suppressed: false });
    expect(e.awareness).toBe('firing');
  });

  it('is gentler than no suit for the first shot, not a free pass: 35 % plain, 28 % in the suit, 9 % and 7.2 % suppressed', () => {
    const cases: Array<[boolean, boolean, number]> = [
      [false, false, 35],
      [true, false, 28],
      [false, true, 9],
      [true, true, 7.2],
    ];
    for (const [camo, suppressed, expected] of cases) {
      const e = new Encounter({ camo });
      e.shot({ suppressed });
      expect(e.detection, `camo ${camo}, suppressed ${suppressed}`).toBeCloseTo(expected, 9);
    }
  });

  it('keeps shot(boolean) working as the old call', () => {
    const a = new Encounter();
    a.shot(false);
    const b = new Encounter();
    b.shot({ suppressed: false });
    expect(a.detection).toBe(b.detection);
    const c = new Encounter();
    c.shot(true);
    expect(c.detection).toBe(9);
  });
});

describe('Encounter: the bullet cue', () => {
  it('bulletCueBump is the full 25 within 5 m, nothing from 60 m, and linear in between', () => {
    expect(AWARENESS).toMatchObject({ bulletCueMax: 25, bulletCueNearM: 5, bulletCueFarM: 60 });
    expect(bulletCueBump(0)).toBe(25);
    expect(bulletCueBump(5)).toBe(25);
    expect(bulletCueBump(60)).toBe(0);
    expect(bulletCueBump(61)).toBe(0);
    expect(bulletCueBump(32.5)).toBeCloseTo(12.5, 9);
    expect(bulletCueBump(16)).toBeCloseTo(25 * (44 / 55), 9);
    for (let d = 5; d < 60; d += 0.5) expect(bulletCueBump(d + 0.5)).toBeLessThanOrEqual(bulletCueBump(d));
  });

  it('bulletCueBump gives nothing for no sniper in reach or a bad number', () => {
    expect(bulletCueBump(Infinity)).toBe(0);
    expect(bulletCueBump(Number.NaN)).toBe(0);
  });

  it('bulletCue adds the bump and alerts the snipers, suit or not, whatever the suppressor', () => {
    for (const camo of [false, true]) {
      const e = new Encounter({ camo });
      e.bulletCue(5);
      expect(e.detection).toBe(25);
      expect(e.awareness).toBe('searching');
      e.bulletCue(32.5);
      expect(e.detection).toBeCloseTo(37.5, 9);
    }
  });

  it('a bullet that came near nobody does nothing at all', () => {
    const e = new Encounter({ camo: true });
    e.bulletCue(Infinity);
    e.bulletCue(400);
    expect(e.detection).toBe(0);
    expect(e.awareness).toBe('unaware');
  });

  it('a close miss on top of the muzzle report is enough to bring fire: 35 + 25 = 60, plus a few seconds of exposure', () => {
    const e = new Encounter();
    e.shot(false);
    e.bulletCue(3);
    expect(e.detection).toBe(60);
    expect(e.awareness).toBe('searching');
    run(e, 2); // +8
    expect(e.firing).toBe(true);
  });

  it('is clamped at 100 %', () => {
    const e = new Encounter();
    e.setDetection(95);
    e.bulletCue(0);
    expect(e.detection).toBe(100);
  });
});

describe('the soldiers that fight back', () => {
  it('lasts while soldiers are left even with no sniper, without any detection or sniper fire', () => {
    const e = new Encounter();
    for (let i = 0; i < 600; i++) expect(e.update(0.1, 0, false, false, 3)).toEqual([]); // 60 s exposed, 0 snipers, 3 soldiers
    expect(e.ended).toBe(false);
    expect(e.detection).toBe(0);
    expect(e.health).toBe(100);
    e.update(0.1, 0, false, false, 0); // the last soldier is down
    expect(e.ended).toBe(true);
  });

  it('starts the same 4 s warning and blast from a mortar call, once at a time', () => {
    const e = new Encounter();
    expect(e.callBombardment()).toBe(true);
    expect(e.warning).toBe(4);
    expect(e.warningSource).toBe('mortar');
    expect(e.callBombardment()).toBe(false); // one is already on its way
    let blasts = 0;
    for (let i = 0; i < 45; i++) blasts += e.update(0.1, 0, false, false, 2).filter((x) => x === 'blast').length;
    expect(blasts).toBe(1);
    expect(e.health).toBe(55);
    const covered = new Encounter();
    covered.callBombardment();
    for (let i = 0; i < 45; i++) covered.update(0.1, 0, true, false, 2);
    expect(covered.health).toBe(95); // 5 in cover
  });

  it('takes damage from the soldiers\' rifles, never below 0, and ends when it kills', () => {
    const e = new Encounter();
    e.hurt(8);
    expect(e.health).toBe(92);
    e.hurt(-5);
    e.hurt(0);
    expect(e.health).toBe(92);
    e.hurt(500);
    expect(e.health).toBe(0);
    expect(e.failed).toBe(true);
    expect(e.ended).toBe(true);
  });
});
