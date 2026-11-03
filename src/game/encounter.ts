// The enemy snipers' side of a mission (spec B.4): how well they have spotted the player, when they
// fire, when a bombardment is called, and how much health is left. Pure and readable on purpose:
// exposure, telegraphed attacks and cover. No scene, no DOM, no clock of its own (the caller feeds it
// frame times), so every number below is unit-tested in Node.
//
// On top of the 0..100 % detection sits the snipers' awareness (`Awareness`): unaware, searching, firing. A player
// in a ghillie suit (`camo`) cannot be picked out by sight alone: until he fires, the exposure only ever builds a
// little detection and the snipers stay unaware. A shot gives him away by its muzzle report and by the crack and
// dust of the bullet, which point back at him (`shot`, `bulletCue`); from then on they search for him.

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

/**
 * The numbers of the snipers' awareness and of the ghillie suit. The encounter's own numbers above are spec B.4 verbatim and
 * stay as they are; everything that is new lives here.
 */
export const AWARENESS = {
  /** Without a ghillie suit: at this detection or more (and below the fire threshold) the snipers are searching for the player. */
  searchThreshold: 20,
  /** Ghillie suit, no shot fired yet: exposure alone never builds the detection past this, % (a still ghillie sniper is invisible). */
  camoCap: 30,
  /** Ghillie suit, no shot fired yet: detection gained per second while exposed, up to `camoCap`. */
  camoUnawarePerS: 1,
  /** Ghillie suit, after a shot: detection gained per second while exposed (they glass his sector, but the suit hides his outline). */
  camoSearchingPerS: 1.5,
  /** Ghillie suit: the muzzle report counts for this much of what it would (they hear it, but cannot confirm a shape). */
  camoMuzzleFactor: 0.8,
  /** A bullet that ends this close (m) to a live enemy sniper, or closer, adds the full `bulletCueMax`. */
  bulletCueNearM: 5,
  /** A bullet that ends this far (m) from every live enemy sniper, or farther, adds nothing. */
  bulletCueFarM: 60,
  /** Detection added by a bullet that passes within `bulletCueNearM`, % points; the cue falls off linearly to 0 at `bulletCueFarM`. */
  bulletCueMax: 25,
} as const;

/**
 * How well the snipers know where the player is: `unaware` (they have no idea, their scopes sweep lazily), `searching`
 * (a shot was heard or the player has been in view for a while: they know someone is there and look for him) or `firing`
 * (they have him: detection is at or above the fire threshold).
 */
export type Awareness = 'unaware' | 'searching' | 'firing';

/**
 * Detection, % points, that a bullet adds from the closest it came (m) to any live enemy sniper: the supersonic crack and the
 * dust where it landed point back at the shooter, and a suppressor does not hide either. The full `bulletCueMax` within
 * `bulletCueNearM`, down linearly to nothing at `bulletCueFarM`; 0 for a bullet that came near none (Infinity) or a bad number.
 */
export function bulletCueBump(closestPassM: number): number {
  const { bulletCueNearM: near, bulletCueFarM: far, bulletCueMax: max } = AWARENESS;
  if (!(closestPassM < far)) return 0; // far, Infinity and NaN
  if (closestPassM <= near) return max;
  return (max * (far - closestPassM)) / (far - near);
}

/** What the player's shot gave away: the muzzle report (quieter with a suppressor). */
export interface ShotCue {
  suppressed: boolean;
}

/** What an `Encounter` is told about the player. */
export interface EncounterOptions {
  /** The player wears a ghillie suit (default: no). */
  camo?: boolean;
}

/** What happened during one update: a sniper fired at the player, or a bombardment landed. */
export type EncounterEvent = 'shot' | 'blast';

const NONE: readonly EncounterEvent[] = [];
/** Summed frame times can fall a hair short of a whole number of seconds. */
const TIMER_EPSILON = 1e-9;

const clamp100 = (v: number): number => Math.max(0, Math.min(100, v));

export class Encounter {
  /** The player wears a ghillie suit: the exposure builds little detection until he fires (see AWARENESS). */
  readonly camo: boolean;
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
  /** A shot or a bullet has given the player away: the snipers know someone is there, for the rest of the mission. */
  private alerted = false;

  constructor(options: EncounterOptions = {}) {
    this.camo = options.camo === true;
  }

  /** The player is dead (the mission is failed). */
  get failed(): boolean {
    return this.health <= 0;
  }

  /** The snipers are firing: detection is at or above the threshold. */
  get firing(): boolean {
    return this.detection >= ENCOUNTER.fireThreshold;
  }

  /**
   * How well the snipers know where the player is: `firing` at or above the fire threshold; `searching` once a shot or a bullet
   * has given him away (for good), or, without a ghillie suit, once the detection reaches `AWARENESS.searchThreshold`; else `unaware`.
   */
  get awareness(): Awareness {
    if (this.firing) return 'firing';
    if (this.alerted || (!this.camo && this.detection >= AWARENESS.searchThreshold)) return 'searching';
    return 'unaware';
  }

  /** Seconds until the next sniper shot (meaningful while `firing`). */
  get fireIn(): number {
    return Math.max(0, ENCOUNTER.sniperIntervalS - this.sniperClock);
  }

  /**
   * The player fired a shot: the muzzle report gives the position away (less with a suppressor, and in a ghillie suit
   * the snipers hear it but cannot confirm a shape: `AWARENESS.camoMuzzleFactor` of it). The snipers are alerted for good.
   * A bare `true` / `false` is the same as `{ suppressed }`.
   */
  shot(cue: boolean | ShotCue): void {
    const suppressed = typeof cue === 'boolean' ? cue : cue.suppressed;
    const report = suppressed ? ENCOUNTER.detectShotSuppressed : ENCOUNTER.detectShot;
    this.alerted = true;
    this.setDetection(this.detection + report * (this.camo ? AWARENESS.camoMuzzleFactor : 1));
  }

  /**
   * A bullet's flight ended `closestPassM` metres from the closest live enemy sniper it passed (Infinity when it passed
   * none): the crack and the dust point back at the shooter, whatever the suppressor and the suit (see `bulletCueBump`).
   */
  bulletCue(closestPassM: number): void {
    const bump = bulletCueBump(closestPassM);
    if (bump <= 0) return;
    this.alerted = true;
    this.setDetection(this.detection + bump);
  }

  /** Set the detection directly (clamped to 0..100); the debug hook uses it to force incoming fire. */
  setDetection(value: number): void {
    this.detection = Number.isFinite(value) ? clamp100(value) : 0;
  }

  /**
   * The detection after `step` seconds, exposed or in cover. In cover it falls at the same rate for everyone. Exposed it rises
   * by `ENCOUNTER.exposedPerS`, except in a ghillie suit: before the first shot slowly and never past `AWARENESS.camoCap` (a
   * value already above it, set by hand, is left alone), after it at `AWARENESS.camoSearchingPerS`.
   */
  private afterExposure(step: number, covered: boolean): number {
    if (covered) return clamp100(this.detection - step * ENCOUNTER.coverPerS);
    if (!this.camo) return clamp100(this.detection + step * ENCOUNTER.exposedPerS);
    if (this.alerted) return clamp100(this.detection + step * AWARENESS.camoSearchingPerS);
    return this.detection >= AWARENESS.camoCap ? this.detection : Math.min(AWARENESS.camoCap, this.detection + step * AWARENESS.camoUnawarePerS);
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
    this.detection = this.afterExposure(step, covered);

    let events: EncounterEvent[] | null = null; // made only when something happens: most frames have no event
    if (this.warning > 0) {
      this.warning = Math.max(0, this.warning - step);
      if (this.warning <= TIMER_EPSILON) {
        this.warning = 0;
        this.health = Math.max(0, this.health - (covered ? ENCOUNTER.bombardDamageCover : ENCOUNTER.bombardDamage));
        (events ??= []).push('blast');
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
        (events ??= []).push('shot');
      }
    } else {
      // Below the threshold the snipers lose him: the aim and the next bombardment call start over.
      this.sniperClock = 0;
      this.mortarClock = 0;
    }
    if (this.health <= 0) this.ended = true;
    return events ?? NONE;
  }
}
