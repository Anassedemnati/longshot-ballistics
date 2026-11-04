import type { Vec3 } from '../ballistics/types';
import { pointSegmentDistanceSq } from '../game/bullets';
import type { ImpactEvent } from '../game/bullets';
import { SQUAD, Squad, SoldierBrain, SpotBook, bearing, burstHitChance, wrapAngle } from '../game/squad';
import type { BrainListener, GuardDuty, SoldierMode, SquadMap } from '../game/squad';
import type { TerrainField } from '../scene/terrainField';
import { createRng, randInt } from './random';
import type { Rng } from './random';
import { SoldierAnimator } from './soldierAnim';
import type { AnimIntent } from './soldierAnim';
import { JOINT_FLOATS } from './soldierPose';
import type { Soldier } from './world';

// The soldiers that fight back, put together: one `Squad` (what they know of the player) and, per soldier, a `SoldierBrain` (what he does about it),
// a `SoldierAnimator` (how his body does it) and the scene's soldier (`Soldier.dummy`), which this drives every frame: the body's place and
// pose, its hit spheres and the aim points the assists read. It also carries out what the brains say: a muzzle flash and the sound of a round
// that leaves a rifle (heard after the sound's trip to the player), the dust of rounds that land near him, the crack of those that pass close, and the
// damage of a burst that hits him. Knowledge comes in from outside: his shots, the bullets that pass a soldier, a soldier going down. The scene and the audio are
// reached only through `SquadFx`, the player only through `hurt`, so the whole of it runs in Node in the tests.

/** What a round fired at the player does in the world. */
export interface SquadFx {
  /** A muzzle flash at `point`, `distanceM` from the player's eye. */
  flash(point: Vec3, distanceM: number): void;
  /** The report of a round `distanceM` away, heard `delayS` from now. */
  shot(delayS: number, distanceM: number): void;
  /** A puff of dust where a round lands. */
  dust(point: Vec3): void;
  /** A round landed `distanceM` from the player, heard `delayS` from now. */
  impact(delayS: number, distanceM: number): void;
  /** The crack of a round passing close to the player, `delayS` from now. */
  crack(delayS: number): void;
}

export interface SquadDirectorDeps {
  soldiers: ReadonlyMap<string, Soldier>;
  map: SquadMap & { startSpots: readonly number[] };
  field: TerrainField;
  /** The player's eye. */
  shooter: Vec3;
  squad: Squad;
  seed: number;
  fx: SquadFx;
  /** Speed of sound, m/s, and of the soldiers' rounds. */
  speedOfSound: number;
  /** The player is ducked in cover. */
  covered(): boolean;
  /** A burst of theirs hit the player for this much health. */
  hurt(points: number): void;
  /** The squad has the player's position and calls a mortar; false when one is already on its way. */
  callMortar(): boolean;
}

/** Muzzle velocity of the soldiers' rounds, m/s: the crack of a close round reaches the player this long (at this speed) after the muzzle flash. */
const ROUND_SPEED_MPS = 700;
/** Dust of incoming rounds is limited to this many puffs per second (a burst of six rifles would otherwise build a wall of dust), with a burst of this many allowed. */
const DUST_PER_S = 5;
const DUST_BURST = 3;
/** Rounds land at least this far from the player, m. */
const MIN_LANDING_M = 9;
/** A soldier's rifle is about this high above the ground when he aims (the aim's pitch is measured from it to the player's eye), m. */
const AIM_HEIGHT_M = 1.4;

/** One soldier of the squad. */
interface Member {
  id: string;
  soldier: Soldier;
  brain: SoldierBrain;
  anim: SoldierAnimator;
  intent: AnimIntent;
  speeds: Float64Array;
  probe: (x: number, z: number) => number;
  /** Height of what he stands on, m: a tower guard's deck, else undefined (the terrain under him). */
  floorY?: number;
}

/** What the debug hook reads of a soldier. */
export interface MemberState {
  id: string;
  mode: SoldierMode;
  phase: string;
  x: number;
  z: number;
  speed: number;
  heading: number;
  stance: string;
  aiming: boolean;
  spot: number;
  /** A base guard's post (see mission/basePlan.ts), absent for the mission's own soldiers. */
  post?: string;
}

export class SquadDirector implements BrainListener {
  readonly squad: Squad;
  private readonly deps: SquadDirectorDeps;
  private readonly members: Member[] = [];
  private readonly byId = new Map<string, Member>();
  private readonly rng: Rng;
  private readonly muzzle: Vec3 = { x: 0, y: 0, z: 0 };
  private dustTokens = DUST_BURST;
  /** Where each bullet in flight was last frame (to measure how close it came to a soldier), and the bullets already counted as passing one. */
  private readonly lastPos = new Map<number, Vec3>();
  private readonly counted = new Set<number>();

  constructor(deps: SquadDirectorDeps) {
    this.deps = deps;
    this.squad = deps.squad;
    this.rng = createRng(deps.seed ^ 0x5a17);
    const book = new SpotBook(deps.map.spots.length);
    let i = 0;
    for (const soldier of deps.soldiers.values()) {
      const p = soldier.placement;
      const brain = new SoldierBrain(i, { x: p.x, z: p.z, yaw: p.yaw }, deps.map, book, deps.squad, this, deps.seed * 31 + i * 7919 + 1, deps.map.startSpots[i] ?? -1, guardDuty(p));
      const member: Member = {
        id: p.id,
        soldier,
        brain,
        anim: new SoldierAnimator(deps.seed * 131 + i * 104729 + 5),
        intent: { speed: 0, gait: 'none', stance: 'stand', aim: false, turnRate: 0, aimYaw: 0, aimPitch: 0 },
        speeds: new Float64Array(JOINT_FLOATS),
        floorY: p.y,
        // A deck is flat: the feet need no reach for the terrain under the tower.
        probe: (lx, lz) => {
          if (p.y !== undefined) return 0;
          const c = Math.cos(brain.heading);
          const s = Math.sin(brain.heading);
          return deps.field.height(brain.x + c * lx + s * lz, brain.z - s * lx + c * lz) - deps.field.height(brain.x, brain.z);
        },
      };
      this.members.push(member);
      this.byId.set(p.id, member);
      i++;
    }
  }

  /** Soldiers still up and fighting. */
  get alive(): number {
    let n = 0;
    for (const m of this.members) if (m.brain.alive && !m.soldier.dummy.down) n++;
    return n;
  }

  /** What the soldiers are doing, for the debug hook. */
  states(): MemberState[] {
    return this.members.map((m) => ({
      id: m.id,
      mode: m.brain.mode,
      phase: m.brain.phase,
      x: m.brain.x,
      z: m.brain.z,
      speed: m.brain.speed,
      heading: m.brain.heading,
      stance: m.brain.stance,
      aiming: m.brain.aiming,
      spot: m.brain.spot,
      ...(m.soldier.placement.post ? { post: m.soldier.placement.post } : {}),
    }));
  }

  /** The player fired a shot: the squad hears it. */
  onPlayerShot(cue: { suppressed: boolean; camo: boolean }): void {
    this.squad.playerShot(cue);
  }

  /** A soldier was shot down (the scene has just knocked him over): the squad knows it, and his friends close by move. */
  onSoldierKilled(id: string): void {
    const dead = this.byId.get(id);
    if (!dead) return;
    dead.brain.kill();
    this.squad.soldierKilled();
    for (const m of this.members) if (m !== dead && m.brain.alive) m.brain.friendDown(dead.brain.x, dead.brain.z);
  }

  /**
   * After the bullets have moved: any that came within `passNearM` of a living soldier since the last frame (flying on, or ending) tell the squad where
   * they came from, once per bullet, and send a soldier they came within `nearMissM` of to another spot. `ignore` are the bullets that went through a body.
   */
  observeBullets(active: ReadonlyArray<{ id: number; state: { pos: Vec3 } }>, ended: readonly ImpactEvent[], ignore: { has(id: number): boolean }): void {
    for (const e of ended) {
      const from = this.lastPos.get(e.bulletId);
      if (from && !ignore.has(e.bulletId) && e.kind !== 'expired') this.measure(e.bulletId, from, e.point, e.kind === 'target' ? e.targetId : null);
      this.lastPos.delete(e.bulletId);
      this.counted.delete(e.bulletId);
    }
    for (const b of active) {
      const here = b.state.pos;
      const from = this.lastPos.get(b.id);
      if (from) {
        if (!ignore.has(b.id)) this.measure(b.id, from, here, null);
        from.x = here.x;
        from.y = here.y;
        from.z = here.z;
      } else this.lastPos.set(b.id, { x: here.x, y: here.y, z: here.z });
    }
  }

  private measure(bulletId: number, a: Vec3, b: Vec3, hit: string | null): void {
    for (const m of this.members) {
      if (!m.brain.alive || m.id === hit || m.soldier.dummy.down) continue;
      const d = Math.sqrt(pointSegmentDistanceSq(m.soldier.upperTorso, a, b));
      if (d > SQUAD.passNearM) continue;
      if (!this.counted.has(bulletId)) {
        this.counted.add(bulletId);
        this.squad.bulletPassed();
      }
      m.brain.nearMiss(d);
    }
  }

  /**
   * One frame: the squad's knowledge and mortar, then every soldier thinks, moves and is posed. `sniperCalling` is the sniper encounter at 'firing' with a
   * sniper alive.
   */
  update(dt: number, sniperCalling: boolean): void {
    const { deps } = this;
    if (this.squad.update(dt, { sniperCalling, playerCovered: deps.covered(), alive: this.alive })) deps.callMortar();
    this.dustTokens = Math.min(DUST_BURST, this.dustTokens + DUST_PER_S * dt);
    const px = deps.shooter.x;
    const pz = deps.shooter.z;
    for (const m of this.members) {
      const { brain, soldier } = m;
      if (!brain.alive || soldier.dummy.down) continue;
      brain.update(dt, px, pz);
      const intent = m.intent;
      brain.intentInto(intent);
      if (brain.aiming) {
        intent.aimYaw = wrapAngle(bearing(brain.x, brain.z, brain.aimX, brain.aimZ) - brain.heading);
        const g = m.floorY ?? deps.field.height(brain.x, brain.z);
        intent.aimPitch = Math.atan2(deps.shooter.y - (g + AIM_HEIGHT_M), Math.max(1, Math.hypot(brain.aimX - brain.x, brain.aimZ - brain.z)));
      } else {
        intent.aimYaw = 0;
        intent.aimPitch = 0;
      }
      m.anim.update(dt, intent, m.probe);
      m.anim.velocities(m.speeds);
      const dummy = soldier.dummy;
      dummy.drive({
        x: brain.x,
        z: brain.z,
        yaw: brain.heading,
        vx: Math.sin(brain.heading) * brain.speed,
        vz: Math.cos(brain.heading) * brain.speed,
        joints: m.anim.joints,
        jointSpeeds: m.speeds,
        headYaw: m.anim.headYaw,
      });
      // The aim points the assists and the debug state read follow the body: the first zone of each name is the specified one.
      const zones = dummy.hitTarget.zones;
      copyInto(soldier.head, zones[0].center);
      copyInto(soldier.upperTorso, zones[1].center);
      copyInto(soldier.lowerTorso, zones[2].center);
    }
  }

  // ---- what a soldier's rifle does (BrainListener) ----

  round(brain: SoldierBrain, index: number, count: number): void {
    const { deps } = this;
    const m = this.members[brain.index];
    m.anim.kick();
    const muzzle = m.soldier.dummy.muzzle(this.muzzle);
    const range = Math.hypot(muzzle.x - deps.shooter.x, muzzle.y - deps.shooter.y, muzzle.z - deps.shooter.z);
    deps.fx.flash(muzzle, range);
    deps.fx.shot(range / deps.speedOfSound, range);
    const engaging = this.squad.state === 'engaging';
    if (index === 0) {
      // The round passes close to the player once they have him: its crack comes with the bullet, well before the report.
      if (engaging) deps.fx.crack(range / ROUND_SPEED_MPS);
    }
    if ((index === 0 || index === count - 1) && this.dustTokens >= 1) {
      this.dustTokens -= 1;
      // The burst lands round the point it was aimed at, on the side of the player that faces the soldier (so it kicks up dust in view), never closer
      // than `MIN_LANDING_M` and never right in front of his eye: a puff on top of the scope would hide the very soldier he is looking for.
      let ox = brain.aimX - deps.shooter.x;
      let oz = brain.aimZ - deps.shooter.z;
      const towardX = brain.x - deps.shooter.x;
      const towardZ = brain.z - deps.shooter.z;
      const toward = Math.hypot(towardX, towardZ) || 1;
      if (ox * towardX + oz * towardZ < 0) {
        ox = -ox;
        oz = -oz;
      }
      const r = Math.hypot(ox, oz);
      if (r < MIN_LANDING_M) {
        // Pushed out to the minimum along the line to the soldier.
        ox = (towardX / toward) * MIN_LANDING_M;
        oz = (towardZ / toward) * MIN_LANDING_M;
      }
      const side = this.rng() < 0.5 ? -1 : 1;
      const lateral = side * (2.5 + this.rng() * 2.5);
      const x = deps.shooter.x + ox + (-towardZ / toward) * lateral;
      const z = deps.shooter.z + oz + (towardX / toward) * lateral;
      deps.fx.dust({ x, y: deps.field.height(x, z), z });
      deps.fx.impact(range / ROUND_SPEED_MPS, Math.hypot(x - deps.shooter.x, z - deps.shooter.z));
    }
  }

  burstEnd(brain: SoldierBrain): void {
    const { deps } = this;
    if (this.squad.state !== 'engaging' || deps.covered()) return;
    const range = Math.hypot(brain.x - deps.shooter.x, brain.z - deps.shooter.z);
    if (this.rng() < burstHitChance(range, this.squad.knowledge)) deps.hurt(randInt(this.rng, SQUAD.damage[0], SQUAD.damage[1]));
  }
}

/**
 * A base guard's duty (game/squad.ts `GuardDuty`): a tower guard holds his deck (he crouches behind the parapet and stands to fire over it), a
 * machine-gun guard his nest (he kneels behind the gun to fire), a patrol walks his beat; a gate guard, and every other soldier, has none.
 */
function guardDuty(p: Soldier['placement']): GuardDuty {
  if (p.post === 'tower' || p.post === 'mg') {
    return { hold: { x: p.x, z: p.z, yaw: p.yaw, hidden: true, peekX: 0, peekZ: 0, peekStance: p.post === 'tower' ? 'stand' : 'kneel' } };
  }
  if (p.post === 'patrol' && p.route) return { route: p.route };
  return {};
}

function copyInto(out: Vec3, from: Vec3): void {
  out.x = from.x;
  out.y = from.y;
  out.z = from.z;
}
