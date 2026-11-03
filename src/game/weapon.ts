/** Seconds to swap a magazine: the .308's, and the default when no timing is given (each rifle has its own, `Rifle.reloadTimeS`). */
export const RELOAD_TIME_S = 1.5;
/** Seconds to work the bolt after a shot that leaves rounds in the magazine: the .308's, and the default (see `Rifle.boltTimeS`). */
export const BOLT_TIME_S = 1.2;

/** How long a rifle's lockouts last, s: the bolt (or semi-automatic cycle) after a shot, and a magazine swap. */
export interface WeaponTiming {
  boltTimeS: number;
  reloadTimeS: number;
}

/** The .308's timing, the default. */
const DEFAULT_TIMING: WeaponTiming = { boltTimeS: BOLT_TIME_S, reloadTimeS: RELOAD_TIME_S };

/** Remaining times at or below this count as elapsed (summed frame times leave ~1e-16 behind). */
const TIMER_EPSILON = 1e-9;

/** Why a shot did not go off. */
export type FireBlockReason = 'reloading' | 'bolt' | 'empty';

export type FireResult =
  /** A round was fired; `boltCycle` is true when the bolt lockout started (not after the last round). */
  | { fired: true; boltCycle: boolean }
  | { fired: false; reason: FireBlockReason };

/**
 * Magazine, reload and bolt-cycle state of a rifle. Pure: time only moves through `update(dt)`, so it is unit-testable without a
 * clock, DOM or audio. `timing` is the rifle's (a `Rifle` will do); without it, the .308's 1.2 s bolt and 1.5 s reload. A
 * semi-automatic rifle is the same machine with a short cycle (0.35 s): there is no handle to work, but the next round still
 * needs the action to cycle and the sight to come back on.
 */
export class Weapon {
  readonly magazine: number;
  /** Lockout after a shot that leaves a round to chamber, s. */
  readonly boltTimeS: number;
  /** Magazine swap, s. */
  readonly reloadTimeS: number;
  private rounds: number;
  private reloadRemaining = 0;
  private boltRemaining = 0;

  constructor(magazine: number, timing: WeaponTiming = DEFAULT_TIMING) {
    this.magazine = magazine;
    this.rounds = magazine;
    this.boltTimeS = timing.boltTimeS;
    this.reloadTimeS = timing.reloadTimeS;
  }

  /** Rounds in the magazine. */
  get ammo(): number {
    return this.rounds;
  }

  get reloading(): boolean {
    return this.reloadRemaining > 0;
  }

  /** True while the bolt is being worked after a shot: the next round cannot be fired yet. */
  get boltCycling(): boolean {
    return this.boltRemaining > 0;
  }

  /**
   * Pull the trigger. Blocked while reloading, then while the bolt cycles, then with an empty
   * magazine. The last round of the magazine leaves nothing to chamber, so it starts no bolt cycle.
   */
  fire(): FireResult {
    if (this.reloading) return { fired: false, reason: 'reloading' };
    if (this.boltCycling) return { fired: false, reason: 'bolt' };
    if (this.rounds <= 0) return { fired: false, reason: 'empty' };
    this.rounds -= 1;
    const boltCycle = this.rounds > 0;
    if (boltCycle) this.boltRemaining = this.boltTimeS;
    return { fired: true, boltCycle };
  }

  /**
   * Start swapping the magazine. Returns false (and changes nothing) when it is already running or
   * the magazine is full. It is allowed during the bolt cycle: that lockout (1.2 s on the .308) runs out inside
   * the reload (1.5 s; every rifle's reload outlasts its bolt), and fire() reports 'reloading' until it is done.
   */
  reload(): boolean {
    if (this.reloading || this.rounds >= this.magazine) return false;
    this.reloadRemaining = this.reloadTimeS;
    return true;
  }

  /**
   * Advance time by `dt` seconds (zero, negative and non-finite values are ignored). Returns true on
   * the frame a reload completes and the magazine is full again.
   */
  update(dt: number): boolean {
    if (!Number.isFinite(dt) || dt <= 0) return false;
    if (this.boltRemaining > 0) {
      this.boltRemaining -= dt;
      if (this.boltRemaining <= TIMER_EPSILON) this.boltRemaining = 0;
    }
    if (this.reloadRemaining > 0) {
      this.reloadRemaining -= dt;
      if (this.reloadRemaining <= TIMER_EPSILON) {
        this.reloadRemaining = 0;
        this.rounds = this.magazine;
        return true;
      }
    }
    return false;
  }
}
