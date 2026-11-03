import { describe, expect, it } from 'vitest';
import { RIFLES } from '../../src/ballistics/rifles';
import { BOLT_TIME_S, RELOAD_TIME_S, Weapon } from '../../src/game/weapon';

describe('Weapon', () => {
  it('starts with a full magazine, ready to fire', () => {
    const w = new Weapon(5);
    expect(w.ammo).toBe(5);
    expect(w.magazine).toBe(5);
    expect(w.reloading).toBe(false);
    expect(w.boltCycling).toBe(false);
  });

  it('constants: 1.2 s bolt, 1.5 s reload', () => {
    expect(BOLT_TIME_S).toBe(1.2);
    expect(RELOAD_TIME_S).toBe(1.5);
  });

  describe('fire', () => {
    it('is allowed with rounds in the magazine: uses a round and starts the bolt lockout', () => {
      const w = new Weapon(5);
      expect(w.fire()).toEqual({ fired: true, boltCycle: true });
      expect(w.ammo).toBe(4);
      expect(w.boltCycling).toBe(true);
    });

    it('is blocked during the bolt cycle (reason bolt) and uses no round', () => {
      const w = new Weapon(5);
      w.fire();
      w.update(BOLT_TIME_S - 0.1);
      expect(w.fire()).toEqual({ fired: false, reason: 'bolt' });
      expect(w.ammo).toBe(4);
    });

    it('is allowed again once the bolt cycle is over', () => {
      const w = new Weapon(5);
      w.fire();
      w.update(BOLT_TIME_S);
      expect(w.boltCycling).toBe(false);
      expect(w.fire()).toEqual({ fired: true, boltCycle: true });
      expect(w.ammo).toBe(3);
    });

    it('five fast clicks fire exactly one round', () => {
      const w = new Weapon(5);
      const results = [];
      for (let i = 0; i < 5; i++) {
        results.push(w.fire());
        w.update(0.1);
      }
      expect(results.filter((r) => r.fired)).toHaveLength(1);
      expect(w.ammo).toBe(4);
    });

    it('is blocked during a reload (reason reloading)', () => {
      const w = new Weapon(5);
      w.fire();
      w.update(BOLT_TIME_S);
      expect(w.reload()).toBe(true);
      expect(w.fire()).toEqual({ fired: false, reason: 'reloading' });
      expect(w.ammo).toBe(4);
    });

    it('reports reloading rather than empty when the magazine is empty and a reload is running', () => {
      const w = new Weapon(1);
      w.fire();
      expect(w.ammo).toBe(0);
      w.reload();
      expect(w.fire()).toEqual({ fired: false, reason: 'reloading' });
    });

    it('is blocked with an empty magazine (reason empty)', () => {
      const w = new Weapon(1);
      expect(w.fire().fired).toBe(true);
      expect(w.fire()).toEqual({ fired: false, reason: 'empty' });
      expect(w.ammo).toBe(0);
    });

    it('the last round leaves ammo 0 and no bolt lockout', () => {
      const w = new Weapon(2);
      w.fire();
      w.update(BOLT_TIME_S);
      expect(w.fire()).toEqual({ fired: true, boltCycle: false });
      expect(w.ammo).toBe(0);
      expect(w.boltCycling).toBe(false);
    });
  });

  describe('reload', () => {
    it('refills the magazine after 1.5 s', () => {
      const w = new Weapon(5);
      w.fire();
      w.update(BOLT_TIME_S);
      w.fire();
      expect(w.ammo).toBe(3);
      expect(w.reload()).toBe(true);
      expect(w.reloading).toBe(true);
      expect(w.update(RELOAD_TIME_S - 0.01)).toBe(false);
      expect(w.reloading).toBe(true);
      expect(w.ammo).toBe(3);
      expect(w.update(0.01)).toBe(true); // true on the frame the reload completes
      expect(w.reloading).toBe(false);
      expect(w.ammo).toBe(5);
      expect(w.update(1)).toBe(false);
    });

    it('works right after a shot (the bolt lockout runs out inside the reload)', () => {
      const w = new Weapon(5);
      w.fire();
      expect(w.reload()).toBe(true);
      w.update(RELOAD_TIME_S);
      expect(w.ammo).toBe(5);
      expect(w.boltCycling).toBe(false);
      expect(w.fire().fired).toBe(true);
    });

    it('accumulated small frame steps still finish the reload', () => {
      const w = new Weapon(5);
      w.fire();
      w.reload();
      for (let i = 0; i < 15; i++) w.update(0.1);
      expect(w.reloading).toBe(false);
      expect(w.ammo).toBe(5);
    });

    it('does nothing with a full magazine', () => {
      const w = new Weapon(5);
      expect(w.reload()).toBe(false);
      expect(w.reloading).toBe(false);
    });

    it('does nothing while already reloading (the timer is not restarted)', () => {
      const w = new Weapon(5);
      w.fire();
      expect(w.reload()).toBe(true);
      w.update(1);
      expect(w.reload()).toBe(false);
      expect(w.update(0.5)).toBe(true);
      expect(w.ammo).toBe(5);
    });
  });

  describe('update', () => {
    it('ignores zero, negative and non-finite frame times', () => {
      const w = new Weapon(5);
      w.fire();
      w.reload();
      for (const dt of [0, -1, NaN, Infinity, -Infinity]) expect(w.update(dt)).toBe(false);
      expect(w.reloading).toBe(true);
      expect(w.boltCycling).toBe(true);
      w.update(RELOAD_TIME_S);
      expect(w.ammo).toBe(5);
    });
  });
});

describe('Weapon: per-rifle timing', () => {
  it('keeps the .308 timing as the default', () => {
    const w = new Weapon(5);
    expect([w.boltTimeS, w.reloadTimeS]).toEqual([BOLT_TIME_S, RELOAD_TIME_S]);
    const r = new Weapon(5, RIFLES['308']);
    expect([r.boltTimeS, r.reloadTimeS]).toEqual([1.2, 1.5]);
  });

  it('locks each rifle out for its own bolt (or semi-auto cycle) and reload', () => {
    for (const rifle of Object.values(RIFLES)) {
      const w = new Weapon(rifle.magazine, rifle);
      expect(w.fire()).toEqual({ fired: true, boltCycle: true });
      w.update(rifle.boltTimeS - 0.01);
      expect(w.fire()).toEqual({ fired: false, reason: 'bolt' });
      w.update(0.01);
      expect(w.fire().fired).toBe(true);
      expect(w.reload()).toBe(true);
      w.update(rifle.reloadTimeS - 0.01);
      expect(w.fire()).toEqual({ fired: false, reason: 'reloading' });
      expect(w.update(0.01)).toBe(true);
      expect(w.ammo).toBe(rifle.magazine);
    }
  });

  it('the semi-automatic .50 empties its ten rounds in a few seconds; the heavy bolt guns are slower than the .308', () => {
    const fifty = new Weapon(RIFLES['50'].magazine, RIFLES['50']);
    let shots = 0;
    for (let t = 0; t < 4; t += 0.05) {
      if (fifty.fire().fired) shots++;
      fifty.update(0.05);
    }
    expect(shots).toBe(10);
    for (const id of ['408', '127'] as const) expect(new Weapon(5, RIFLES[id]).boltTimeS).toBeGreaterThan(BOLT_TIME_S);
  });
});
