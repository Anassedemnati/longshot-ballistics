import type { Vec3 } from '../ballistics/types';
import type { Awareness } from '../game/encounter';
import type { SquadState } from '../game/squad';
import type { MissionStats } from './stats';
import type { MemberState } from './squadDirector';
import type { EnemySniper, Soldier, Vehicle } from './world';

/** What `window.__game.state()` returns: the score and enough about the targets for the smoke check to aim. */
export interface GameDebugState {
  stats: MissionStats;
  targetsLeft: number;
  /** Every target is down and the mission would show its results (always false on the legacy practice route). */
  complete: boolean;
  /** True once the results overlay is on screen. */
  resultsShown: boolean;
  soldiers: Array<{ id: string; head: Vec3; upperTorso: Vec3; lowerTorso: Vec3; behindCover: boolean; down: boolean }>;
  vehicles: Array<{ id: string; engine: Vec3; disabled: boolean }>;
  /** Enemy snipers: where to aim, whether the scope glint is on screen, whether he is down. */
  snipers: Array<{ id: string; site: string; head: Vec3; upperTorso: Vec3; glint: boolean; down: boolean }>;
  /** Player health, 0..100 (100 and never changing in a mission without snipers). */
  health: number;
  /** How well the snipers have found the player, 0..100 %. */
  detection: number;
  /** The player is ducked behind cover. */
  covered: boolean;
  /** How well the snipers know where the player is ('unaware' in a mission without snipers). */
  awareness: Awareness;
  /** Enemy snipers still up. */
  snipersLeft: number;
  /** The soldiers that fight back: the squad's state and knowledge (0..1) of where the player lies, and what each soldier is doing; null when the soldiers stand still. */
  squad: { state: SquadState; knowledge: number; soldiers: MemberState[] } | null;
  /** Draw calls and triangles of the last rendered frame. */
  render: { calls: number; triangles: number };
}

/**
 * Debug/automation hook, `window.__game`: the same functions the mouse and keys call. Only exposed
 * in dev builds or with `?debug=1` in the URL (the headless smoke check uses it). The two cheats that change the
 * fight (`setDetection`, `setHealth`) are only part of it with `?debug=1`.
 */
export interface GameDebugHook {
  toggleScope(): void;
  zoom(notches: number): void;
  fire(): void;
  reload(): void;
  /** What the first click does: create the audio context (it needs no pointer lock) and start the wind. */
  unlockAudio(): void;
  state(): GameDebugState;
  /** Point the view at a world position (the crosshair, not the bullet: it adds no hold-over). */
  aimAt(x: number, y: number, z: number): void;
  /**
   * Force the detection (0..100 %), so a check can bring on incoming fire without firing. No effect without snipers.
   * A cheat: only there with `?debug=1`, not on a dev server's plain URL.
   */
  setDetection?(percent: number): void;
  /** Set the player's health (1..100), so a check can reach the Mission failed screen quickly. No effect without snipers. Only with `?debug=1`, like setDetection. */
  setHealth?(points: number): void;
  /** Set how much of the player's position the squad knows (0..1), so a check can bring on their aimed fire and mortars at once. No effect when the soldiers stand still. Only with `?debug=1`. */
  setSquadKnowledge?(value: number): void;
}

declare global {
  interface Window {
    __game?: GameDebugHook;
  }
}

/** Live readings `state()` takes each time it is called (the game's score and flags are reassigned as it runs). */
export interface DebugSources {
  stats(): MissionStats;
  targetsLeft(): number;
  complete(): boolean;
  resultsShown(): boolean;
  soldiers: ReadonlyMap<string, Soldier>;
  vehicles: ReadonlyMap<string, Vehicle>;
  snipers: ReadonlyMap<string, EnemySniper>;
  /** The fight with the snipers; null in a mission without any. */
  combat: {
    health(): number;
    detection(): number;
    covered(): boolean;
    awareness(): Awareness;
    snipersLeft(): number;
  } | null;
  /** The squad of soldiers that fight back; null when the soldiers stand still. */
  squad: { state(): SquadState; knowledge(): number; soldiers(): MemberState[] } | null;
  render(): { calls: number; triangles: number };
}

/** Expose `window.__game`. The hook calls the handlers directly: it needs no pointer lock and does not touch the pointer. */
export function installDebugHook(actions: Omit<GameDebugHook, 'state'>, sources: DebugSources): void {
  const fight = sources.combat;
  window.__game = {
    ...actions,
    state: () => ({
      stats: sources.stats(),
      targetsLeft: sources.targetsLeft(),
      complete: sources.complete(),
      resultsShown: sources.resultsShown(),
      soldiers: [...sources.soldiers.values()].map((s) => ({
        id: s.placement.id,
        head: s.head,
        upperTorso: s.upperTorso,
        lowerTorso: s.lowerTorso,
        behindCover: s.placement.behindCover,
        down: s.dummy.down,
      })),
      vehicles: [...sources.vehicles.values()].map((v) => ({
        id: v.placement.id,
        engine: v.engineCenter,
        disabled: v.target.disabled,
      })),
      snipers: [...sources.snipers.values()].map((k) => ({
        id: k.placement.id,
        site: k.placement.site,
        head: k.head,
        upperTorso: k.upperTorso,
        glint: k.sniper.glintVisible,
        down: k.sniper.down,
      })),
      health: fight ? fight.health() : 100,
      detection: fight ? fight.detection() : 0,
      covered: fight ? fight.covered() : false,
      awareness: fight ? fight.awareness() : 'unaware',
      snipersLeft: fight ? fight.snipersLeft() : 0,
      squad: sources.squad && { state: sources.squad.state(), knowledge: sources.squad.knowledge(), soldiers: sources.squad.soldiers() },
      render: sources.render(),
    }),
  };
}
