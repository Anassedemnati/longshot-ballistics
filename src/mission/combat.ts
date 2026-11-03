import type { Vec3 } from '../ballistics/types';
import type { Encounter, EncounterEvent } from '../game/encounter';
import type { Sniper } from '../scene/sniper';
import type { TerrainField } from '../scene/terrainField';
import { ThreatLine, flashIntensity } from '../ui/threat';
import type { ThreatState, ThreatView } from '../ui/threat';

// The enemy snipers' fight in one mission, between the pure `Encounter` and the screen: it feeds the
// encounter the frame time, sweeps the snipers' glints, turns fire and bombardments into dust, sound and a
// damage flash, keeps the threat line, and owns the cover (C) state. `run.ts` creates it only for a
// mission with snipers, so a training mission (0 snipers) has no incoming fire and no threat panel at all.

/** The part of a sniper the fight needs. */
export type CombatSniper = Pick<Sniper, 'down' | 'scan'>;

export interface CombatDeps {
  encounter: Encounter;
  snipers: readonly CombatSniper[];
  ui: ThreatView;
  field: TerrainField;
  /** The player's eye. */
  shooter: Vec3;
  /** The rifle has a suppressor: shots give the player away less. (A ghillie suit is the encounter's: `encounter.camo`.) */
  suppressed: boolean;
  /** Where the player is looking, rad (the view's yaw): incoming fire lands in front of him. */
  yaw(): number;
  fx: {
    /** A puff of dust at a world point. */
    dust(point: Vec3): void;
    /** The sound of an impact this far from the player. */
    impactSound(distanceM: number): void;
  };
  /** Take the rifle out of the scope (ducking into cover does). */
  dropScope(): void;
  /** The cache of the threat line (default: a new one); a test passes one with a counting formatter. */
  line?: ThreatLine;
}

/** Distances, m, of the impact sounds of a sniper bullet and of a bombardment (the shell lands close). */
const SHOT_SOUND_M = 5;
const BLAST_SOUND_M = 1;

/**
 * Where the dust of incoming fire rises: a few metres in front of the player on the ground, so it is in view.
 * A sniper's bullet kicks up one puff beside him (the side alternates with `n`); a bombardment three.
 */
export function incomingPoints(
  kind: EncounterEvent,
  n: number,
  shooter: Vec3,
  yaw: number,
  field: Pick<TerrainField, 'height'>,
): Vec3[] {
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const rx = Math.cos(yaw);
  const rz = -Math.sin(yaw);
  const at = (ahead: number, right: number): Vec3 => {
    const x = shooter.x + fx * ahead + rx * right;
    const z = shooter.z + fz * ahead + rz * right;
    return { x, y: field.height(x, z), z };
  };
  if (kind === 'shot') return [at(6, n % 2 === 0 ? 2 : -2)];
  return [at(4, -3), at(5, 0), at(4, 3)];
}

export class Combat {
  private readonly deps: CombatDeps;
  /** The player is ducked behind cover: no shooting, no scope, the screen is masked. */
  covered = false;
  /** Seconds the snipers have been sweeping (stops while the game is paused). */
  private clock = 0;
  private incoming = 0;
  /** What the threat line shows, refilled in place every frame (no object per frame). */
  private readonly state: ThreatState = {
    health: 0,
    detection: 0,
    covered: false,
    snipersLeft: 0,
    warning: 0,
    firing: false,
    awareness: 'unaware',
    camo: false,
    fireIn: 0,
    paused: false,
    failed: false,
    cleared: false,
  };
  private readonly line: ThreatLine;

  constructor(deps: CombatDeps) {
    this.deps = deps;
    this.line = deps.line ?? new ThreatLine();
  }

  get encounter(): Encounter {
    return this.deps.encounter;
  }

  /** Enemy snipers still up. */
  get snipersLeft(): number {
    let n = 0;
    for (const s of this.deps.snipers) if (!s.down) n++;
    return n;
  }

  /** The player fired: the muzzle blast raises the detection (less with a suppressor or a ghillie suit) and alerts the snipers. */
  onShot(): void {
    this.deps.encounter.shot({ suppressed: this.deps.suppressed });
  }

  /**
   * A bullet's flight ended `closestPassM` metres from the closest live enemy sniper it passed (undefined or Infinity: none, so
   * nothing happens): the crack and the dust it raised point back at the player, suppressor or not.
   */
  onBulletEnd(closestPassM: number | undefined): void {
    if (closestPassM !== undefined) this.deps.encounter.bulletCue(closestPassM);
  }

  /**
   * C: duck into cover or come back up. Ducking drops the scope; coming up leaves it off. Not while the mission
   * is over (`over`), and ducking only while the snipers are still a threat. Coming up is always allowed.
   */
  toggleCover(over: boolean): void {
    if (over) return;
    if (this.covered) this.setCovered(false);
    else if (!this.deps.encounter.ended) this.setCovered(true);
  }

  private setCovered(covered: boolean): void {
    if (this.covered === covered) return;
    this.covered = covered;
    this.deps.ui.setCovered(covered);
    if (covered) this.deps.dropScope();
  }

  /**
   * One frame. `paused` (the pointer is free, or the results are up) freezes the encounter and the sweeping.
   * Returns true when the player has just been killed or is dead.
   */
  update(dt: number, paused: boolean): boolean {
    const { encounter, ui, snipers, shooter } = this.deps;
    if (!paused) this.clock += dt;
    const alive = this.snipersLeft;
    const before = encounter.health;
    const events = encounter.update(dt, alive, this.covered, paused);

    const awareness = encounter.awareness;
    for (const s of snipers) s.scan(this.clock, awareness, this.covered, shooter);

    for (const event of events) this.land(event);
    const damage = before - encounter.health;
    if (damage > 0) ui.flash(flashIntensity(damage));
    ui.update(dt);

    // No sniper is left (the encounter has ended, or the mission was just completed and the encounter is paused for
    // good): the threat is over, and a player still ducked (a bullet in flight killed the last one) comes back up.
    const cleared = !encounter.failed && (encounter.ended || alive === 0);
    if (cleared && this.covered) this.setCovered(false);

    const state = this.state;
    state.health = encounter.health;
    state.detection = encounter.detection;
    state.covered = this.covered;
    state.snipersLeft = alive;
    state.warning = encounter.warning;
    state.firing = encounter.firing;
    state.awareness = awareness;
    state.camo = encounter.camo;
    state.fireIn = encounter.fireIn;
    state.paused = paused;
    state.failed = encounter.failed;
    state.cleared = cleared;
    ui.setText(this.line.line(state));
    return encounter.failed;
  }

  /** Dust near the player and the sound of the impact. */
  private land(event: EncounterEvent): void {
    const { deps } = this;
    for (const p of incomingPoints(event, this.incoming, deps.shooter, deps.yaw(), deps.field)) deps.fx.dust(p);
    deps.fx.impactSound(event === 'blast' ? BLAST_SOUND_M : SHOT_SOUND_M);
    this.incoming++;
  }
}
