import type { Vec3 } from '../ballistics/types';
import type { MissionStats } from './stats';
import type { Soldier, Vehicle } from './world';

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
  /** Draw calls and triangles of the last rendered frame. */
  render: { calls: number; triangles: number };
}

/**
 * Debug/automation hook, `window.__game`: the same functions the mouse and keys call. Only exposed
 * in dev builds or with `?debug=1` in the URL (the headless smoke check uses it).
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
  render(): { calls: number; triangles: number };
}

/** Expose `window.__game`. The hook calls the handlers directly: it needs no pointer lock and does not touch the pointer. */
export function installDebugHook(actions: Omit<GameDebugHook, 'state'>, sources: DebugSources): void {
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
      render: sources.render(),
    }),
  };
}
