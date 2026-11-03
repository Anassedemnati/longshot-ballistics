import { describe, expect, it } from 'vitest';
import { ThreatLine, flashIntensity, threatText } from '../../src/ui/threat';
import type { ThreatState } from '../../src/ui/threat';

const state = (over: Partial<ThreatState> = {}): ThreatState => ({
  health: 100,
  detection: 0,
  covered: false,
  snipersLeft: 2,
  warning: 0,
  firing: false,
  awareness: 'unaware',
  camo: false,
  fireIn: 4,
  paused: false,
  failed: false,
  cleared: false,
  ...over,
});

describe('threatText', () => {
  it('says the enemy is unaware while nothing has given the player away', () => {
    expect(threatText(state())).toBe('EXPOSED · Health 100 · Detection 0 % · 2 snipers left · Enemy unaware');
  });

  it('adds the ghillie suit to "Enemy unaware" when he wears one', () => {
    expect(threatText(state({ camo: true }))).toBe('EXPOSED · Health 100 · Detection 0 % · 2 snipers left · Enemy unaware · ghillie suit');
    expect(threatText(state({ camo: false }))).not.toContain('ghillie');
  });

  it('says the enemy is searching for him once he is heard or seen, and tells him about cover', () => {
    expect(threatText(state({ awareness: 'searching', detection: 28 }))).toBe(
      'EXPOSED · Health 100 · Detection 28 % · 2 snipers left · Enemy searching for you · C: cover',
    );
    // The same words in a ghillie suit: a searching enemy does not need the reminder of the suit.
    expect(threatText(state({ awareness: 'searching', camo: true }))).toContain('Enemy searching for you · C: cover');
    expect(threatText(state({ awareness: 'searching', camo: true }))).not.toContain('ghillie');
  });

  it('shows the countdown, not the awareness, once the snipers fire', () => {
    const text = threatText(state({ awareness: 'firing', firing: true, detection: 70, fireIn: 3 }));
    expect(text).toContain('SNIPER FIRING IN 3.0 s');
    expect(text).not.toContain('Enemy');
  });

  it('counts down to the next sniper shot once detected', () => {
    const text = threatText(state({ detection: 70.4, firing: true, fireIn: 2.13, health: 82 }));
    expect(text).toBe('EXPOSED · Health 82 · Detection 70 % · 2 snipers left · SNIPER FIRING IN 2.1 s');
  });

  it('warns of a bombardment with its own countdown, and the cover key', () => {
    const text = threatText(state({ detection: 100, firing: true, fireIn: 1, warning: 3.04 }));
    expect(text).toContain('INCOMING BOMBARDMENT 3.0 s — C: COVER');
    expect(text).not.toContain('SNIPER FIRING IN');
  });

  it('shows IN COVER, and singular sniper', () => {
    const text = threatText(state({ covered: true, snipersLeft: 1 }));
    expect(text.startsWith('IN COVER')).toBe(true);
    expect(text).toContain('1 sniper left');
  });

  it('rounds health up, so a living player never reads 0', () => {
    expect(threatText(state({ health: 0.4 }))).toContain('Health 1');
  });

  it('says so while the game is paused', () => {
    expect(threatText(state({ paused: true }))).toMatch(/ · PAUSED$/);
    expect(threatText(state({ paused: false }))).not.toContain('PAUSED');
  });

  it('says the mission is failed, or that every sniper is down', () => {
    expect(threatText(state({ failed: true, health: 0 }))).toBe('MISSION FAILED · you were killed');
    expect(threatText(state({ cleared: true, snipersLeft: 0, health: 64 }))).toBe('ALL SNIPERS DOWN · threat cleared · Health 64');
  });
});

describe('ThreatLine (the per-frame cache of the line)', () => {
  /** A line that counts how many times its text was really built. */
  function counted() {
    const log = { built: 0 };
    const line = new ThreatLine((s) => {
      log.built++;
      return threatText(s);
    });
    return { log, line };
  }

  it('builds the text once while nothing the line shows changes, however many frames', () => {
    const { log, line } = counted();
    const first = line.line(state({ health: 82, detection: 70.2, firing: true, fireIn: 2.13 }));
    expect(first).toBe(threatText(state({ health: 82, detection: 70.2, firing: true, fireIn: 2.13 })));
    for (let i = 0; i < 100; i++) line.line(state({ health: 82, detection: 70.2, firing: true, fireIn: 2.13 }));
    expect(log.built).toBe(1);
  });

  it('ignores changes below what is shown: health within the same whole point, detection within the same percent, the countdown within a tenth', () => {
    const { log, line } = counted();
    line.line(state({ health: 82, detection: 70.2, firing: true, fireIn: 2.13 }));
    line.line(state({ health: 81.2, detection: 70.4, firing: true, fireIn: 2.08 })); // ceil 82, round 70, 2.1
    expect(log.built).toBe(1);
  });

  it('rebuilds when a displayed value or a flag changes', () => {
    const { log, line } = counted();
    const base = state({ health: 82, detection: 70, firing: true, fireIn: 2.1 });
    line.line(base);
    const changes: Array<Partial<ThreatState>> = [
      { health: 81 },
      { detection: 71 },
      { fireIn: 2.0 },
      { snipersLeft: 1 },
      { covered: true },
      { paused: true },
      { warning: 3.4 },
      { firing: false },
      { awareness: 'searching' },
      { awareness: 'firing' },
      { camo: true },
      { cleared: true },
      { failed: true },
    ];
    let expected = 1;
    for (const change of changes) {
      line.line(state({ ...base, ...change }));
      expect(log.built, JSON.stringify(change)).toBe(++expected);
      line.line(state(base)); // back to the first state: that is a change too
      expect(log.built, `back from ${JSON.stringify(change)}`).toBe(++expected);
    }
  });

  it('re-renders when the awareness changes, and not before', () => {
    const { log, line } = counted();
    expect(line.line(state())).toContain('Enemy unaware');
    expect(line.line(state())).toContain('Enemy unaware');
    expect(log.built).toBe(1);
    expect(line.line(state({ awareness: 'searching' }))).toContain('Enemy searching for you');
    expect(log.built).toBe(2);
    expect(line.line(state({ awareness: 'searching' }))).toContain('Enemy searching for you');
    expect(log.built).toBe(2);
    line.line(state({ awareness: 'firing', firing: true }));
    expect(log.built).toBe(3);
  });

  it('shows the countdown of a bombardment, not the shot, and follows it in tenths', () => {
    const { log, line } = counted();
    line.line(state({ firing: true, fireIn: 3, warning: 3.04 }));
    line.line(state({ firing: true, fireIn: 1, warning: 3.01 })); // the shot countdown is not shown: no rebuild
    expect(log.built).toBe(1);
    expect(line.line(state({ firing: true, fireIn: 1, warning: 2.94 }))).toContain('INCOMING BOMBARDMENT 2.9 s');
    expect(log.built).toBe(2);
  });
});

describe('flashIntensity', () => {
  it('is 0 for no damage and grows with the damage, up to 0.6', () => {
    expect(flashIntensity(0)).toBe(0);
    expect(flashIntensity(-5)).toBe(0);
    expect(flashIntensity(Number.NaN)).toBe(0);
    expect(flashIntensity(5)).toBeLessThan(flashIntensity(18));
    expect(flashIntensity(18)).toBeLessThan(flashIntensity(45));
    expect(flashIntensity(45)).toBeLessThanOrEqual(0.6);
    expect(flashIntensity(1000)).toBe(0.6);
  });
});
