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
  /** Mission clock start and end, ms (`performance.now()`); `endMs` is null until the last target goes down. */
  startMs: number;
  endMs: number | null;
}

export function newStats(targetsTotal: number, nowMs: number): MissionStats {
  return { shots: 0, hits: 0, headshots: 0, targetsDown: 0, targetsTotal, longestHitM: 0, startMs: nowMs, endMs: null };
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

/** Every target is down (a mission with no targets is never complete). */
export function isComplete(s: MissionStats): boolean {
  return s.targetsTotal > 0 && s.targetsDown >= s.targetsTotal;
}
