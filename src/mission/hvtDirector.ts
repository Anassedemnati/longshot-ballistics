import type { Vec3 } from '../ballistics/types';
import type { Obstacle } from '../game/hit';
import { HvtParty } from '../game/hvt';
import type { AlarmCue, HvtStatus, PartyBody, PartyMap } from '../game/hvt';
import type { TerrainField } from '../scene/terrainField';
import { SoldierAnimator } from './soldierAnim';
import type { AnimIntent } from './soldierAnim';
import { JOINT_FLOATS } from './soldierPose';
import type { HvtWorld, Soldier } from './world';

// The HVT's party put together (the HvtParty of game/hvt.ts is the brain): every frame it moves and poses the officer's and the bodyguards'
// bodies (scene/target.ts `drive`, with a SoldierAnimator each, as mission/squadDirector.ts does for the squad), keeps their aim points and
// hearing points on them, hides the officer once he is gone, and drives the jeep off with him when that was his way out. It reaches the
// scene only through the bodies and the jeep's object, so it runs in Node too.

/** The jeep pulls away at this, m/s^2, up to this, m/s, and stops once it is this far down its road, m. */
const DRIVE_ACCEL = 3;
const DRIVE_MPS = 13;
const DRIVE_M = 220;

/** One man of the party: his body in the scene, what his brain says, and his animation. */
interface Member {
  soldier: Soldier;
  body: PartyBody;
  anim: SoldierAnimator;
  intent: AnimIntent;
  speeds: Float64Array;
  probe: (x: number, z: number) => number;
}

export interface HvtDirectorDeps {
  world: HvtWorld;
  field: TerrainField;
  /** Routes round the props (the soldiers' cover map). */
  map: PartyMap;
  seed: number;
}

/** What the debug hook reads of the HVT. */
export interface HvtState {
  status: HvtStatus;
  x: number;
  y: number;
  z: number;
  guardsAlive: number;
  /** His speed, m/s (0 while he stands). */
  speed: number;
  /** Seconds until he is gone (Infinity before the alarm). */
  escapeIn: number;
  escape: 'vehicle' | 'door' | null;
  head: Vec3;
  upperTorso: Vec3;
}

export class HvtDirector {
  readonly party: HvtParty;
  private readonly deps: HvtDirectorDeps;
  private readonly officer: Member;
  private readonly guards: Member[];
  private gone = false;
  private driven = 0;
  private driveSpeed = 0;
  private driving = false;

  constructor(deps: HvtDirectorDeps) {
    this.deps = deps;
    const { world } = deps;
    this.party = new HvtParty({
      route: world.placement.route,
      escapes: world.placement.escapes,
      guards: world.guards.length,
      map: deps.map,
      seed: deps.seed ^ 0x4876,
    });
    const make = (soldier: Soldier, body: PartyBody, i: number): Member => ({
      soldier,
      body,
      anim: new SoldierAnimator(deps.seed * 977 + i * 7907 + 3),
      intent: { speed: 0, gait: 'none', stance: 'stand', aim: false, turnRate: 0, aimYaw: 0, aimPitch: 0 },
      speeds: new Float64Array(JOINT_FLOATS),
      probe: (lx, lz) => {
        const c = Math.cos(body.heading);
        const s = Math.sin(body.heading);
        return deps.field.height(body.x + c * lx + s * lz, body.z - s * lx + c * lz) - deps.field.height(body.x, body.z);
      },
    });
    this.officer = make(world.officer, this.party.officer, 0);
    this.guards = world.guards.map((g, i) => make(g, this.party.guards[i], i + 1));
    this.pose(0);
  }

  get status(): HvtStatus {
    return this.party.status;
  }

  /** True once the officer has got away (he is hidden, his hit target must leave the live list). */
  get escaped(): boolean {
    return this.gone;
  }

  /** The officer's body. */
  get officerSoldier(): Soldier {
    return this.officer.soldier;
  }

  /** Index of the guard with hit-target id `id`, or -1. */
  guardIndex(id: string): number {
    return this.guards.findIndex((g) => g.soldier.placement.id === id);
  }

  /** The points the party hears with (each man's head; the director keeps them on the bodies) and whether each is still up. */
  listeners(): Array<{ point: Vec3; alive: () => boolean }> {
    return [this.officer, ...this.guards].map((m) => ({ point: m.soldier.head, alive: () => m.body.alive && !m.soldier.dummy.down && !this.gone }));
  }

  /** The nearest distance from `p` to a live man of the party, m (Infinity when none is up). */
  nearest(p: Vec3): number {
    let best = Infinity;
    for (const m of [this.officer, ...this.guards]) {
      if (!m.body.alive || m.soldier.dummy.down) continue;
      best = Math.min(best, Math.hypot(m.body.x - p.x, m.body.z - p.z));
    }
    return best;
  }

  /** The party hears or sees something (game/hearing.ts). */
  alarm(cue: AlarmCue): void {
    this.party.alarm(cue);
  }

  /** The officer is hit in a limb. */
  wound(cue: AlarmCue): void {
    this.party.wound(cue);
  }

  /** The officer (`hvt`) or a guard was shot down (the scene has knocked the body over). */
  killed(id: string, cue: AlarmCue): void {
    if (id === this.officer.soldier.placement.id) {
      this.party.kill();
      return;
    }
    const i = this.guardIndex(id);
    if (i < 0) return;
    this.party.killGuard(i);
    this.party.alarm(cue); // a man going down beside him: they all see it
  }

  /** One frame: the party's brain, then every body; the jeep drives off once he is in it. */
  update(dt: number): void {
    if (!(dt > 0)) return;
    this.party.update(dt);
    this.pose(dt);
    if (this.party.status === 'escaped' && !this.gone) {
      this.gone = true;
      this.officer.soldier.dummy.group.visible = false;
      this.driving = this.party.escapePoint?.kind === 'vehicle' && this.deps.world.vehicle !== null;
    }
    if (this.driving) this.drive(dt);
  }

  private pose(dt: number): void {
    for (const m of [this.officer, ...this.guards]) {
      const { soldier, body } = m;
      if (!body.alive || soldier.dummy.down) continue;
      const intent = m.intent;
      intent.speed = body.speed;
      intent.gait = body.gait;
      intent.stance = body.stance;
      intent.turnRate = body.turnRate;
      intent.handsBehind = body.handsBehind;
      if (dt > 0) {
        m.anim.update(dt, intent, m.probe);
        m.anim.velocities(m.speeds);
      }
      soldier.dummy.drive({
        x: body.x,
        z: body.z,
        yaw: body.heading,
        vx: Math.sin(body.heading) * body.speed,
        vz: Math.cos(body.heading) * body.speed,
        joints: m.anim.joints,
        jointSpeeds: m.speeds,
        headYaw: m.anim.headYaw,
      });
      // The aim and hearing points follow the body: the first zone of each name is the specified one.
      const zones = soldier.dummy.hitTarget.zones;
      copyInto(soldier.head, zones[0].center);
      copyInto(soldier.upperTorso, zones[1].center);
      copyInto(soldier.lowerTorso, zones[2].center);
    }
  }

  /** The jeep pulls away down its road (its mesh and its colliders move together), and stops once it is out of the area. */
  private drive(dt: number): void {
    const { world, field } = this.deps;
    const v = world.vehicle;
    if (!v || this.driven >= DRIVE_M) return;
    this.driveSpeed = Math.min(DRIVE_MPS, this.driveSpeed + DRIVE_ACCEL * dt);
    const step = Math.min(this.driveSpeed * dt, DRIVE_M - this.driven);
    this.driven += step;
    const dx = world.placement.road.x * step;
    const dz = world.placement.road.z * step;
    const before = field.height(v.position.x, v.position.z);
    v.position.x += dx;
    v.position.z += dz;
    const dy = field.height(v.position.x, v.position.z) - before;
    v.position.y += dy;
    for (const o of world.vehicleColliders) moveBox(o, dx, dy, dz);
  }

  /** What the debug hook shows. */
  state(): HvtState {
    const o = this.officer;
    return {
      status: this.party.status,
      x: o.body.x,
      y: this.deps.field.height(o.body.x, o.body.z),
      z: o.body.z,
      guardsAlive: this.party.guardsAlive,
      speed: o.body.speed,
      escapeIn: this.party.escapeIn,
      escape: this.party.escapePoint?.kind ?? null,
      head: o.soldier.head,
      upperTorso: o.soldier.upperTorso,
    };
  }
}

/** The HUD's objective line for the party's state (`hvt` missions). */
export function objectiveText(status: HvtStatus, escapeIn: number): string {
  switch (status) {
    case 'idle':
      return 'Eliminate the HVT: officer in the red beret';
    case 'alarmed':
      return 'HVT alerted!';
    case 'fleeing':
    case 'wounded':
      return Number.isFinite(escapeIn)
        ? `HVT is running! ${status === 'wounded' ? '(wounded) ' : ''}${Math.ceil(escapeIn)} s to escape`
        : 'HVT is running!';
    case 'escaped':
      return 'The HVT escaped';
    case 'down':
      return 'HVT eliminated';
  }
}

function copyInto(out: Vec3, from: Vec3): void {
  out.x = from.x;
  out.y = from.y;
  out.z = from.z;
}

function moveBox(o: Obstacle, dx: number, dy: number, dz: number): void {
  o.box.center.x += dx;
  o.box.center.y += dy;
  o.box.center.z += dz;
}
