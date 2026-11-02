// The enemy snipers' side of a mission (spec B.4): how well they have spotted the player, when they
// fire, when a bombardment is called, and how much health is left. Pure and readable on purpose:
// exposure, telegraphed attacks and cover. No scene, no DOM, no clock of its own (the caller feeds it
// frame times), so every number below is unit-tested in Node.

/** Every tuning number of the encounter (spec B.4, verbatim). */
export const ENCOUNTER = {
  healthMax: 100,
  /** Detection added by one unsuppressed shot, % points. */
  detectShot: 35,
  /** Detection added by one suppressed shot. */
  detectShotSuppressed: 9,
  /** Detection gained per second while exposed. */
  exposedPerS: 4,
  /** Detection lost per second in cover. */
  coverPerS: 9,
  /** At this detection or more the snipers fire and bombardments are called. */
  fireThreshold: 65,
  sniperIntervalS: 4,
  /** Health lost per sniper shot at an exposed player (a shot at a player in cover does nothing). */
  sniperDamage: 18,
  bombardIntervalS: 12,
  /** Seconds between "incoming" and the bombardment landing. */
  bombardWarningS: 4,
  bombardDamage: 45,
  bombardDamageCover: 5,
} as const;

/** What happened during one update: a sniper fired at the player, or a bombardment landed. */
export type EncounterEvent = 'shot' | 'blast';

const NONE: readonly EncounterEvent[] = [];
/** Summed frame times can fall a hair short of a whole number of seconds. */
const TIMER_EPSILON = 1e-9;

const clamp100 = (v: number): number => Math.max(0, Math.min(100, v));

export class Encounter {
  health: number = ENCOUNTER.healthMax;
  /** 0..100 %: how well the enemy has found the player. */
  detection = 0;
  /** Seconds the snipers have spent aiming since their last shot (counts only while detection is high). */
  sniperClock = 0;
  /** Seconds since the last bombardment was called (counts only while detection is high). */
  mortarClock = 0;
  /** Seconds left until the called bombardment lands; 0 when none is coming. */
  warning = 0;
  /** The encounter is over: the player is dead or no sniper is left. Nothing happens any more. */
  ended = false;

  /** The player is dead (the mission is failed). */
  get failed(): boolean {
    return this.health <= 0;
  }

  /** The snipers are firing: detection is at or above the threshold. */
  get firing(): boolean {
    return this.detection >= ENCOUNTER.fireThreshold;
  }

  /** Seconds until the next sniper shot (meaningful while `firing`). */
  get fireIn(): number {
    return Math.max(0, ENCOUNTER.sniperIntervalS - this.sniperClock);
  }

  /** The player fired a shot: the muzzle blast gives the position away (less with a suppressor). */
  shot(suppressed: boolean): void {
    this.setDetection(this.detection + (suppressed ? ENCOUNTER.detectShotSuppressed : ENCOUNTER.detectShot));
  }

  /** Set the detection directly (clamped to 0..100); the debug hook uses it to force incoming fire. */
  setDetection(value: number): void {
    this.detection = Number.isFinite(value) ? clamp100(value) : 0;
  }

  /**
   * Advance by `dt` seconds. `alive` is the number of enemy snipers still up, `covered` whether the player
   * is ducked, `paused` that the game is not running (pointer free, results on screen): a paused update
   * changes nothing at all. Returns what happened, in order (a frame can hold both a blast and a shot).
   */
  update(dt: number, alive: number, covered: boolean, paused: boolean): readonly EncounterEvent[] {
    if (this.ended || paused) return NONE;
    if (alive <= 0 || this.health <= 0) {
      this.ended = true;
      return NONE;
    }
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    this.detection = clamp100(this.detection + step * (covered ? -ENCOUNTER.coverPerS : ENCOUNTER.exposedPerS));

    const events: EncounterEvent[] = [];
    if (this.warning > 0) {
      this.warning = Math.max(0, this.warning - step);
      if (this.warning <= TIMER_EPSILON) {
        this.warning = 0;
        this.health = Math.max(0, this.health - (covered ? ENCOUNTER.bombardDamageCover : ENCOUNTER.bombardDamage));
        events.push('blast');
      }
    }
    if (this.detection >= ENCOUNTER.fireThreshold) {
      this.sniperClock += step;
      this.mortarClock += step;
      if (this.mortarClock >= ENCOUNTER.bombardIntervalS - TIMER_EPSILON) {
        this.mortarClock = 0;
        this.warning = ENCOUNTER.bombardWarningS;
      }
      if (this.sniperClock >= ENCOUNTER.sniperIntervalS - TIMER_EPSILON) {
        this.sniperClock = 0;
        if (!covered) this.health = Math.max(0, this.health - ENCOUNTER.sniperDamage);
        events.push('shot');
      }
    }
    if (this.health <= 0) this.ended = true;
    return events.length > 0 ? events : NONE;
  }
}
