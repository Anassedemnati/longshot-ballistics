import { createRng } from '../mission/random';
import type { Rng } from '../mission/random';
import { bearing, wrapAngle } from './squad';

// The high-value target's party (pure maths and a state machine: no scene, no DOM, no clock of its own, only seeded randomness): an
// officer and his 2-4 bodyguards. Before the alarm they walk his seeded route through the compound together, at a walking pace (the player
// has to lead him: at 800 m a .308 is in the air for over a second), stopping to talk to his soldiers or just standing a while; the guards
// keep 2.5-4.5 m from him, facing outward when they stop. The alarm comes from outside (game/hearing.ts: a report, a crack, an impact, a man
// near him going down): after a human reaction time each guard closes in on him, between him and the shooter when they know where the
// shot came from (a report they could place), all round him when they do not, and the party crouch-runs to the escape point (the vehicle,
// or the door of the building): the one that is covered from the shooter, or else the nearest. There he waits, crouched behind his guards,
// until the escape window is up (the driver starts the car, the door is unbarred): then he is gone and the mission is lost.
//
// Positions are (x, z) on the ground, headings are yaws like a soldier's (his front is (sin, cos)). mission/hvtDirector.ts puts the bodies there.

/** Every tuning number of the HVT's party. */
export const HVT = {
  /** His walking pace before the alarm, m/s. */
  walkMps: 1.4,
  /** The party's crouch-run to the escape point, guards bunched round him, m/s. */
  fleeMps: 2.3,
  /** Wounded in a limb he limps (or is dragged) at this share of the pace. */
  woundedFactor: 0.5,
  /** After a limb hit he is down on one knee this long, s, before he is up and limping. */
  woundKneelS: 1.2,
  /** His and each guard's reaction to the alarm, s (seeded per man). */
  reactS: [0.3, 0.8],
  /** The guards' formation before the alarm: radius round him, m (seeded per guard). */
  formationM: [2.5, 4.5],
  /** After the alarm: how close the guards close in on him, m. */
  shieldM: 1.25,
  /** A guard runs to his place at up to this, m/s, and walks when he is within `walkWithinM` of it. */
  guardRunMps: 4,
  walkWithinM: 1.2,
  /**
   * The escape window from the alarm, s: at least this (the car must be started, the door unbarred) for a compound 300 m away or nearer,
   * growing by `escapePerM` s per metre beyond (a far shot needs more time to set up: 25 s at 700 m), up to `escapeFloorMaxS`; longer when
   * the run itself takes longer.
   */
  escapeMinS: 15,
  escapeFromM: 300,
  escapePerM: 0.025,
  escapeFloorMaxS: 30,
  /** The most the window can be (a long run with a wounded man), s; documented, not enforced: a slower run takes what it takes. */
  escapeMaxS: 40,
  /** Time at the escape point to get in at the least, s: boarding the vehicle, getting the door open. */
  boardS: 3,
  doorS: 2,
  /** An escape point covered from the shooter counts as this much nearer, m. */
  coveredBonusM: 15,
  /** How long he stops at each kind of point of his route, s. */
  talkS: [3.5, 6.5],
  stopS: [3, 7],
  /** A man of his going down this close to the officer is seen, m. */
  sightM: 60,
} as const;

export type HvtStatus = 'idle' | 'alarmed' | 'fleeing' | 'escaped' | 'wounded' | 'down';

/** The least escape window an alarm gives him when his compound is `rangeM` m from the shooter, s: 15 s up to 300 m, then 2.5 s more per 100 m, at most 30 s. */
export function escapeFloorS(rangeM: number): number {
  const extra = Math.max(0, (Number.isFinite(rangeM) ? rangeM : 0) - HVT.escapeFromM) * HVT.escapePerM;
  return Math.min(HVT.escapeFloorMaxS, HVT.escapeMinS + extra);
}

/** One point of the walk: where, how long he stops there (0: walks through), and whether he is talking to a soldier there (he faces `faceX`, `faceZ`). */
export interface RoutePoint {
  x: number;
  z: number;
  waitS: number;
  face?: { x: number; z: number };
}

/** A way out: the vehicle (it drives off with him) or the door of a building; `covered`: a man crouched there cannot be seen from the shooter. */
export interface EscapePoint {
  kind: 'vehicle' | 'door';
  x: number;
  z: number;
  covered: boolean;
}

/** What the party needs of the ground: a route between two points round the props (the soldiers' own, mission/coverSpots.ts). */
export interface PartyMap {
  path(fromX: number, fromZ: number, toX: number, toZ: number): number[];
}

/** How a man of the party moves this frame (what the animation wants). */
export interface PartyBody {
  x: number;
  z: number;
  /** The way he faces, rad (his front is (sin, cos)). */
  heading: number;
  speed: number;
  turnRate: number;
  gait: 'none' | 'walk' | 'sprint' | 'crouchRun';
  stance: 'stand' | 'crouch' | 'kneel';
  /** The officer's hands behind his back (at ease). */
  handsBehind: boolean;
  alive: boolean;
}

/** One cue of the alarm: whether it gave them the shooter's direction (a report they could place), and where he is. */
export interface AlarmCue {
  directional: boolean;
  shooterX: number;
  shooterZ: number;
}

export interface HvtPartyOptions {
  route: readonly RoutePoint[];
  escapes: readonly EscapePoint[];
  guards: number;
  map: PartyMap;
  seed: number;
  /** Where he starts (default: the first point of the route), and which point he walks to first. */
  start?: { x: number; z: number; heading: number };
  /** The least escape window, s (default `HVT.escapeMinS`; see `escapeFloorS`). */
  escapeFloorS?: number;
}

const TURN_RATE = 5;
const between = (rng: Rng, r: readonly number[]): number => r[0] + rng() * (r[1] - r[0]);

function newBody(x: number, z: number, heading: number): PartyBody {
  return { x, z, heading, speed: 0, turnRate: 0, gait: 'none', stance: 'stand', handsBehind: false, alive: true };
}

/** Length of a polyline (x, z, x, z, ...) starting at (x, z), m. */
function pathLength(x: number, z: number, path: readonly number[]): number {
  let d = 0;
  let px = x;
  let pz = z;
  for (let i = 0; i + 1 < path.length; i += 2) {
    d += Math.hypot(path[i] - px, path[i + 1] - pz);
    px = path[i];
    pz = path[i + 1];
  }
  return d;
}

/** One guard: his body, his place round the officer, how long until he reacts to the alarm. */
interface Guard {
  body: PartyBody;
  /** Angle of his place round the officer before the alarm (relative to the officer's heading), rad, and its radius, m. */
  angle: number;
  radius: number;
  reactLeft: number;
  reacted: boolean;
}

export class HvtParty {
  readonly officer: PartyBody;
  readonly guards: readonly PartyBody[];
  private readonly members: Guard[];
  private readonly route: readonly RoutePoint[];
  private readonly escapes: readonly EscapePoint[];
  private readonly map: PartyMap;
  private readonly rng: Rng;
  private state: 'idle' | 'alarmed' | 'fleeing' | 'waiting' | 'escaped' | 'down' = 'idle';
  private wounded = false;
  private kneelLeft = 0;
  /** Game time of the party's own clock, s. */
  private time = 0;
  private reactLeft = 0;
  /** The route point he walks to, the path there, and how long he still stops at the one he has reached. */
  private target = 0;
  private path: number[] = [];
  private pathAt = 0;
  private waitLeft = 0;
  /** Bearing from the officer to the shooter, once a cue has told them; null while they do not know. */
  private threat: number | null = null;
  /** A heading that is "outward" for the ring of guards when the threat is unknown. */
  private ringHeading = 0;
  /** The walking formation's heading: it follows his, slowly, so a turn of his does not swing the guards round him. */
  private formation = 0;
  private escape: EscapePoint | null = null;
  /** Game time the alarm came, and the time he will be gone if he is not stopped, s. */
  private alarmAt = 0;
  private deadline = Infinity;
  private readonly floorS: number;

  constructor(opts: HvtPartyOptions) {
    if (opts.route.length === 0) throw new Error('HvtParty: the route is empty');
    this.route = opts.route;
    this.escapes = opts.escapes;
    this.map = opts.map;
    this.floorS = opts.escapeFloorS ?? HVT.escapeMinS;
    this.rng = createRng(opts.seed);
    const s = opts.start ?? { x: opts.route[0].x, z: opts.route[0].z, heading: 0 };
    this.officer = newBody(s.x, s.z, s.heading);
    this.officer.handsBehind = true;
    this.formation = s.heading;
    this.target = opts.start ? 0 : Math.min(1, opts.route.length - 1);
    this.waitLeft = opts.start ? 0 : opts.route[0].waitS;
    const n = Math.max(0, Math.floor(opts.guards));
    // Their places before the alarm: spread round him (front left, front right, back left, back right), a little off each, at 2.5-4.5 m.
    const base = [Math.PI * 0.3, -Math.PI * 0.3, Math.PI * 0.78, -Math.PI * 0.78];
    this.members = [];
    for (let i = 0; i < n; i++) {
      const angle = base[i % 4] + (this.rng() * 2 - 1) * 0.2;
      const radius = between(this.rng, HVT.formationM);
      const h = s.heading + angle;
      this.members.push({
        body: newBody(s.x + Math.sin(h) * radius, s.z + Math.cos(h) * radius, h),
        angle,
        radius,
        reactLeft: between(this.rng, HVT.reactS),
        reacted: false,
      });
    }
    this.guards = this.members.map((m) => m.body);
  }

  /** What the mission shows: idle, alarmed (reacting), fleeing (running or waiting at the escape point), wounded (and fleeing), escaped or down. */
  get status(): HvtStatus {
    if (this.state === 'down') return 'down';
    if (this.state === 'escaped') return 'escaped';
    if (this.wounded) return 'wounded';
    if (this.state === 'idle') return 'idle';
    if (this.state === 'alarmed') return 'alarmed';
    return 'fleeing';
  }

  /** The alarm has been raised (and he is not down or gone). */
  get alarmed(): boolean {
    return this.state !== 'idle';
  }

  /** The escape point he is making for, once the alarm is up. */
  get escapePoint(): EscapePoint | null {
    return this.escape;
  }

  /** Seconds until he is gone if nobody stops him (Infinity before the alarm, 0 once he is gone). */
  get escapeIn(): number {
    if (this.state === 'escaped') return 0;
    return Math.max(0, this.deadline - this.time);
  }

  /** The escape window this alarm gave him, s (deadline minus the alarm's time; Infinity before it). */
  get escapeWindow(): number {
    return this.deadline - this.alarmAt;
  }

  /** The guards still standing. */
  get guardsAlive(): number {
    let n = 0;
    for (const g of this.members) if (g.body.alive) n++;
    return n;
  }

  /** Whether the shooter's direction is known to them. */
  get threatKnown(): boolean {
    return this.threat !== null;
  }

  /**
   * A cue reached the party (game/hearing.ts), or one of them saw something (a man going down, a bullet striking close). The first raises
   * the alarm: each man reacts after his own reaction time. A cue that gives the shooter's direction lets the guards put themselves between
   * him and the officer, now or later.
   */
  alarm(cue: AlarmCue): void {
    if (this.state === 'down' || this.state === 'escaped') return;
    if (cue.directional) this.threat = bearing(this.officer.x, this.officer.z, cue.shooterX, cue.shooterZ);
    if (this.state !== 'idle') return;
    this.state = 'alarmed';
    this.alarmAt = this.time;
    this.reactLeft = between(this.rng, HVT.reactS);
    this.ringHeading = this.officer.heading;
    this.officer.handsBehind = false;
  }

  /** The officer is hit in a limb: down on one knee for a moment, then limping at half the pace; the alarm is up (he knows he is shot). */
  wound(cue: AlarmCue): void {
    if (this.state === 'down' || this.state === 'escaped') return;
    this.wounded = true;
    this.kneelLeft = HVT.woundKneelS;
    this.alarm(cue);
    this.reactLeft = 0;
    this.officer.handsBehind = false;
  }

  /** The officer is down (killed): the party stops. */
  kill(): void {
    this.state = 'down';
    this.officer.alive = false;
    this.officer.speed = 0;
  }

  /** Guard `i` is down. */
  killGuard(i: number): void {
    const g = this.members[i];
    if (!g) return;
    g.body.alive = false;
    g.body.speed = 0;
  }

  /** Advance `dt` seconds. */
  update(dt: number): void {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    this.time += dt;
    const o = this.officer;
    o.turnRate = 0;
    switch (this.state) {
      case 'idle':
        this.walk(dt);
        break;
      case 'alarmed':
        this.brake(o, dt);
        o.stance = 'crouch';
        if (this.kneelLeft > 0) o.stance = 'kneel';
        this.reactLeft -= dt;
        if (this.reactLeft <= 0 && this.kneelLeft <= 0) this.flee();
        break;
      case 'fleeing':
        this.run(dt);
        break;
      case 'waiting':
        this.brake(o, dt);
        o.stance = 'crouch';
        if (this.time >= this.deadline) {
          this.state = 'escaped';
          o.alive = false;
        }
        break;
      default:
        break;
    }
    if (this.kneelLeft > 0) this.kneelLeft -= dt;
    this.updateGuards(dt);
  }

  // ---- before the alarm: the walk ----

  private walk(dt: number): void {
    const o = this.officer;
    o.stance = 'stand';
    o.handsBehind = true;
    if (this.waitLeft > 0) {
      this.waitLeft -= dt;
      this.brake(o, dt);
      const here = this.route[(this.target + this.route.length - 1) % this.route.length];
      if (here.face) this.turnToward(o, bearing(o.x, o.z, here.face.x, here.face.z), dt);
      return;
    }
    if (this.path.length === 0) {
      const t = this.route[this.target];
      this.path = this.map.path(o.x, o.z, t.x, t.z);
      this.pathAt = 0;
    }
    if (this.follow(o, HVT.walkMps, 'walk', dt)) {
      const reached = this.route[this.target];
      // A stop of his route: the planned wait, a little different each time round.
      this.waitLeft = reached.waitS > 0 ? reached.waitS * (0.8 + 0.4 * this.rng()) : 0;
      this.target = (this.target + 1) % this.route.length;
      this.path = [];
    }
  }

  /** Follow `this.path` at up to `vmax`; returns true on arrival at its end. */
  private follow(b: PartyBody, vmax: number, gait: PartyBody['gait'], dt: number): boolean {
    const last = this.path.length / 2 - 1;
    if (last < 0) return true;
    const tx = this.path[this.pathAt * 2];
    const tz = this.path[this.pathAt * 2 + 1];
    const dx = tx - b.x;
    const dz = tz - b.z;
    const dist = Math.hypot(dx, dz);
    const final = this.pathAt >= last;
    if (dist < (final ? 0.3 : 0.9)) {
      if (final) {
        b.speed = 0;
        b.gait = 'none';
        return true;
      }
      this.pathAt++;
      return false;
    }
    let wanted = vmax;
    if (final) wanted = Math.min(wanted, Math.sqrt(2 * 3 * dist) + 0.3);
    b.speed += Math.max(-6 * dt, Math.min(4 * dt, wanted - b.speed));
    this.turnToward(b, Math.atan2(dx, dz), dt);
    const step = Math.min(b.speed * dt, final ? dist : Infinity);
    b.x += Math.sin(b.heading) * step;
    b.z += Math.cos(b.heading) * step;
    b.gait = b.speed > 0.3 ? gait : 'none';
    return false;
  }

  private brake(b: PartyBody, dt: number): void {
    b.speed = Math.max(0, b.speed - 6 * dt);
    if (b.speed < 0.3) b.gait = 'none';
  }

  private turnToward(b: PartyBody, yaw: number, dt: number): void {
    const err = wrapAngle(yaw - b.heading);
    const turn = Math.max(-TURN_RATE * dt, Math.min(TURN_RATE * dt, err));
    b.heading = wrapAngle(b.heading + turn);
    b.turnRate += turn / dt;
  }

  // ---- after the alarm: the run ----

  /** Pick the escape point (covered, else nearest by the route to it) and start for it; the window is set now. */
  private flee(): void {
    const o = this.officer;
    let best: { e: EscapePoint; path: number[]; length: number } | null = null;
    let bestScore = Infinity;
    for (const e of this.escapes) {
      const path = this.map.path(o.x, o.z, e.x, e.z);
      const length = pathLength(o.x, o.z, path);
      const score = length - (e.covered ? HVT.coveredBonusM : 0);
      if (score < bestScore) {
        bestScore = score;
        best = { e, path, length };
      }
    }
    this.state = 'fleeing';
    if (!best) {
      // Nowhere to go: he crouches where he is behind his guards and is gone once the window is up.
      this.escape = null;
      this.deadline = this.alarmAt + this.floorS;
      this.state = 'waiting';
      return;
    }
    this.escape = best.e;
    this.path = best.path;
    this.pathAt = 0;
    const run = best.length / (HVT.fleeMps * (this.wounded ? HVT.woundedFactor : 1));
    const getIn = best.e.kind === 'vehicle' ? HVT.boardS : HVT.doorS;
    this.deadline = this.time + Math.max(this.floorS - (this.time - this.alarmAt), run + getIn);
  }

  private run(dt: number): void {
    const o = this.officer;
    if (this.kneelLeft > 0) {
      this.brake(o, dt);
      o.stance = 'kneel';
      return;
    }
    o.stance = 'crouch';
    const pace = HVT.fleeMps * (this.wounded ? HVT.woundedFactor : 1);
    if (this.follow(o, pace, 'crouchRun', dt)) {
      this.state = 'waiting';
      const getIn = this.escape?.kind === 'vehicle' ? HVT.boardS : HVT.doorS;
      this.deadline = Math.max(this.deadline, this.time + getIn);
      if (this.escape) this.turnToward(o, bearing(o.x, o.z, this.escape.x, this.escape.z), dt);
      return;
    }
    // A wounded man is slower than the window planned for: it stretches to what the rest of the run takes.
    if (this.wounded) {
      const rest = pathLength(o.x, o.z, this.path.slice(this.pathAt * 2)) / pace;
      const getIn = this.escape?.kind === 'vehicle' ? HVT.boardS : HVT.doorS;
      this.deadline = Math.max(this.deadline, this.time + rest + getIn);
    }
  }

  // ---- the guards ----

  private updateGuards(dt: number): void {
    const o = this.officer;
    const alarmed = this.state !== 'idle';
    // The formation turns with him only while he walks, and with a time constant of a second and a half.
    if (o.speed > 0.3) this.formation = wrapAngle(this.formation + wrapAngle(o.heading - this.formation) * (1 - Math.exp(-dt / 1.5)));
    const live = this.members.filter((g) => g.body.alive);
    live.forEach((g, k) => {
      const b = g.body;
      b.turnRate = 0;
      if (alarmed && !g.reacted) {
        g.reactLeft -= dt;
        if (g.reactLeft <= 0) g.reacted = true;
      }
      // His place: in the walking formation, or (once he has reacted) close in on the officer between him and the shooter.
      let px: number;
      let pz: number;
      let face: number;
      if (alarmed && g.reacted) {
        let a: number;
        if (this.threat !== null) {
          // A screen on the shooter's side: the first two right in the line, the others a little to either side.
          const spread = [-0.32, 0.32, -0.95, 0.95];
          a = this.threat + spread[k % 4];
        } else {
          a = this.ringHeading + (k * 2 * Math.PI) / Math.max(1, live.length) + Math.PI / 4;
        }
        px = o.x + Math.sin(a) * HVT.shieldM;
        pz = o.z + Math.cos(a) * HVT.shieldM;
        face = this.threat ?? a;
      } else {
        const a = this.formation + g.angle;
        px = o.x + Math.sin(a) * g.radius;
        pz = o.z + Math.cos(a) * g.radius;
        face = alarmed ? a : o.speed > 0.3 ? o.heading : a; // facing outward when they stop
      }
      const dx = px - b.x;
      const dz = pz - b.z;
      const dist = Math.hypot(dx, dz);
      // Run to the place, slow into it, walk alongside him; keep pace with the officer.
      const urgent = alarmed && g.reacted;
      const vmax = urgent ? HVT.guardRunMps : dist > HVT.walkWithinM * 2 ? 2.6 : HVT.walkMps * 1.15;
      const wanted = dist < 0.15 ? 0 : Math.min(vmax, dist * 2.5 + o.speed * 0.9);
      b.speed += Math.max(-8 * dt, Math.min(6 * dt, wanted - b.speed));
      if (b.speed > 0.25) {
        this.turnToward(b, Math.atan2(dx, dz), dt);
        const step = Math.min(b.speed * dt, dist);
        b.x += Math.sin(b.heading) * step;
        b.z += Math.cos(b.heading) * step;
      } else {
        this.turnToward(b, face, dt);
      }
      b.gait = b.speed > 0.3 ? (urgent ? (b.speed > 2.8 ? 'sprint' : 'crouchRun') : b.speed > 2 ? 'sprint' : 'walk') : 'none';
      b.stance = urgent ? 'crouch' : 'stand';
    });
  }
}
