import type { Vec3 } from '../ballistics/types';
import { distance, impactSoundDelay } from '../audio/timing';
import type { ImpactEvent } from '../game/bullets';
import type { ZoneName } from '../game/hit';
import { recordImpact } from './stats';
import type { MissionStats } from './stats';

// What one bullet impact means for the mission, decided without touching the scene, the DOM or the
// audio (so it is unit-tested in Node): the new score, which target goes out of play, the HUD text, the
// effect to spawn and the sound to play. `run.ts` carries the result out.

/** Zone names as the HUD shows them. */
const ZONE_LABEL: Record<ZoneName, string> = {
  head: 'Head',
  upperTorso: 'Upper torso',
  lowerTorso: 'Lower torso',
  limbs: 'Limb',
  engine: 'Engine',
};

/** What the mission knows about a target id: what it is and whether it is already out of play. */
export interface ImpactTargetInfo {
  kind: 'soldier' | 'vehicle';
  /** A soldier already knocked down, a vehicle already disabled (two bullets in flight can reach the same target). */
  down: boolean;
}

/** Everything `applyImpact` reads. */
export interface ImpactState {
  stats: MissionStats;
  shooter: Vec3;
  /** m/s, of the mission's air: the impact sound travels back to the shooter at this speed. */
  speedOfSound: number;
  /** Timestamp of the frame being processed, ms (the end of the mission is stamped with it). */
  nowMs: number;
  /** The target behind an id, or undefined for an id the mission does not know. */
  target(id: string): ImpactTargetInfo | undefined;
}

export type ImpactFxKind = 'dust' | 'sparks';
export type ImpactSoundKind = 'hit' | 'metal' | 'dust';

export interface ImpactResult {
  /** The stats after this impact (the same object when the impact is not a hit). */
  stats: MissionStats;
  /** The soldier to knock down or the vehicle to disable; null when this impact takes nothing out. */
  killedTargetId: string | null;
  hud: {
    /** The result line, or null to leave the last one. */
    result: string | null;
    /** Whether the targets-left line must be redrawn (it follows the live target list, which only the caller knows). */
    refreshTargets: boolean;
  };
  fx: { kind: ImpactFxKind; point: Vec3 } | null;
  /** The sound to play, `delayS` after now (the way back to the shooter) and `distanceM` away (it gets duller and quieter). */
  sound: { kind: ImpactSoundKind; delayS: number; distanceM: number } | null;
}

/**
 * Decide what one impact does. Pure: it changes nothing it is given. The caller executes the result and
 * applies each event before the next one, so a soldier knocked down by the first of two bullets arriving
 * in the same frame is already `down` when the second is applied and is not counted as a kill again.
 */
export function applyImpact(event: ImpactEvent, state: ImpactState): ImpactResult {
  // The event fires when the bullet arrives; the sound still has to travel back to the shooter.
  if (event.kind === 'expired') {
    return { stats: state.stats, killedTargetId: null, hud: { result: 'MISS', refreshTargets: false }, fx: null, sound: null };
  }
  const distanceM = distance(event.point, state.shooter);
  const delayS = impactSoundDelay(event.point, state.shooter, state.speedOfSound);

  if (event.kind === 'target') {
    const info = state.target(event.targetId);
    let killed = false;
    let result: string | null = null;
    let fx: ImpactResult['fx'] = null;
    let sound: ImpactResult['sound'] = null;
    if (info?.kind === 'soldier') {
      killed = !info.down;
      sound = { kind: 'hit', delayS, distanceM };
      result = `HIT – ${ZONE_LABEL[event.zone]} – ${event.time.toFixed(2)} s`;
    } else if (info?.kind === 'vehicle') {
      killed = !info.down;
      fx = { kind: 'sparks', point: event.point };
      sound = { kind: 'metal', delayS, distanceM };
      result = 'VEHICLE DISABLED';
    }
    return {
      stats: recordImpact(state.stats, event, killed, distanceM, state.nowMs),
      killedTargetId: killed ? event.targetId : null,
      hud: { result, refreshTargets: true },
      fx,
      sound,
    };
  }

  if (event.kind === 'obstacle') {
    if (event.material === 'metal') {
      return {
        stats: state.stats,
        killedTargetId: null,
        hud: { result: 'Hit cover (metal)', refreshTargets: false },
        fx: { kind: 'sparks', point: event.point },
        sound: { kind: 'metal', delayS, distanceM },
      };
    }
    return {
      stats: state.stats,
      killedTargetId: null,
      hud: { result: 'Hit cover', refreshTargets: false },
      fx: { kind: 'dust', point: event.point },
      sound: { kind: 'dust', delayS, distanceM },
    };
  }

  return {
    stats: state.stats,
    killedTargetId: null,
    hud: { result: 'MISS', refreshTargets: false },
    fx: { kind: 'dust', point: event.point },
    sound: { kind: 'dust', delayS, distanceM },
  };
}
