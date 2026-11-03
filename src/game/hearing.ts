// When the enemy learns that a shot was fired, and what it tells him (pure: no scene, no DOM, no clock of its own).
//
// A rifle shot reaches a listener in up to three ways, each at its own moment:
//   * the MUZZLE REPORT, the bang at the rifle, travels at the speed of sound: it reaches a man `d` metres away `d / c` seconds
//     after the trigger is pulled, and it points straight back at the shooter (a report is easy to localise). A suppressor cuts it
//     to a cough that is lost in the wind past `HEARING.suppressedReportM`; inside that it is a weak cue that gives no direction.
//   * the BALLISTIC CRACK, the little sonic boom of a supersonic bullet, is heard where the bullet passes, as it passes (plus the
//     few hundredths of a second its sound needs to cover the miss distance). Only while the bullet is still faster than sound:
//     a .308 drops through Mach 1 somewhere past 800 m, the 12.7x55 subsonic round never cracks at all. The crack alarms whoever
//     it passes but is famously hard to localise, so it tells him nothing about where the shooter is.
//   * the IMPACT: the dust of a bullet that lands close by, a man near him going down. Seen, not heard, so it arrives at once.
//
// A supersonic bullet outruns its own report, so the first shot at a man who has heard nothing lands before he can react: the
// report reaches him after the bullet, and the crack only with it. A subsonic bullet is outrun by its report, which reaches the
// target first, so an unsuppressed subsonic shot at long range gives him a moment to start moving.
//
// `CueQueue` holds the cues that are on their way and hands each one out, in game time, when it arrives at its listener group.

/** Every number of the hearing model. */
export const HEARING = {
  /**
   * A supersonic bullet passing within this of a listener is heard as a crack, m. The shock cone of a rifle bullet is audible much
   * farther out, but beyond some 20-30 m it no longer reads as "a round went past me" over the noise of a camp.
   */
  crackRadiusM: 25,
  /**
   * A suppressed report is still heard, as a weak cue with no direction, up to this far from the rifle, m. A suppressed .308 is
   * still about 135 dB at the muzzle (a nail gun); spread over 200 m and masked by wind and engines, a man that far off may catch a
   * dull thud but cannot place it, and farther out he hears nothing at all.
   */
  suppressedReportM: 200,
  /** A bullet that lands this close to a listener is seen (the dust, the strike on a wall), m. */
  impactSeenM: 10,
} as const;

/** How a cue reached the listener. */
export type CueKind = 'report' | 'crack' | 'impact';

/** One cue on its way to one group of listeners. */
export interface Cue<G extends string = string> {
  kind: CueKind;
  /** Who it is for (the enemy snipers, the squad, the HVT's party...). */
  group: G;
  /** Game time it arrives, s. */
  at: number;
  /** It points back at the shooter (a report the listener can place). */
  directional: boolean;
  /** A suppressed report: the weak amount of what it would add. */
  suppressed: boolean;
}

/** What the report of one shot does to a listener `distanceM` from the muzzle: when it arrives (s after the shot) and whether it gives the shooter away. */
export interface ReportArrival {
  delayS: number;
  directional: boolean;
}

/**
 * The muzzle report at a listener `distanceM` from the rifle: heard `distanceM / speedOfSound` after the shot. Unsuppressed it is
 * heard at any range of a mission and gives the shooter's direction; suppressed it is a weak cue without direction up to
 * `HEARING.suppressedReportM`, and nothing at all beyond. Null when it is not heard (or the distance is not a number).
 */
export function reportArrival(distanceM: number, speedOfSound: number, suppressed: boolean): ReportArrival | null {
  if (!(distanceM >= 0) || !(speedOfSound > 0)) return null;
  if (suppressed && distanceM > HEARING.suppressedReportM) return null;
  return { delayS: distanceM / speedOfSound, directional: !suppressed };
}

/** True when a bullet that passed `passM` metres from a listener at `bulletSpeed` m/s cracks for him: close enough, and still faster than sound. */
export function crackHeard(passM: number, bulletSpeed: number, speedOfSound: number): boolean {
  return passM <= HEARING.crackRadiusM && bulletSpeed > speedOfSound;
}

/**
 * When the crack of a bullet is heard, s after the shot: the bullet's flight time to the point where it passed closest (`passTimeS`),
 * plus the time its sound needs to cover the miss distance.
 */
export function crackDelay(passTimeS: number, passM: number, speedOfSound: number): number {
  return passTimeS + Math.max(0, passM) / speedOfSound;
}

/**
 * The cues on their way, delivered in game time. A cue scheduled for a time already past is delivered on the next `deliver`.
 * Tiny: a handful of cues per shot, so a sorted array is all it needs.
 */
export class CueQueue<G extends string = string> {
  private readonly items: Cue<G>[] = [];

  /** Cues still on their way. */
  get pending(): number {
    return this.items.length;
  }

  /** Put a cue on its way (kept in arrival order; equal times keep the order they were scheduled in). */
  schedule(cue: Cue<G>): void {
    if (!Number.isFinite(cue.at)) return;
    let i = this.items.length;
    while (i > 0 && this.items[i - 1].at > cue.at) i--;
    this.items.splice(i, 0, cue);
  }

  /** Hand every cue that has arrived by game time `now` (s) to `deliver`, oldest first, and forget it. */
  deliver(now: number, deliver: (cue: Cue<G>) => void): void {
    let n = 0;
    while (n < this.items.length && this.items[n].at <= now) n++;
    if (n === 0) return;
    const due = this.items.splice(0, n);
    for (const cue of due) deliver(cue);
  }

  /** Forget every cue (the mission is over). */
  clear(): void {
    this.items.length = 0;
  }
}
