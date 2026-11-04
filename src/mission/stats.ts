import type { ImpactEvent } from '../game/bullets';

// Score keeping for one mission: pure, immutable updates (each function returns a new object), so the
// results screen and the tests need nothing but this file.

export interface MissionStats {
  shots: number;
  /** Bullets that struck a target (any zone, limbs and engines included). Cover and ground are not hits. */
  hits: number;
  headshots: number;
  targetsDown: number;
  targetsTotal: number;
  /** Farthest distance, m, at which a bullet struck a target. */
  longestHitM: number;
  /**
   * Mission clock start and end, ms (`performance.now()`). The clock starts with the player's first move
   * (see `startClock`), so time spent on the loading screen or idle before the first aim does not count:
   * `startMs` is null until then, `endMs` until the last target goes down.
   */
  startMs: number | null;
  endMs: number | null;
  /** An aim assist (trajectory preview, aim marker, spotter) was on at some point of the mission. */
  assistsUsed: boolean;
  /** The player was killed by the enemy snipers or a bombardment: the mission is failed (never complete). */
  failed: boolean;
  /** Why a failed mission failed: the player was killed (the default, also when absent) or the HVT got away. */
  failReason?: 'killed' | 'escaped';
  /** What the mission asks (absent: clear the area). An `hvt` mission is complete when the HVT is down, whatever else stands. */
  objective?: 'clear' | 'hvt';
  /** `hvt` missions: the HVT is down, the range of the shot that killed him (m), and his bodyguards killed out of how many. */
  hvtDown?: boolean;
  hvtRangeM?: number;
  guardsDown?: number;
  guardsTotal?: number;
}

/**
 * Fresh stats. The clock is stopped (`startMs` null) unless `nowMs` is given. `hvt` (an HVT mission): his bodyguards' count; the stats then carry
 * the objective and the HVT's fields.
 */
export function newStats(targetsTotal: number, nowMs: number | null = null, hvt?: { guards: number }): MissionStats {
  return {
    ...(hvt ? { objective: 'hvt' as const, hvtDown: false, hvtRangeM: 0, guardsDown: 0, guardsTotal: hvt.guards } : {}),
    shots: 0,
    hits: 0,
    headshots: 0,
    targetsDown: 0,
    targetsTotal,
    longestHitM: 0,
    startMs: nowMs,
    endMs: null,
    assistsUsed: false,
    failed: false,
  };
}

/** Start the mission clock at `nowMs` if it is not running yet; a running clock keeps its start. */
export function startClock(s: MissionStats, nowMs: number): MissionStats {
  return s.startMs === null ? { ...s, startMs: nowMs } : s;
}

/** Mission time so far, ms: from the clock start to the end (0 while the clock has not started or the end is missing). */
export function elapsedMs(s: MissionStats): number {
  if (s.startMs === null) return 0;
  return Math.max(0, (s.endMs ?? s.startMs) - s.startMs);
}

/** An aim assist was switched on: the results say so. Already flagged: the same object. */
export function markAssistsUsed(s: MissionStats): MissionStats {
  return s.assistsUsed ? s : { ...s, assistsUsed: true };
}

/**
 * The player is dead (or, `reason` 'escaped', the HVT got away): the mission is failed and its clock stops now (a mission already complete
 * or failed is left alone).
 */
export function recordFailure(s: MissionStats, nowMs: number, reason: 'killed' | 'escaped' = 'killed'): MissionStats {
  if (s.failed || isComplete(s)) return s;
  return { ...s, failed: true, endMs: s.endMs ?? nowMs, ...(reason === 'escaped' ? { failReason: reason } : {}) };
}

/** The HVT is down, killed by a shot from `rangeM` m: an `hvt` mission is complete, and its clock stops now. */
export function recordHvtDown(s: MissionStats, rangeM: number, nowMs: number): MissionStats {
  if (s.failed || s.hvtDown) return s;
  return { ...s, hvtDown: true, hvtRangeM: rangeM, endMs: s.endMs ?? nowMs };
}

/** One of the HVT's bodyguards is down. */
export function recordGuardDown(s: MissionStats): MissionStats {
  return { ...s, guardsDown: Math.min(s.guardsTotal ?? Infinity, (s.guardsDown ?? 0) + 1) };
}

/** One more round fired. */
export function recordShot(s: MissionStats): MissionStats {
  return { ...s, shots: s.shots + 1 };
}

/**
 * Fold one impact into the stats. Only `target` events count as hits; `killed` says the hit took the
 * target out (a soldier down, an engine disabled), `rangeM` is the distance shooter -> impact. The end
 * time is stamped once, by the impact that downs the last target.
 */
export function recordImpact(
  s: MissionStats,
  e: ImpactEvent,
  killed: boolean,
  rangeM: number,
  nowMs: number,
): MissionStats {
  if (e.kind !== 'target') return s;
  const next: MissionStats = {
    ...s,
    hits: s.hits + 1,
    headshots: s.headshots + (e.zone === 'head' ? 1 : 0),
    targetsDown: killed ? Math.min(s.targetsTotal, s.targetsDown + 1) : s.targetsDown,
    longestHitM: Math.max(s.longestHitM, rangeM),
  };
  if (next.endMs === null && isComplete(next)) next.endMs = nowMs;
  return next;
}

/** Hits per shot, 0..1; 0 when nothing has been fired. */
export function accuracy(s: MissionStats): number {
  return s.shots > 0 ? s.hits / s.shots : 0;
}

/**
 * Every target is down, soldiers, vehicle targets and enemy snipers alike (a mission with no targets is never complete; a failed one neither).
 * An `hvt` mission: the HVT is down (the other targets need not be).
 */
export function isComplete(s: MissionStats): boolean {
  if (s.failed) return false;
  if (s.objective === 'hvt') return s.hvtDown === true;
  return s.targetsTotal > 0 && s.targetsDown >= s.targetsTotal;
}
