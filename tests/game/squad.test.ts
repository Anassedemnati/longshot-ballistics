import { describe, expect, it } from 'vitest';
import { SQUAD, SoldierBrain, SpotBook, Squad, aimErrorM, burstHitChance } from '../../src/game/squad';
import type { BrainListener, Spot, SquadMap } from '../../src/game/squad';

const idle = { sniperCalling: false, playerCovered: false, alive: 3 };

describe('Squad knowledge', () => {
  it('needs several shots to find the player: one shot only alerts the squad', () => {
    const s = new Squad(1);
    expect(s.state).toBe('unaware');
    s.playerShot({ suppressed: false, camo: false });
    expect(s.knowledge).toBeCloseTo(0.12, 9);
    expect(s.state).toBe('alerted');
    s.playerShot({ suppressed: false, camo: false });
    s.playerShot({ suppressed: false, camo: false });
    expect(s.state).toBe('searching'); // 0.36
    for (let i = 0; i < 3; i++) s.playerShot({ suppressed: false, camo: false });
    expect(s.state).toBe('engaging'); // 0.72
  });

  it('hears a suppressed shot a third as well, and a ghillie suit gives away 80 % of a shot', () => {
    const quiet = new Squad(1);
    quiet.playerShot({ suppressed: true, camo: false });
    expect(quiet.knowledge).toBeCloseTo(0.04, 9);
    const camo = new Squad(1);
    camo.playerShot({ suppressed: false, camo: true });
    expect(camo.knowledge).toBeCloseTo(0.096, 9);
  });

  it('learns from a bullet passing a soldier (+0.12) and from a soldier going down (+0.06)', () => {
    const s = new Squad(1);
    s.bulletPassed();
    s.soldierKilled();
    expect(s.knowledge).toBeCloseTo(0.18, 9);
    expect(s.state).toBe('alerted');
  });

  it('is told the player\'s position at 0.2 a second while a sniper calls it, and forgets 0.01 a second while he is in cover', () => {
    const s = new Squad(1);
    for (let i = 0; i < 10; i++) s.update(0.1, { ...idle, sniperCalling: true });
    expect(s.knowledge).toBeCloseTo(0.2, 6);
    expect(s.state).not.toBe('unaware');
    for (let i = 0; i < 100; i++) s.update(0.1, { ...idle, playerCovered: true });
    expect(s.knowledge).toBeCloseTo(0.1, 6);
    // Exposed and unspotted: it stays.
    for (let i = 0; i < 100; i++) s.update(0.1, idle);
    expect(s.knowledge).toBeCloseTo(0.1, 6);
  });

  it('does not flicker between states: it leaves "engaging" only 0.05 below the threshold', () => {
    const s = new Squad(1);
    s.setKnowledge(0.66);
    expect(s.state).toBe('engaging');
    s.setKnowledge(0.62);
    expect(s.state).toBe('engaging');
    s.setKnowledge(0.59);
    expect(s.state).toBe('searching');
  });

  it('calls its first mortar 8 to 14 s after it has the player (knowledge 0.75), then one every 18 to 25 s, and none without a soldier to call it', () => {
    const s = new Squad(7);
    s.setKnowledge(0.7);
    for (let i = 0; i < 400; i++) expect(s.update(0.1, idle)).toBe(false); // below 0.75: nothing, however long
    s.setKnowledge(0.9);
    const calls: number[] = [];
    for (let i = 0; i < 1000; i++) if (s.update(0.1, idle)) calls.push((i + 1) / 10);
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls[0]).toBeGreaterThanOrEqual(8);
    expect(calls[0]).toBeLessThanOrEqual(14.2);
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i] - calls[i - 1]).toBeGreaterThanOrEqual(18);
      expect(calls[i] - calls[i - 1]).toBeLessThanOrEqual(25.2);
    }
    const dead = new Squad(7);
    dead.setKnowledge(0.9);
    for (let i = 0; i < 600; i++) expect(dead.update(0.1, { ...idle, alive: 0 })).toBe(false);
  });
});

describe('what a burst does', () => {
  it('lands far from the player while they only search and close once they have him', () => {
    expect(aimErrorM(0.35)).toBeCloseTo(45, 9);
    expect(aimErrorM(0.65)).toBeCloseTo(10, 9);
    expect(aimErrorM(0.2)).toBeGreaterThan(aimErrorM(0.35));
    expect(aimErrorM(0.35)).toBeGreaterThan(aimErrorM(0.5));
    expect(aimErrorM(1)).toBeLessThan(5);
  });

  it('hits an exposed player with 0.35 at 300 m or less down to 0.04 at 900 m or more, times what they know', () => {
    expect(burstHitChance(200, 1)).toBeCloseTo(0.35, 9);
    expect(burstHitChance(300, 1)).toBeCloseTo(0.35, 9);
    expect(burstHitChance(900, 1)).toBeCloseTo(0.04, 9);
    expect(burstHitChance(1500, 1)).toBeCloseTo(0.04, 9);
    expect(burstHitChance(600, 1)).toBeCloseTo(0.195, 9);
    expect(burstHitChance(300, 0.5)).toBeCloseTo(0.175, 9);
  });
});

// ---- soldiers ----

/** A flat map: spot 0 is where the soldier starts (open ground), spot 1 is cover 20 m off, spot 2 more cover 30 m the other way. */
function fixture(startHidden = false) {
  const spots: Spot[] = [
    { x: 0, z: -100, yaw: 0, hidden: startHidden, peekX: 0, peekZ: 0, peekStance: 'kneel' },
    { x: 20, z: -100, yaw: 0, hidden: true, peekX: 0, peekZ: 0, peekStance: 'stand' },
    { x: -30, z: -100, yaw: 0, hidden: true, peekX: 1, peekZ: 0, peekStance: 'kneel' },
  ];
  const map: SquadMap = { spots, path: (_fx, _fz, tx, tz) => [tx, tz] };
  const book = new SpotBook(spots.length);
  const squad = new Squad(3);
  const log = { rounds: [] as number[], bursts: 0 };
  const listener: BrainListener = {
    round: (_b, i, n) => log.rounds.push(n - i),
    burstEnd: () => log.bursts++,
  };
  const brain = new SoldierBrain(0, { x: 0, z: -100, yaw: 0 }, map, book, squad, listener, 11, 0);
  const run = (seconds: number): void => {
    for (let i = 0; i < Math.round(seconds * 60); i++) brain.update(1 / 60, 0, 0);
  };
  return { brain, squad, book, log, run, spots };
}

describe('SoldierBrain', () => {
  it('stands idle until a shot is heard, then reacts, runs to cover at 4 to 4.5 m/s and crouches there', () => {
    const f = fixture();
    f.run(5);
    expect(f.brain.mode).toBe('idle');
    expect(f.brain.x).toBe(0);
    f.squad.playerShot({ suppressed: false, camo: false });
    let top = 0;
    for (let i = 0; i < 60 * 10; i++) {
      f.brain.update(1 / 60, 0, 0);
      top = Math.max(top, f.brain.speed);
    }
    expect(f.brain.mode).toBe('inCover');
    expect(f.brain.stance).toBe('crouch');
    expect(f.brain.spot).not.toBe(0); // the open start spot is no cover: he took one that hides him
    expect(f.spots[f.brain.spot].hidden).toBe(true);
    expect(top).toBeGreaterThan(3.2);
    expect(top).toBeLessThanOrEqual(4.5 + 1e-9);
    expect(f.book.ownerOf(f.brain.spot)).toBe(0);
  });

  it('only looks out while the squad is merely alerted, and fires bursts of 3 to 6 rounds once it is searching', () => {
    const f = fixture(true); // already behind cover: stays put
    f.squad.playerShot({ suppressed: false, camo: false });
    f.run(9); // he stays put at least 10 s
    expect(f.brain.mode).toBe('inCover');
    expect(f.log.rounds.length).toBe(0); // 0.12 knowledge: alerted, no fire
    f.squad.setKnowledge(0.5);
    f.run(60);
    expect(f.log.bursts).toBeGreaterThanOrEqual(5);
    // Each burst is 3 to 6 rounds, counted down from its length.
    const lengths = f.log.rounds.filter((n, i, a) => i === 0 || a[i - 1] === 1 || n > a[i - 1]).map((n) => n);
    for (const n of lengths) {
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(6);
    }
    expect(f.log.rounds.length).toBeGreaterThanOrEqual(f.log.bursts * 3);
  });

  it('changes position after a near miss, and when a friend close by goes down, but not for one far away', () => {
    const f = fixture(true);
    f.squad.setKnowledge(0.5);
    f.run(10);
    const before = f.brain.spot;
    f.brain.nearMiss(10); // not close
    f.brain.friendDown(500, 0); // not close
    expect(f.brain.mode).toBe('inCover');
    f.brain.nearMiss(3);
    expect(f.brain.mode).toBe('relocating');
    f.run(15);
    expect(f.brain.mode).toBe('inCover');
    expect(f.brain.spot).not.toBe(before);
    expect(f.book.ownerOf(before)).toBe(-1);
    f.brain.friendDown(f.brain.x + 10, f.brain.z);
    expect(f.brain.mode).toBe('relocating');
  });

  it('moves to another spot of its own accord after 10 to 25 s in one', () => {
    const f = fixture(true);
    f.squad.setKnowledge(0.5);
    f.run(9.5);
    expect(f.brain.mode).toBe('inCover');
    const first = f.brain.spot;
    let moved = false;
    for (let i = 0; i < 60 * 20 && !moved; i++) {
      f.brain.update(1 / 60, 0, 0);
      moved = f.brain.mode === 'relocating';
    }
    expect(moved).toBe(true);
    f.run(20);
    expect(f.brain.spot).not.toBe(first);
  });

  it('frees his spot when he is killed', () => {
    const f = fixture(true);
    f.squad.setKnowledge(0.5);
    f.run(3);
    const spot = f.brain.spot;
    expect(f.book.ownerOf(spot)).toBe(0);
    f.brain.kill();
    expect(f.brain.alive).toBe(false);
    expect(f.book.ownerOf(spot)).toBe(-1);
    const x = f.brain.x;
    f.run(2);
    expect(f.brain.x).toBe(x);
  });

  it('is repeatable: the same seed gives the same soldier', () => {
    const a = fixture(true);
    const b = fixture(true);
    for (const f of [a, b]) {
      f.squad.setKnowledge(0.5);
      f.run(30);
    }
    expect(a.log.rounds).toEqual(b.log.rounds);
    expect(a.brain.x).toBe(b.brain.x);
    void SQUAD;
  });
});
