/** Seconds to swap a magazine. */
export const RELOAD_TIME_S = 1.5;
/** Seconds to work the bolt after a shot that leaves rounds in the magazine. */
export const BOLT_TIME_S = 1.2;

/** Remaining times at or below this count as elapsed (summed frame times leave ~1e-16 behind). */
const TIMER_EPSILON = 1e-9;

/** Why a shot did not go off. */
export type FireBlockReason = 'reloading' | 'bolt' | 'empty';

export type FireResult =
  /** A round was fired; `boltCycle` is true when the bolt lockout started (not after the last round). */
  | { fired: true; boltCycle: boolean }
  | { fired: false; reason: FireBlockReason };

/**
 * Magazine, reload and bolt-cycle state of a bolt-action rifle. Pure: time only moves through
 * `update(dt)`, so it is unit-testable without a clock, DOM or audio.
 */
export class Weapon {
  readonly magazine: number;
  private rounds: number;
  private reloadRemaining = 0;
  private boltRemaining = 0;

  constructor(magazine: number) {
    this.magazine = magazine;
    this.rounds = magazine;
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
    if (boltCycle) this.boltRemaining = BOLT_TIME_S;
    return { fired: true, boltCycle };
  }

  /**
   * Start swapping the magazine. Returns false (and changes nothing) when it is already running or
   * the magazine is full. It is allowed during the bolt cycle: that lockout (1.2 s) runs out inside
   * the reload (1.5 s), and fire() reports 'reloading' until it is done.
   */
  reload(): boolean {
    if (this.reloading || this.rounds >= this.magazine) return false;
    this.reloadRemaining = RELOAD_TIME_S;
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
