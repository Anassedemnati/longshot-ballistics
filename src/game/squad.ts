import { createRng, randInt } from '../mission/random';
import type { Rng } from '../mission/random';

// The soldiers' side of a mission that fights back (pure maths and state machines, no scene, no DOM, no clock of their own, only seeded
// randomness): what the SQUAD knows about where the player lies, and what each SOLDIER does about it.
//
// The squad's `knowledge` (0..1) is how much of the player's position it has. It starts at nothing, and grows only from what the player does:
// every shot he fires is heard (a suppressed one hardly), a bullet that passes near a soldier or a soldier going down tells them where it came
// from, and while the enemy snipers have him in their scopes ("the sniper calls your position") it grows by itself. It falls a little while he is
// ducked in cover. So a single shot tells them almost nothing, and he has to shoot SEVERAL times before they find him, unless a sniper spots him.
//
// The knowledge decides the squad's state: unaware, alerted (a shot was heard: take cover), searching (they fire inaccurate bursts in his rough
// direction), engaging (their bursts land near him and can hurt him while he is exposed). From 0.75 they also call mortars.
//
// Each soldier is a small state machine: idle, alerted (reacts, then runs to cover), inCover (crouched, peeks out every few seconds and fires a
// burst), relocating (changes position after a while, after a near miss or when a friend nearby goes down) and dead. His position is his own
// (x, z on the ground; mission/squadDirector.ts puts the body there and animates it).
//
// A guard of a military base has a duty (`GuardDuty`) on top: a tower or machine-gun guard HOLDS his post (when the shot is heard he ducks
// where he stands and fires from there, and never runs for cover), and a patrol walks his beat while all is quiet, stopping now and then to
// look about; once alerted he runs for cover like any soldier.

/** Every tuning number of the squad and its soldiers. */
export const SQUAD = {
  // --- knowledge of the player's position, 0..1 ---
  heardShot: 0.12,
  heardShotSuppressed: 0.04,
  /** A ghillie suit: his shots give away this much of what they would. */
  camoFactor: 0.8,
  /** A bullet that passes (or lands) this close to a living soldier, m, adds `passAdds`. */
  passNearM: 6,
  passAdds: 0.12,
  killedAdds: 0.06,
  /** While an enemy sniper has the player in his scope and calls his position out, per second. */
  sniperCallPerS: 0.2,
  /** Lost per second while the player is ducked in cover. */
  coverDecayPerS: 0.01,
  // --- the squad's state ---
  searchAt: 0.35,
  engageAt: 0.65,
  /** A state is left again only this far below its threshold (the knowledge decays slowly, the state must not flicker). */
  hysteresis: 0.05,
  mortarAt: 0.75,
  /** Seconds from the squad reaching `mortarAt` to the first mortar call, then between calls (drawn between the two numbers). */
  mortarFirstS: [8, 14],
  mortarEveryS: [18, 25],
  // --- a soldier ---
  reactS: [0.15, 0.9],
  sprintMps: [4.0, 4.5],
  crouchRunMps: 2.5,
  /** He looks for cover within this far of where he is, m. */
  pickRangeM: 70,
  /** A change of position is at least this far, m (or it is no change). */
  relocateMinM: 8,
  stayS: [10, 25],
  burstGapS: [2, 5],
  burstRounds: [3, 6],
  roundGapS: [0.085, 0.11],
  /** A bullet landing or passing this close, m, sends him to another spot. */
  nearMissM: 4,
  /** A friend going down this close, m, does too. */
  friendDownM: 25,
  riseS: 0.35,
  dropS: 0.3,
  lookS: [0.8, 1.6],
  // --- a patrol ---
  /** Walking pace on his beat, m/s. */
  patrolMps: 1.4,
  /** Chance he stops at a corner of his beat, and for how long, s (he turns to look about every `lookAboutS`). */
  patrolStopChance: 0.6,
  patrolStopS: [3, 7],
  lookAboutS: [1.2, 2.4],
  // --- what his rifle does to the player ---
  /** Chance that a burst hits an exposed player 300 m away or closer, falling to the far one at 900 m or farther (times the squad's knowledge). */
  hitNear: 0.35,
  hitNearM: 300,
  hitFar: 0.04,
  hitFarM: 900,
  /** Health lost per hit, between these two. */
  damage: [6, 10],
} as const;

/** How well the squad has found the player. */
export type SquadState = 'unaware' | 'alerted' | 'searching' | 'engaging';

/** How far off the player, m, a burst lands for a given knowledge: far when they are only searching, close when they have him. */
export function aimErrorM(knowledge: number): number {
  const k = Math.min(1, Math.max(0, Number.isFinite(knowledge) ? knowledge : 0));
  const knots: ReadonlyArray<readonly [number, number]> = [
    [0, 90],
    [SQUAD.searchAt, 45],
    [SQUAD.engageAt, 10],
    [1, 2.5],
  ];
  for (let i = 1; i < knots.length; i++) {
    if (k <= knots[i][0]) {
      const [k0, e0] = knots[i - 1];
      const [k1, e1] = knots[i];
      return e0 + ((e1 - e0) * (k - k0)) / (k1 - k0);
    }
  }
  return knots[knots.length - 1][1];
}

/** Chance that one burst from `rangeM` away hits an exposed player: `hitNear` up to 300 m, falling linearly to `hitFar` at 900 m, times the knowledge. */
export function burstHitChance(rangeM: number, knowledge: number): number {
  const u = Math.min(1, Math.max(0, (rangeM - SQUAD.hitNearM) / (SQUAD.hitFarM - SQUAD.hitNearM)));
  const base = SQUAD.hitNear + (SQUAD.hitFar - SQUAD.hitNear) * u;
  return base * Math.min(1, Math.max(0, knowledge));
}

/** What the squad is told each frame. */
export interface SquadInput {
  /** An enemy sniper has the player in his scope and calls his position out (the sniper encounter is at 'firing', a sniper is alive). */
  sniperCalling: boolean;
  /** The player is ducked in cover. */
  playerCovered: boolean;
  /** Soldiers still up (the mortar needs one to call it). */
  alive: number;
}

const between = (rng: Rng, range: readonly [number, number] | readonly number[]): number => range[0] + rng() * (range[1] - range[0]);

/** The squad: its knowledge of the player and the state and the mortar that follow from it. */
export class Squad {
  /** 0..1: how much of the player's position the squad has. */
  knowledge = 0;
  private heard = false;
  private current: SquadState = 'unaware';
  /** Seconds to the next mortar call, or null until the knowledge first reaches `mortarAt`. */
  private mortarIn: number | null = null;
  private readonly rng: Rng;

  constructor(seed = 1) {
    this.rng = createRng(seed);
  }

  get state(): SquadState {
    return this.current;
  }

  /** A shot of the player's was heard. */
  playerShot(cue: { suppressed: boolean; camo: boolean }): void {
    this.heard = true;
    const base = cue.suppressed ? SQUAD.heardShotSuppressed : SQUAD.heardShot;
    this.add(base * (cue.camo ? SQUAD.camoFactor : 1));
  }

  /**
   * Something told them a shot was fired without telling them where from (a supersonic crack overhead, a weak suppressed report, see
   * game/hearing.ts): they are alerted and take cover, but their knowledge of the player does not grow.
   */
  alarm(): void {
    if (this.heard) return;
    this.heard = true;
    this.updateState();
  }

  /** A bullet passed or landed within `passNearM` of a living soldier. */
  bulletPassed(): void {
    this.heard = true;
    this.add(SQUAD.passAdds);
  }

  /** A soldier went down. */
  soldierKilled(): void {
    this.heard = true;
    this.add(SQUAD.killedAdds);
  }

  /** Set the knowledge directly (the debug hook's cheat); a value above 0 also means something has been heard. */
  setKnowledge(value: number): void {
    this.knowledge = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
    if (this.knowledge > 0) this.heard = true;
    this.updateState();
  }

  private add(amount: number): void {
    if (amount > 0) this.heard = true; // whatever tells them something, tells them they are not alone
    this.knowledge = Math.min(1, this.knowledge + amount);
    this.updateState();
  }

  private updateState(): void {
    if (!this.heard) {
      this.current = 'unaware';
      return;
    }
    const k = this.knowledge;
    const h = SQUAD.hysteresis;
    // Up at the threshold, down only `hysteresis` below it.
    if (k >= SQUAD.engageAt || (this.current === 'engaging' && k >= SQUAD.engageAt - h)) {
      this.current = 'engaging';
      return;
    }
    const wasSearching = this.current === 'searching' || this.current === 'engaging';
    this.current = k >= SQUAD.searchAt || (wasSearching && k >= SQUAD.searchAt - h) ? 'searching' : 'alerted';
  }

  /**
   * One frame. Returns true when the mortar crew calls a bombardment: the first one a few seconds after the squad has the player well
   * enough (knowledge at `mortarAt`), the next ones every 18 to 25 s, as long as a soldier is alive to call it.
   */
  update(dt: number, input: SquadInput): boolean {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    if (input.sniperCalling) this.add(SQUAD.sniperCallPerS * step);
    else if (input.playerCovered && this.knowledge > 0) {
      this.knowledge = Math.max(0, this.knowledge - SQUAD.coverDecayPerS * step);
      this.updateState();
    }
    if (input.alive <= 0 || this.knowledge < SQUAD.mortarAt) return false;
    if (this.mortarIn === null) this.mortarIn = between(this.rng, SQUAD.mortarFirstS);
    this.mortarIn -= step;
    if (this.mortarIn > 0) return false;
    this.mortarIn = between(this.rng, SQUAD.mortarEveryS);
    return true;
  }
}

// ---------------------------------------------------------------------------------------------
// Cover spots and the soldiers

/** A place a soldier can take cover (or just crouch): where, which way he faces, whether it hides him, and what he does to shoot from it. */
export interface Spot {
  x: number;
  z: number;
  /** Rotation about +Y, rad, that makes him face the shooter (the same convention as a soldier's yaw). */
  yaw: number;
  /** A crouched soldier here cannot be seen from the shooter (a wall, a vehicle, a building is in between). */
  hidden: boolean;
  /** Where he stands, relative to the spot, when he is out to shoot (0, 0: he only rises over low cover). */
  peekX: number;
  peekZ: number;
  /** How he holds himself when he shoots from here. */
  peekStance: 'stand' | 'kneel';
}

/** What the soldiers need of the ground: where there is cover, and a route that goes round the obstacles. */
export interface SquadMap {
  spots: readonly Spot[];
  /** Waypoints (x, z, x, z, ...) of a walk from one point to another that goes round the props; the last pair is where it ends. */
  path(fromX: number, fromZ: number, toX: number, toZ: number): number[];
}

/** Who holds which spot: a spot has at most one soldier. */
export class SpotBook {
  private readonly owner: Int16Array;

  constructor(count: number) {
    this.owner = new Int16Array(count).fill(-1);
  }

  /** The soldier on spot `i`, or -1. */
  ownerOf(i: number): number {
    return this.owner[i];
  }

  claim(i: number, soldier: number): void {
    this.owner[i] = soldier;
  }

  release(i: number, soldier: number): void {
    if (i >= 0 && this.owner[i] === soldier) this.owner[i] = -1;
  }
}

export type SoldierMode = 'idle' | 'alerted' | 'inCover' | 'relocating' | 'dead';

/** What a base guard does besides what every soldier does (see the file's header). */
export interface GuardDuty {
  /** The post he holds (a watch-tower deck, a machine-gun nest): once alerted he takes it as his cover spot and never leaves it. */
  hold?: Spot;
  /** His beat while the squad is unaware: a closed loop of points, m, starting where he stands. */
  route?: ReadonlyArray<{ x: number; z: number }>;
}
/** What he is doing in cover: waiting crouched, coming up, firing, going down again, or only looking. */
export type CoverPhase = 'hold' | 'rise' | 'fire' | 'look' | 'drop';
export type MoveKind = 'sprint' | 'crouchRun';

/** What the soldier tells the world. */
export interface BrainListener {
  /** A round leaves his rifle (`index` of `count` in the burst), aimed at (`aimX`, `aimZ`) on the ground. */
  round(brain: SoldierBrain, index: number, count: number): void;
  /** His burst is over: the director rolls whether it hit. */
  burstEnd(brain: SoldierBrain): void;
}

const TAU = Math.PI * 2;
/** An angle wrapped into (-pi, pi]. */
export function wrapAngle(a: number): number {
  return a - TAU * Math.round(a / TAU);
}
/** Yaw, rad, of the direction from (x, z) to (tx, tz): his front at yaw is (sin yaw, cos yaw). */
export function bearing(x: number, z: number, tx: number, tz: number): number {
  return Math.atan2(tx - x, tz - z);
}

/** How fast a soldier can change his heading, rad/s, and how hard he speeds up and brakes, m/s^2. */
const TURN_RATE = 7;
const ACCEL = 7;
const BRAKE = 9;
/** A waypoint that is not the last is passed within this, m; the last is reached within `ARRIVE_M`. */
const WAYPOINT_M = 1;
const ARRIVE_M = 0.25;

export class SoldierBrain {
  readonly index: number;
  mode: SoldierMode = 'idle';
  phase: CoverPhase = 'hold';
  /** Where his feet are, m. */
  x: number;
  z: number;
  /** The way he faces, rad (his front is (sin, cos)). */
  heading: number;
  speed = 0;
  /** Heading change this frame, rad/s. */
  turnRate = 0;
  /** The spot he holds or runs to, or -1. */
  spot = -1;
  moveKind: MoveKind = 'sprint';
  /** True while his rifle is up at his shoulder. */
  aiming = false;
  /** How he holds himself when he is still. */
  stance: 'stand' | 'crouch' | 'kneel' = 'stand';
  /** The point on the ground his current burst is aimed at (the player's rough position). */
  aimX = 0;
  aimZ = 0;
  /** 0..1: how far out of cover (to the spot's peek position) he is. */
  peek = 0;

  private readonly rng: Rng;
  private readonly sprint: number;
  private path: number[] = [];
  private pathAt = 0;
  private reactLeft = 0;
  private stayLeft = 0;
  private holdLeft = 0;
  private phaseLeft = 0;
  private roundLeft = 0;
  private burstDone = 0;
  private burstCount = 0;
  private canFire = false;
  private threatYaw = 0;
  /** A guard's post (`GuardDuty.hold`), or null. */
  private readonly post: Spot | null;
  private readonly beat: ReadonlyArray<{ x: number; z: number }> | null;
  /** The corner of his beat he walks to, how long he still stands at the last one, and when he next turns to look about, s. */
  private beatAt = 1;
  private pauseLeft = 0;
  private lookLeft = 0;
  private lookYaw = 0;

  constructor(
    index: number,
    start: { x: number; z: number; yaw: number },
    private readonly map: SquadMap,
    private readonly book: SpotBook,
    private readonly squad: Squad,
    private readonly listener: BrainListener,
    seed: number,
    startSpot = -1,
    duty: GuardDuty = {},
  ) {
    this.index = index;
    this.x = start.x;
    this.z = start.z;
    this.heading = start.yaw;
    this.rng = createRng(seed);
    this.sprint = between(this.rng, SQUAD.sprintMps);
    this.spot = startSpot;
    if (startSpot >= 0) book.claim(startSpot, index);
    this.threatYaw = start.yaw;
    this.post = duty.hold ?? null;
    this.beat = duty.route && duty.route.length >= 2 ? duty.route : null;
    this.lookYaw = start.yaw;
  }

  /** True while he walks his beat (a patrol, the squad unaware). */
  get patrolling(): boolean {
    return this.mode === 'idle' && this.beat !== null;
  }

  get alive(): boolean {
    return this.mode !== 'dead';
  }

  /** The soldier is shot: his spot is free for the others. */
  kill(): void {
    this.book.release(this.spot, this.index);
    this.mode = 'dead';
    this.speed = 0;
    this.aiming = false;
  }

  /** A bullet came within `distanceM` of him (landed or passed): too close for comfort, he changes position. */
  nearMiss(distanceM: number): void {
    if (this.mode === 'inCover' && distanceM <= SQUAD.nearMissM) this.relocate('miss');
  }

  /** A friend went down at (x, z): close by, he changes position. */
  friendDown(x: number, z: number): void {
    if (this.mode === 'inCover' && Math.hypot(this.x - x, this.z - z) <= SQUAD.friendDownM) this.relocate('friend');
  }

  /**
   * The point (`playerX`, `playerZ`) the squad is after, with what the squad knows (so far from the truth when it knows little).
   * Called once per burst: picks the spot on the ground his rounds are aimed at.
   */
  private takeAim(playerX: number, playerZ: number): void {
    const err = aimErrorM(this.squad.knowledge);
    const a = this.rng() * TAU;
    const r = err * Math.sqrt(this.rng());
    this.aimX = playerX + Math.sin(a) * r;
    this.aimZ = playerZ + Math.cos(a) * r;
  }

  /** Advance `dt` seconds with the player at (`playerX`, `playerZ`). */
  update(dt: number, playerX: number, playerZ: number): void {
    if (this.mode === 'dead' || !(dt > 0)) return;
    this.turnRate = 0;
    const state = this.squad.state;
    switch (this.mode) {
      case 'idle':
        if (state !== 'unaware') this.react(playerX, playerZ);
        else if (this.beat) this.walkBeat(dt);
        break;
      case 'alerted':
      case 'relocating':
        this.moving(dt);
        break;
      case 'inCover':
        this.cover(dt, playerX, playerZ);
        break;
    }
  }

  // ---- reacting and running ----

  /** A patrol's walk round his beat: along a route round the props to each corner in turn, now and then a stop to look about. */
  private walkBeat(dt: number): void {
    const beat = this.beat as ReadonlyArray<{ x: number; z: number }>;
    if (this.pauseLeft > 0) {
      this.pauseLeft -= dt;
      this.speed = Math.max(0, this.speed - BRAKE * dt);
      this.lookLeft -= dt;
      if (this.lookLeft <= 0) {
        this.lookLeft = between(this.rng, SQUAD.lookAboutS);
        this.lookYaw = this.heading + (this.rng() * 2 - 1) * 1.6;
      }
      this.turnToward(this.lookYaw, dt);
      return;
    }
    if (this.path.length === 0) {
      const to = beat[this.beatAt];
      this.path = this.map.path(this.x, this.z, to.x, to.z);
      this.pathAt = 0;
    }
    const last = this.path.length / 2 - 1;
    const tx = this.path[this.pathAt * 2];
    const tz = this.path[this.pathAt * 2 + 1];
    const dist = Math.hypot(tx - this.x, tz - this.z);
    if (dist < (this.pathAt >= last ? ARRIVE_M : WAYPOINT_M)) {
      if (this.pathAt < last) {
        this.pathAt++;
        return;
      }
      // A corner of the beat: on to the next one, after a look about now and then.
      this.path = [];
      this.beatAt = (this.beatAt + 1) % beat.length;
      if (this.rng() < SQUAD.patrolStopChance) {
        this.pauseLeft = between(this.rng, SQUAD.patrolStopS);
        this.lookLeft = 0;
      }
      return;
    }
    this.speed += Math.min(ACCEL * dt, Math.max(-BRAKE * dt, SQUAD.patrolMps - this.speed));
    this.turnToward(Math.atan2(tx - this.x, tz - this.z), dt);
    const step = Math.min(this.speed * dt, dist);
    this.x += Math.sin(this.heading) * step;
    this.z += Math.cos(this.heading) * step;
  }

  /** A shot was heard: crouch, turn the way it seems to have come from, and (after a moment) run for cover. A guard who holds a post ducks where he is. */
  private react(playerX: number, playerZ: number): void {
    if (this.post) {
      this.threatYaw = bearing(this.x, this.z, playerX, playerZ);
      this.arrive();
      return;
    }
    this.mode = 'alerted';
    this.reactLeft = between(this.rng, SQUAD.reactS);
    this.stance = 'crouch';
    this.moveKind = 'sprint';
    // The general direction of the shot: the player's, a little off while the squad knows little.
    const off = (1 - Math.min(1, this.squad.knowledge * 2)) * 0.5;
    this.threatYaw = bearing(this.x, this.z, playerX, playerZ) + (this.rng() * 2 - 1) * off;
    this.path = [];
  }

  /** Choose a spot to run to and the route to it; false when there is none. */
  private chooseSpot(minDistance: number): boolean {
    const { spots } = this.map;
    let best = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < spots.length; i++) {
      if (i === this.spot && minDistance > 0) continue;
      const owner = this.book.ownerOf(i);
      if (owner >= 0 && owner !== this.index) continue;
      const s = spots[i];
      const d = Math.hypot(s.x - this.x, s.z - this.z);
      if (d > SQUAD.pickRangeM || d < minDistance) continue;
      // Near is good, a spot that hides him is much better (and the one he already hides in a little better still: he does not run about for nothing),
      // a little chance keeps the soldiers from all making the same choice.
      const score = -d + (s.hidden ? 25 : 0) + (i === this.spot && s.hidden ? 12 : 0) + this.rng() * 15;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0) return false;
    this.book.release(this.spot, this.index);
    this.spot = best;
    this.book.claim(best, this.index);
    this.path = this.map.path(this.x, this.z, spots[best].x, spots[best].z);
    this.pathAt = 0;
    return true;
  }

  private relocate(why: 'time' | 'miss' | 'friend'): void {
    // A guard who holds a post stays on it: a near miss or a friend down only makes him wait a while longer before he rises.
    if (this.post || !this.chooseSpot(SQUAD.relocateMinM)) {
      this.stayLeft = between(this.rng, SQUAD.stayS); // nowhere to go: stay put a while longer
      return;
    }
    this.mode = 'relocating';
    this.reactLeft = why === 'time' ? between(this.rng, [0.1, 0.3]) : between(this.rng, [0.05, 0.25]);
    this.moveKind = why === 'time' && this.squad.state !== 'engaging' ? 'crouchRun' : 'sprint';
    this.aiming = false;
    this.stance = 'crouch';
    this.peek = 0;
    this.phase = 'hold';
  }

  /** The run to a spot: react for a moment, then follow the route, braking into the end of it. */
  private moving(dt: number): void {
    if (this.reactLeft > 0) {
      this.reactLeft -= dt;
      this.turnToward(this.threatYaw, dt);
      this.speed = Math.max(0, this.speed - BRAKE * dt);
      return;
    }
    if (this.path.length === 0 && !this.chooseSpot(0)) {
      this.arrive(); // nowhere better to go: crouch where he is
      return;
    }
    const last = this.path.length / 2 - 1;
    const tx = this.path[this.pathAt * 2];
    const tz = this.path[this.pathAt * 2 + 1];
    const dx = tx - this.x;
    const dz = tz - this.z;
    const dist = Math.hypot(dx, dz);
    const final = this.pathAt >= last;
    if (dist < (final ? ARRIVE_M : WAYPOINT_M)) {
      if (final) {
        this.arrive();
        return;
      }
      this.pathAt++;
      return;
    }
    const vmax = this.moveKind === 'sprint' ? this.sprint : SQUAD.crouchRunMps;
    const err = Math.abs(wrapAngle(Math.atan2(dx, dz) - this.heading));
    // He slows for a sharp turn, and brakes so as to stop at the end of the route.
    let wanted = vmax * Math.min(1, Math.max(0.25, 1 - err / 1.8));
    if (final) wanted = Math.min(wanted, Math.sqrt(2 * BRAKE * dist) + 0.4);
    this.speed += Math.min(ACCEL * dt, Math.max(-BRAKE * dt, wanted - this.speed));
    this.turnToward(Math.atan2(dx, dz), dt);
    const step = Math.min(this.speed * dt, final ? dist : Infinity);
    this.x += Math.sin(this.heading) * step;
    this.z += Math.cos(this.heading) * step;
  }

  private turnToward(yaw: number, dt: number): void {
    const err = wrapAngle(yaw - this.heading);
    const turn = Math.max(-TURN_RATE * dt, Math.min(TURN_RATE * dt, err));
    this.heading = wrapAngle(this.heading + turn);
    this.turnRate = turn / dt;
  }

  /** At the spot: crouch, face the threat, wait for the first look out. */
  private arrive(): void {
    const s = this.current();
    if (s) {
      this.x = s.x;
      this.z = s.z;
    }
    this.speed = 0;
    this.mode = 'inCover';
    this.phase = 'hold';
    this.stance = 'crouch';
    this.aiming = false;
    this.peek = 0;
    this.stayLeft = between(this.rng, SQUAD.stayS);
    this.holdLeft = between(this.rng, [0.8, SQUAD.burstGapS[1] - 1]);
    this.path = [];
  }

  // ---- in cover ----

  /** The spot he holds: his cover spot, or a guard's post. */
  private current(): Spot | null {
    return this.spot >= 0 ? this.map.spots[this.spot] : this.post;
  }

  private cover(dt: number, playerX: number, playerZ: number): void {
    const s = this.current();
    const state = this.squad.state;
    this.stayLeft -= dt;
    if (this.stayLeft <= 0 && this.phase === 'hold') {
      this.relocate('time');
      return;
    }
    // Faces the spot's own way, or at the player while shooting.
    const faceYaw = this.aiming ? bearing(this.x, this.z, this.aimX, this.aimZ) : s ? s.yaw : this.heading;
    this.turnToward(faceYaw, dt);

    // Out to the peek position and back: a lateral step round a corner, or nothing at all over low cover.
    const out = this.phase === 'rise' || this.phase === 'fire' || this.phase === 'look';
    this.peek = Math.min(1, Math.max(0, this.peek + (out ? dt / SQUAD.riseS : -dt / SQUAD.dropS)));
    if (s) {
      this.x = s.x + s.peekX * this.peek;
      this.z = s.z + s.peekZ * this.peek;
    }

    switch (this.phase) {
      case 'hold':
        this.holdLeft -= dt;
        if (this.holdLeft <= 0 && s) {
          this.phase = 'rise';
          this.phaseLeft = SQUAD.riseS;
          this.stance = s.peekStance === 'stand' ? 'stand' : 'kneel';
          this.canFire = state === 'searching' || state === 'engaging';
          this.aiming = this.canFire;
          if (this.canFire) this.takeAim(playerX, playerZ);
        }
        break;
      case 'rise':
        this.phaseLeft -= dt;
        if (this.phaseLeft <= 0) {
          if (this.canFire) {
            this.phase = 'fire';
            this.burstCount = randInt(this.rng, SQUAD.burstRounds[0], SQUAD.burstRounds[1]);
            this.burstDone = 0;
            this.roundLeft = 0.06;
          } else {
            this.phase = 'look';
            this.phaseLeft = between(this.rng, SQUAD.lookS);
          }
        }
        break;
      case 'look':
        this.phaseLeft -= dt;
        if (this.phaseLeft <= 0) this.goDown();
        break;
      case 'fire':
        this.roundLeft -= dt;
        while (this.roundLeft <= 0 && this.burstDone < this.burstCount) {
          this.listener.round(this, this.burstDone, this.burstCount);
          this.burstDone++;
          this.roundLeft += between(this.rng, SQUAD.roundGapS);
        }
        if (this.burstDone >= this.burstCount) {
          this.listener.burstEnd(this);
          this.goDown();
        }
        break;
      case 'drop':
        this.phaseLeft -= dt;
        if (this.phaseLeft <= 0) {
          this.phase = 'hold';
          this.holdLeft = between(this.rng, SQUAD.burstGapS);
        }
        break;
    }
  }

  private goDown(): void {
    this.phase = 'drop';
    this.phaseLeft = SQUAD.dropS;
    this.aiming = false;
    this.stance = 'crouch';
  }

  /** The numbers the animation wants (see mission/soldierAnim.ts), written to `out`. */
  intentInto(out: { speed: number; gait: 'none' | 'sprint' | 'crouchRun' | 'walk'; stance: 'stand' | 'crouch' | 'kneel'; aim: boolean; turnRate: number }): void {
    const moving = (this.mode === 'alerted' || this.mode === 'relocating') && this.reactLeft <= 0 && this.speed > 0.05;
    out.speed = this.speed;
    out.gait = moving ? this.moveKind : this.patrolling && this.speed > 0.05 ? 'walk' : 'none';
    out.stance = this.stance;
    out.aim = this.aiming;
    out.turnRate = this.turnRate;
  }
}
