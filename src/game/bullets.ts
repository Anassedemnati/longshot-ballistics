import { DEFAULT_DT, step } from '../ballistics/integrator';
import type { Atmosphere, BulletState, Vec3, WindField } from '../ballistics/types';
import { segmentSphere } from './hit';
import type { HitTarget, TerrainHeight, ZoneName } from './hit';

export type ImpactEvent =
  | { bulletId: number; kind: 'target'; targetId: string; zone: ZoneName; point: Vec3; time: number }
  | { bulletId: number; kind: 'terrain'; point: Vec3; time: number }
  | { bulletId: number; kind: 'expired'; time: number };

export interface BulletSystemOptions {
  atmo: Atmosphere;
  wind: WindField;
  terrainHeight: TerrainHeight;
  /** Current hit targets; read once per update() call. */
  targets: () => HitTarget[];
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
}

/** Float drift guard for flight-time and substep-count comparisons, s. */
const EPS = 1e-9;
/** Terrain crossing is located to within this distance along the path, m. */
const TERRAIN_TOLERANCE = 0.01;
const MAX_BISECTIONS = 32;

function lerp(a: number, b: number, u: number): number {
  return a + (b - a) * u;
}

/**
 * Point-mass bullets flown with the shared RK4 `step` at a fixed substep. Every substep sweeps the
 * segment prev->next against every target zone and the terrain, so fast bullets never tunnel
 * through targets and long frames never skip hits.
 */
export class BulletSystem {
  private readonly atmo: Atmosphere;
  private readonly wind: WindField;
  private readonly terrainHeight: TerrainHeight;
  private readonly targets: () => HitTarget[];
  private readonly dt: number;
  private readonly maxFlightTime: number;
  private readonly maxFrameDt: number;
  private readonly bullets: Bullet[] = [];
  private nextId = 1;
  /** Frame time not yet consumed by whole substeps, s. */
  private accumulator = 0;

  constructor(opts: BulletSystemOptions) {
    this.atmo = opts.atmo;
    this.wind = opts.wind;
    this.terrainHeight = opts.terrainHeight;
    this.targets = opts.targets;
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

  /** Launch a bullet at flight time 0. Returns its id. */
  fire(origin: Vec3, velocity: Vec3, bcG7: number): number {
    const id = this.nextId++;
    this.bullets.push({
      id,
      bcG7,
      state: {
        pos: { x: origin.x, y: origin.y, z: origin.z },
        vel: { x: velocity.x, y: velocity.y, z: velocity.z },
        t: 0,
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
    // NaN, negative and infinite frame times count as 0: one NaN would poison the accumulator.
    const frame = Number.isFinite(frameDt) && frameDt > 0 ? Math.min(frameDt, this.maxFrameDt) : 0;
    this.accumulator += frame;
    const steps = Math.floor(this.accumulator / this.dt + EPS);
    this.accumulator = Math.max(0, this.accumulator - steps * this.dt);
    if (steps === 0 || this.bullets.length === 0) return events;

    const targets = this.targets();
    let kept = 0;
    for (let i = 0; i < this.bullets.length; i++) {
      const bullet = this.bullets[i];
      let event: ImpactEvent | null = null;
      for (let n = 0; n < steps && event === null; n++) {
        event = this.advance(bullet, targets);
      }
      if (event === null) {
        this.bullets[kept++] = bullet;
      } else {
        events.push(event);
      }
    }
    this.bullets.length = kept;
    return events;
  }

  /** One substep for one bullet. Returns its impact event, or null if it is still flying. */
  private advance(bullet: Bullet, targets: HitTarget[]): ImpactEvent | null {
    const prev = bullet.state;
    const next = step(prev, this.dt, bullet.bcG7, this.atmo, this.wind);
    bullet.state = next;

    // Earliest target contact along prev -> next.
    let uTarget = Infinity;
    let hitTarget: HitTarget | null = null;
    let hitZone: ZoneName = 'limbs';
    for (const target of targets) {
      for (const zone of target.zones) {
        const u = segmentSphere(prev.pos, next.pos, zone.center, zone.radius);
        if (u !== null && u < uTarget) {
          uTarget = u;
          hitTarget = target;
          hitZone = zone.name;
        }
      }
    }

    // Terrain crossing, only looked for when the segment end is underground.
    let uTerrain = Infinity;
    if (next.pos.y < this.terrainHeight(next.pos.x, next.pos.z)) {
      uTerrain = this.terrainCrossing(prev.pos, next.pos);
    }

    if (hitTarget !== null && uTarget <= uTerrain) {
      return {
        bulletId: bullet.id,
        kind: 'target',
        targetId: hitTarget.id,
        zone: hitZone,
        point: this.pointAt(prev.pos, next.pos, uTarget),
        time: prev.t + uTarget * this.dt,
      };
    }
    if (uTerrain !== Infinity) {
      return {
        bulletId: bullet.id,
        kind: 'terrain',
        point: this.pointAt(prev.pos, next.pos, uTerrain),
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
