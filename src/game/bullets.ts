import { DEFAULT_DT, step } from '../ballistics/integrator';
import type { Atmosphere, BulletState, Vec3, WindField } from '../ballistics/types';
import { obstacleBoundingRadius, segmentBox, segmentSphere } from './hit';
import type { HitTarget, Material, Obstacle, TerrainHeight, ZoneName } from './hit';

/**
 * How a bullet's flight ended. With the `watchPoints` option every variant also carries `closestWatchM`: the closest the bullet came
 * to any watched point along its whole flight, m (up to where it ended). Without watch points the field is absent.
 */
export type ImpactEvent =
  | { bulletId: number; kind: 'target'; targetId: string; zone: ZoneName; point: Vec3; velocity?: Vec3; time: number; closestWatchM?: number }
  | { bulletId: number; kind: 'obstacle'; obstacleId: string; material: Material; point: Vec3; velocity?: Vec3; time: number; closestWatchM?: number }
  | { bulletId: number; kind: 'terrain'; point: Vec3; velocity?: Vec3; time: number; closestWatchM?: number }
  | { bulletId: number; kind: 'expired'; time: number; closestWatchM?: number };

/**
 * A bullet's closest pass by one listener (see `BulletSystemOptions.listeners`): reported once, as soon as the bullet is past him
 * (or when its flight ends), and only when it came within `passRadiusM`. The records are pooled: read them before the next `update`.
 */
export interface BulletPass {
  bulletId: number;
  /** Index of the listener in the `listeners()` array. */
  listener: number;
  /** Closest distance from the listener to the flight path, m. */
  distanceM: number;
  /** The bullet's flight time at that point, s (counted from its launch, or its `startTime`). */
  time: number;
  /** The bullet's speed there, m/s (ground frame). */
  speed: number;
}

/** Options of `BulletSystem.fire`. */
export interface FireOptions {
  /**
   * A bullet that has already passed through a body and flies on: it ignores every target (so nothing is hit or scored twice) but still strikes
   * cover and the ground, where it kicks up dust or sparks. Default false.
   */
  ghost?: boolean;
  /** Flight time already spent, s (a continuing bullet keeps its clock). Default 0. */
  startTime?: number;
}

export interface BulletSystemOptions {
  atmo: Atmosphere;
  wind: WindField;
  terrainHeight: TerrainHeight;
  /** Current hit targets; read once per update() call. */
  targets: () => HitTarget[];
  /**
   * Solid cover (buildings, walls, vehicles); read once per update() call and may return the same
   * array every time. Default: none.
   */
  obstacles?: () => Obstacle[];
  /**
   * Points the flight is measured against (the enemy snipers' heads and upper torsos); read once per update() call and may return
   * the same array every time. Every impact event then carries `closestWatchM`. Default: none, and no distance is computed at all.
   */
  watchPoints?: () => readonly Vec3[];
  /**
   * Points that hear the bullets go by (the enemy's heads), read at every `fire` and `update`; the array must keep its length and order for
   * the mission (a dead listener stays in it, the caller ignores what he would hear). For each bullet and listener the closest pass is
   * measured, and `passes` reports it once the bullet is past him, when it came within `passRadiusM`. Default: none, nothing measured.
   */
  listeners?: () => readonly Vec3[];
  /** Passes farther than this from a listener are not reported, m. Default 25. */
  passRadiusM?: number;
  /** Fixed substep, s. Default 0.001. */
  dt?: number;
  /** A bullet expires when its flight time reaches this, s. Default 6. */
  maxFlightTime?: number;
  /** update() clamps its frame time to this, s. Default 0.1. */
  maxFrameDt?: number;
}

interface Bullet {
  id: number;
  state: BulletState;
  bcG7: number;
  /** Flies through every target (see FireOptions.ghost). */
  ghost: boolean;
  /** Squared closest distance to a watch point so far, m^2 (Infinity until a substep has been measured). */
  closestSq: number;
  /**
   * Per listener (null without listeners): the squared closest distance so far (m^2), the flight time (s) and speed (m/s) there, and
   * whether the pass is over (reported, or never within the radius). Made once, when the bullet is fired.
   */
  passSq: Float64Array | null;
  passT: Float64Array | null;
  passV: Float64Array | null;
  passDone: Uint8Array | null;
}

/** Float drift guard for flight-time and substep-count comparisons, s. */
const EPS = 1e-9;
/** Terrain crossing is located to within this distance along the path, m. */
const TERRAIN_TOLERANCE = 0.01;
const MAX_BISECTIONS = 32;
const NO_OBSTACLES: Obstacle[] = [];
const NO_TARGETS: HitTarget[] = [];
const NO_POINTS: readonly Vec3[] = [];

function lerp(a: number, b: number, u: number): number {
  return a + (b - a) * u;
}

/** Squared distance from point `p` to the segment a -> b, m^2. */
export function pointSegmentDistanceSq(p: Vec3, a: Vec3, b: Vec3): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const abz = b.z - a.z;
  const lengthSq = abx * abx + aby * aby + abz * abz;
  // The foot of the perpendicular, kept on the segment; a zero-length segment is the point a.
  const u = lengthSq > 0 ? Math.min(1, Math.max(0, ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / lengthSq)) : 0;
  const dx = a.x + abx * u - p.x;
  const dy = a.y + aby * u - p.y;
  const dz = a.z + abz * u - p.z;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Point-mass bullets flown with the shared RK4 `step` at a fixed substep. Every substep sweeps the
 * segment prev->next against every target zone, every obstacle box and the terrain, and the earliest
 * contact wins (on an exact tie: target, then obstacle, then terrain). Fast bullets never tunnel
 * through targets or thin walls and long frames never skip hits. Targets with `bounds` and all
 * obstacles are rejected with one cheap segment-sphere test before their narrow tests run. With `watchPoints` each bullet
 * also keeps the closest any of its substep segments came to any watch point, and reports it on its impact event.
 */
export class BulletSystem {
  private readonly atmo: Atmosphere;
  private readonly wind: WindField;
  private readonly terrainHeight: TerrainHeight;
  private readonly targets: () => HitTarget[];
  private readonly obstacles: () => Obstacle[];
  private readonly watchPoints: (() => readonly Vec3[]) | undefined;
  private readonly listeners: (() => readonly Vec3[]) | undefined;
  private readonly passRadiusSq: number;
  /** Pass records, reused from frame to frame (`passList` holds this frame's). */
  private readonly passPool: BulletPass[] = [];
  private readonly passList: BulletPass[] = [];
  private readonly dt: number;
  private readonly maxFlightTime: number;
  private readonly maxFrameDt: number;
  private readonly bullets: Bullet[] = [];
  /** Bounding-sphere radius of each obstacle in the current update(); reused, never reallocated per frame. */
  private readonly obstacleRadii: number[] = [];
  private nextId = 1;
  /** Frame time not yet consumed by whole substeps, s. */
  private accumulator = 0;

  constructor(opts: BulletSystemOptions) {
    this.atmo = opts.atmo;
    this.wind = opts.wind;
    this.terrainHeight = opts.terrainHeight;
    this.targets = opts.targets;
    this.obstacles = opts.obstacles ?? (() => NO_OBSTACLES);
    this.watchPoints = opts.watchPoints;
    this.listeners = opts.listeners;
    const passRadius = opts.passRadiusM ?? 25;
    this.passRadiusSq = passRadius * passRadius;
    this.dt = opts.dt ?? DEFAULT_DT;
    if (!Number.isFinite(this.dt) || this.dt <= 0) {
      throw new Error(`BulletSystem: dt must be a positive finite number, got ${this.dt}`);
    }
    this.maxFlightTime = opts.maxFlightTime ?? 6;
    this.maxFrameDt = opts.maxFrameDt ?? 0.1;
  }

  /** In-flight bullets (live view; do not mutate). */
  get active(): ReadonlyArray<{ id: number; state: BulletState }> {
    return this.bullets;
  }

  /** The closest passes reported by the last `update` (pooled records: read them before the next one). */
  get passes(): readonly BulletPass[] {
    return this.passList;
  }

  /** Launch a bullet at flight time 0 (or `opts.startTime`). Returns its id. */
  fire(origin: Vec3, velocity: Vec3, bcG7: number, opts: FireOptions = {}): number {
    const id = this.nextId++;
    const n = this.listeners ? this.listeners().length : 0;
    this.bullets.push({
      id,
      bcG7,
      ghost: opts.ghost ?? false,
      closestSq: Infinity,
      passSq: n > 0 ? new Float64Array(n).fill(Infinity) : null,
      passT: n > 0 ? new Float64Array(n) : null,
      passV: n > 0 ? new Float64Array(n) : null,
      passDone: n > 0 ? new Uint8Array(n) : null,
      state: {
        pos: { x: origin.x, y: origin.y, z: origin.z },
        vel: { x: velocity.x, y: velocity.y, z: velocity.z },
        t: opts.startTime ?? 0,
      },
    });
    return id;
  }

  /**
   * Advance all bullets by frameDt (clamped to maxFrameDt; NaN, negative or non-finite counts as 0)
   * in whole fixed substeps; the remainder carries to the next call. Returns the impacts that
   * happened (grouped by bullet, oldest first). A bullet is removed on its first event.
   */
  update(frameDt: number): ImpactEvent[] {
    const events: ImpactEvent[] = [];
    this.passList.length = 0;
    // NaN, negative and infinite frame times count as 0: one NaN would poison the accumulator.
    const frame = Number.isFinite(frameDt) && frameDt > 0 ? Math.min(frameDt, this.maxFrameDt) : 0;
    this.accumulator += frame;
    const steps = Math.floor(this.accumulator / this.dt + EPS);
    this.accumulator = Math.max(0, this.accumulator - steps * this.dt);
    if (steps === 0 || this.bullets.length === 0) return events;

    const targets = this.targets();
    const obstacles = this.obstacles();
    // Cached per Obstacle object, so this is a lookup per obstacle per frame, not per substep.
    const radii = this.obstacleRadii;
    radii.length = obstacles.length;
    for (let i = 0; i < obstacles.length; i++) radii[i] = obstacleBoundingRadius(obstacles[i]);
    // Read once per call; with none (the usual case for a mission without snipers) no distance is measured at all.
    const watched = this.watchPoints ? this.watchPoints() : NO_POINTS;
    const listening = this.listeners ? this.listeners() : NO_POINTS;
    let kept = 0;
    for (let i = 0; i < this.bullets.length; i++) {
      const bullet = this.bullets[i];
      let event: ImpactEvent | null = null;
      for (let n = 0; n < steps && event === null; n++) {
        event = this.advance(bullet, targets, obstacles, radii, watched, listening);
      }
      if (event === null) {
        this.bullets[kept++] = bullet;
      } else {
        if (this.watchPoints) event.closestWatchM = Math.sqrt(bullet.closestSq); // Infinity when nothing was ever watched
        events.push(event);
      }
    }
    this.bullets.length = kept;
    return events;
  }

  /** One substep for one bullet. Returns its impact event, or null if it is still flying. */
  private advance(
    bullet: Bullet,
    targets: HitTarget[],
    obstacles: Obstacle[],
    radii: number[],
    watched: readonly Vec3[],
    listening: readonly Vec3[],
  ): ImpactEvent | null {
    const prev = bullet.state;
    const next = step(prev, this.dt, bullet.bcG7, this.atmo, this.wind);
    bullet.state = next;
    const event = this.contact(prev, next, bullet, targets, obstacles, radii);
    // Up to where the bullet ended: an impact cuts the substep short, and the part beyond it was never flown.
    const end = event !== null && event.kind !== 'expired' ? event.point : next.pos;
    if (watched.length > 0) {
      for (let i = 0; i < watched.length; i++) {
        const d = pointSegmentDistanceSq(watched[i], prev.pos, end);
        if (d < bullet.closestSq) bullet.closestSq = d;
      }
    }
    if (bullet.passSq !== null && listening.length > 0) this.listen(bullet, prev, next, end, event, listening);
    return event;
  }

  /**
   * The closest passes of one substep (prev -> end, cut short by an impact) by every listener: a new closest point is kept with its
   * flight time and speed; a substep that comes no closer means the bullet is past him, and a pass within the radius is reported then.
   * When the flight ends here every pass still open is reported too. No allocation: the records come from the pool.
   */
  private listen(bullet: Bullet, prev: BulletState, next: BulletState, end: Vec3, event: ImpactEvent | null, listening: readonly Vec3[]): void {
    const passSq = bullet.passSq as Float64Array;
    const passT = bullet.passT as Float64Array;
    const passV = bullet.passV as Float64Array;
    const done = bullet.passDone as Uint8Array;
    const n = Math.min(passSq.length, listening.length);
    // How much of the full substep was flown (an impact ends it early), and the speeds at its two ends.
    const span = event !== null && event.kind !== 'expired' ? Math.max(0, Math.min(1, (event.time - prev.t) / this.dt)) : 1;
    const v0 = Math.hypot(prev.vel.x, prev.vel.y, prev.vel.z);
    const v1 = Math.hypot(next.vel.x, next.vel.y, next.vel.z);
    const abx = end.x - prev.pos.x;
    const aby = end.y - prev.pos.y;
    const abz = end.z - prev.pos.z;
    const lengthSq = abx * abx + aby * aby + abz * abz;
    for (let i = 0; i < n; i++) {
      if (done[i] === 1) continue;
      const p = listening[i];
      const u = lengthSq > 0 ? Math.min(1, Math.max(0, ((p.x - prev.pos.x) * abx + (p.y - prev.pos.y) * aby + (p.z - prev.pos.z) * abz) / lengthSq)) : 0;
      const dx = prev.pos.x + abx * u - p.x;
      const dy = prev.pos.y + aby * u - p.y;
      const dz = prev.pos.z + abz * u - p.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < passSq[i]) {
        passSq[i] = d;
        passT[i] = prev.t + u * span * this.dt;
        passV[i] = v0 + (v1 - v0) * u * span;
      } else {
        // No closer than before: he is behind the bullet now.
        done[i] = 1;
        if (passSq[i] <= this.passRadiusSq) this.report(bullet, i);
      }
    }
    if (event !== null) {
      for (let i = 0; i < n; i++) {
        if (done[i] === 1) continue;
        done[i] = 1;
        if (passSq[i] <= this.passRadiusSq) this.report(bullet, i);
      }
    }
  }

  private report(bullet: Bullet, i: number): void {
    const k = this.passList.length;
    let rec = this.passPool[k];
    if (rec === undefined) {
      rec = { bulletId: 0, listener: 0, distanceM: 0, time: 0, speed: 0 };
      this.passPool.push(rec);
    }
    rec.bulletId = bullet.id;
    rec.listener = i;
    rec.distanceM = Math.sqrt((bullet.passSq as Float64Array)[i]);
    rec.time = (bullet.passT as Float64Array)[i];
    rec.speed = (bullet.passV as Float64Array)[i];
    this.passList.push(rec);
  }

  /** The earliest thing the substep prev -> next touches (target, obstacle, terrain), or the end of the bullet's life; null if none. */
  private contact(
    prev: BulletState,
    next: BulletState,
    bullet: Bullet,
    targets: HitTarget[],
    obstacles: Obstacle[],
    radii: number[],
  ): ImpactEvent | null {

    // Earliest target contact along prev -> next.
    let uTarget = Infinity;
    let hitTarget: HitTarget | null = null;
    let hitZone: ZoneName = 'limbs';
    for (const target of bullet.ghost ? NO_TARGETS : targets) {
      const bounds = target.bounds;
      if (bounds !== undefined && segmentSphere(prev.pos, next.pos, bounds.center, bounds.radius) === null) {
        continue;
      }
      for (const zone of target.zones) {
        const u = segmentSphere(prev.pos, next.pos, zone.center, zone.radius);
        if (u !== null && u < uTarget) {
          uTarget = u;
          hitTarget = target;
          hitZone = zone.name;
        }
      }
    }

    // Earliest obstacle contact along prev -> next.
    let uObstacle = Infinity;
    let hitObstacle: Obstacle | null = null;
    for (let i = 0; i < obstacles.length; i++) {
      const obstacle = obstacles[i];
      if (segmentSphere(prev.pos, next.pos, obstacle.box.center, radii[i]) === null) continue;
      const u = segmentBox(prev.pos, next.pos, obstacle.box);
      if (u !== null && u < uObstacle) {
        uObstacle = u;
        hitObstacle = obstacle;
      }
    }

    // Terrain crossing, only looked for when the segment end is underground.
    let uTerrain = Infinity;
    if (next.pos.y < this.terrainHeight(next.pos.x, next.pos.z)) {
      uTerrain = this.terrainCrossing(prev.pos, next.pos);
    }

    if (hitTarget !== null && uTarget <= uObstacle && uTarget <= uTerrain) {
      return {
        bulletId: bullet.id,
        kind: 'target',
        targetId: hitTarget.id,
        zone: hitZone,
        point: this.pointAt(prev.pos, next.pos, uTarget),
        velocity: this.pointAt(prev.vel, next.vel, uTarget),
        time: prev.t + uTarget * this.dt,
      };
    }
    if (hitObstacle !== null && uObstacle <= uTerrain) {
      return {
        bulletId: bullet.id,
        kind: 'obstacle',
        obstacleId: hitObstacle.id,
        material: hitObstacle.material,
        point: this.pointAt(prev.pos, next.pos, uObstacle),
        velocity: this.pointAt(prev.vel, next.vel, uObstacle),
        time: prev.t + uObstacle * this.dt,
      };
    }
    if (uTerrain !== Infinity) {
      return {
        bulletId: bullet.id,
        kind: 'terrain',
        point: this.pointAt(prev.pos, next.pos, uTerrain),
        velocity: this.pointAt(prev.vel, next.vel, uTerrain),
        time: prev.t + uTerrain * this.dt,
      };
    }
    if (next.t >= this.maxFlightTime - EPS) {
      return { bulletId: bullet.id, kind: 'expired', time: next.t };
    }
    return null;
  }

  /**
   * Bisect segment a->b (a above ground or at it, b below) to find where it dips below the terrain.
   * Returns u in [0, 1], accurate to TERRAIN_TOLERANCE along the path.
   */
  private terrainCrossing(a: Vec3, b: Vec3): number {
    const length = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    let lo = 0; // assumed above ground
    let hi = 1; // known below ground
    for (let i = 0; i < MAX_BISECTIONS && (hi - lo) * length > TERRAIN_TOLERANCE; i++) {
      const mid = 0.5 * (lo + hi);
      const x = lerp(a.x, b.x, mid);
      const z = lerp(a.z, b.z, mid);
      if (lerp(a.y, b.y, mid) < this.terrainHeight(x, z)) hi = mid;
      else lo = mid;
    }
    return 0.5 * (lo + hi);
  }

  private pointAt(a: Vec3, b: Vec3, u: number): Vec3 {
    return { x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u), z: lerp(a.z, b.z, u) };
  }
}
