import type { Vec3 } from '../ballistics/types';
import { segmentBox } from '../game/hit';
import type { Obstacle } from '../game/hit';
import type { Spot, SquadMap } from '../game/squad';
import type { TerrainField } from '../scene/terrainField';
import { layoutColliders } from './layout';
import type { MissionLayout } from './layout';
import { propBoxes, vehicleEngineObstacle } from './props';
import type { PropKind, PropPlacement } from './props';

// Where the soldiers can take cover, and how they get there (pure, no three.js). From the layout's props (walls, sheds, houses, parked and target
// vehicles) it works out crouch spots on the far side of each prop from the shooter, with the prop between the spot and him, on the terrain and
// outside every collider; for every spot also where the soldier stands to shoot (over a low cover, or a step round a corner of a tall one). The
// soldiers' own start places are spots too. A route between two points goes round the props' footprints by simple corner steering.

/** A crouched soldier's head is about this high, m: a spot is cover when a collider is between it and the shooter at that height. */
const CROUCH_HEAD_M = 1.0;
/** A kneeling soldier's head, and a standing one's. */
const KNEEL_HEAD_M = 1.3;
const STAND_HEAD_M = 1.68;
/** How far from a prop's footprint the spots are tried, m, and how far apart along its sides. */
const SPOT_MARGIN_M = 1.0;
const SPOT_SPACING_M = 2.4;
/** A spot keeps this far from every collider (inflated footprints), m, and from another spot. */
const SPOT_CLEARANCE_M = 0.6;
const SPOT_APART_M = 1.5;
/** Soldiers walk this far from a footprint, m. */
const WALK_MARGIN_M = 0.55;
/** The step round a corner is tried up to this far, m, in these steps. */
const PEEK_MAX_M = 3;
const PEEK_STEP_M = 0.3;
/** Footprints farther than this from the walk (beyond its half length), m, are left out of the route search. */
const WALK_NEAR_M = 30;

/** A prop's footprint in the world: an oriented rectangle (centre, half sizes, yaw as a collider's), the tallest top of its boxes. */
interface Footprint {
  x: number;
  z: number;
  hx: number;
  hz: number;
  yaw: number;
}

/** The footprint of a prop of `kind` at (x, z) turned by `yaw`: the rectangle that holds every one of its boxes. */
function footprintOf(kind: PropKind, x: number, z: number, yaw: number): Footprint {
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const b of propBoxes(kind)) {
    x0 = Math.min(x0, b.center.x - b.halfSize.x);
    x1 = Math.max(x1, b.center.x + b.halfSize.x);
    z0 = Math.min(z0, b.center.z - b.halfSize.z);
    z1 = Math.max(z1, b.center.z + b.halfSize.z);
  }
  const lx = (x0 + x1) / 2;
  const lz = (z0 + z1) / 2;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return { x: x + c * lx + s * lz, z: z - s * lx + c * lz, hx: (x1 - x0) / 2, hz: (z1 - z0) / 2, yaw };
}

/** World (x, z) to the footprint's frame, and back (the collider convention: local +X is (cos yaw, -sin yaw)). */
function toLocal(f: Footprint, x: number, z: number): [number, number] {
  const c = Math.cos(f.yaw);
  const s = Math.sin(f.yaw);
  const dx = x - f.x;
  const dz = z - f.z;
  return [c * dx - s * dz, s * dx + c * dz];
}
function toWorld(f: Footprint, lx: number, lz: number): [number, number] {
  const c = Math.cos(f.yaw);
  const s = Math.sin(f.yaw);
  return [f.x + c * lx + s * lz, f.z - s * lx + c * lz];
}

/** True when (x, z) is inside the footprint grown by `margin`. */
function inside(f: Footprint, x: number, z: number, margin: number): boolean {
  const [lx, lz] = toLocal(f, x, z);
  return Math.abs(lx) <= f.hx + margin && Math.abs(lz) <= f.hz + margin;
}

/** Parameter u (0..1) where the segment a -> b first enters the footprint grown by `margin`, or null. */
function enters(f: Footprint, ax: number, az: number, bx: number, bz: number, margin: number): number | null {
  const [lax, laz] = toLocal(f, ax, az);
  const [lbx, lbz] = toLocal(f, bx, bz);
  const hx = f.hx + margin;
  const hz = f.hz + margin;
  let u0 = 0;
  let u1 = 1;
  for (const [p, d, h] of [
    [lax, lbx - lax, hx],
    [laz, lbz - laz, hz],
  ] as const) {
    if (Math.abs(d) < 1e-9) {
      if (Math.abs(p) > h) return null;
      continue;
    }
    let t0 = (-h - p) / d;
    let t1 = (h - p) / d;
    if (t0 > t1) [t0, t1] = [t1, t0];
    u0 = Math.max(u0, t0);
    u1 = Math.min(u1, t1);
    if (u0 > u1) return null;
  }
  return u0;
}

/** True when any obstacle blocks the straight line from `a` to `b`. */
function blocked(a: Vec3, b: Vec3, obstacles: readonly Obstacle[]): boolean {
  for (const o of obstacles) if (segmentBox(a, b, o.box) !== null) return true;
  return false;
}

export class CoverMap implements SquadMap {
  readonly spots: Spot[] = [];
  /** The spot of each soldier's start place, in layout order. */
  readonly startSpots: number[] = [];
  private readonly feet: Footprint[] = [];

  constructor(layout: MissionLayout, field: TerrainField) {
    const eye = field.shooter;
    const obstacles = layoutColliders(layout, field);
    const props: PropPlacement[] = [...layout.props, ...layout.vehicleTargets.map((v) => ({ id: v.id, kind: v.kind, x: v.x, z: v.z, yaw: v.yaw }))];
    for (const v of layout.vehicleTargets) obstacles.push(vehicleEngineObstacle(v, field.height(v.x, v.z)));
    for (const p of props) this.feet.push(footprintOf(p.kind, p.x, p.z, p.yaw));

    const facing = (x: number, z: number): number => Math.atan2(eye.x - x, eye.z - z);
    const free = (x: number, z: number, margin: number): boolean => !this.feet.some((f) => inside(f, x, z, margin));

    // Spots on the far side of every prop: tried round its footprint, kept where a collider hides a crouched soldier from the shooter.
    for (let k = 0; k < props.length; k++) {
      const f = this.feet[k];
      const m = SPOT_MARGIN_M;
      // The four sides: [the fixed local coordinate, the along-coordinate from and to, which axis is fixed (0: x, 1: z)].
      const sides: Array<[number, number, number, number]> = [
        [f.hz + m, -f.hx, f.hx, 1],
        [-(f.hz + m), -f.hx, f.hx, 1],
        [f.hx + m, -f.hz, f.hz, 0],
        [-(f.hx + m), -f.hz, f.hz, 0],
      ];
      for (const [fixed, from, to, axis] of sides) {
        const n = Math.max(1, Math.ceil((to - from) / SPOT_SPACING_M));
        for (let i = 0; i <= n; i++) {
          const along = from + ((to - from) * i) / n;
          const [x, z] = axis === 1 ? toWorld(f, along, fixed) : toWorld(f, fixed, along);
          this.tryAdd(x, z, field, eye, obstacles, free, facing);
        }
      }
    }

    // The soldiers' own start places: where they stand is a spot too (it hides them or it does not).
    for (const s of layout.soldiers) {
      this.startSpots.push(this.spots.length);
      this.spots.push(this.describe(s.x, s.z, s.yaw, field, eye, obstacles, free) ?? { x: s.x, z: s.z, yaw: s.yaw, hidden: false, peekX: 0, peekZ: 0, peekStance: 'kneel' });
    }
  }

  /** Add a cover spot at (x, z) if it is a good one. */
  private tryAdd(
    x: number,
    z: number,
    field: TerrainField,
    eye: Vec3,
    obstacles: readonly Obstacle[],
    free: (x: number, z: number, margin: number) => boolean,
    facing: (x: number, z: number) => number,
  ): void {
    if (!free(x, z, SPOT_CLEARANCE_M)) return;
    if (this.spots.some((s) => Math.hypot(s.x - x, s.z - z) < SPOT_APART_M)) return;
    const spot = this.describe(x, z, facing(x, z), field, eye, obstacles, free);
    if (spot && spot.hidden) this.spots.push(spot);
  }

  /**
   * The spot at (x, z): hidden from the shooter when crouched, and where to stand to shoot from it. Null when it is no use: it is hidden but
   * he cannot shoot from it either over the cover or a few steps beside it.
   */
  private describe(
    x: number,
    z: number,
    yaw: number,
    field: TerrainField,
    eye: Vec3,
    obstacles: readonly Obstacle[],
    free: (x: number, z: number, margin: number) => boolean,
  ): Spot | null {
    const g = field.height(x, z);
    const hidden = blocked(eye, { x, y: g + CROUCH_HEAD_M, z }, obstacles);
    const seen = (px: number, pz: number, head: number): boolean => !blocked(eye, { x: px, y: field.height(px, pz) + head, z: pz }, obstacles);
    if (seen(x, z, KNEEL_HEAD_M)) return { x, z, yaw, hidden, peekX: 0, peekZ: 0, peekStance: 'kneel' };
    if (seen(x, z, STAND_HEAD_M)) return { x, z, yaw, hidden, peekX: 0, peekZ: 0, peekStance: 'stand' };
    if (!hidden) return { x, z, yaw, hidden, peekX: 0, peekZ: 0, peekStance: 'kneel' };
    // Tall cover: a few steps to one side, along the line the shooter looks along turned a right angle.
    const dx = x - eye.x;
    const dz = z - eye.z;
    const l = Math.hypot(dx, dz) || 1;
    const px = -dz / l;
    const pz = dx / l;
    for (let o = PEEK_STEP_M; o <= PEEK_MAX_M; o += PEEK_STEP_M) {
      for (const side of [1, -1]) {
        const qx = x + px * o * side;
        const qz = z + pz * o * side;
        if (free(qx, qz, SPOT_CLEARANCE_M * 0.5) && seen(qx, qz, KNEEL_HEAD_M)) {
          return { x, z, yaw, hidden, peekX: px * (o + 0.3) * side, peekZ: pz * (o + 0.3) * side, peekStance: 'kneel' };
        }
      }
    }
    return null;
  }

  /**
   * Waypoints (x, z, x, z, ...) of the shortest walk from one point to another that goes round every footprint; the last pair is `to`.
   * A visibility graph over the footprints' corners (grown a little) near the walk, searched with Dijkstra's algorithm: a clear line is the
   * straight one, and a route that is boxed in falls back to the straight line.
   */
  path(fromX: number, fromZ: number, toX: number, toZ: number): number[] {
    // Only the footprints near the walk matter.
    const mx = (fromX + toX) / 2;
    const mz = (fromZ + toZ) / 2;
    const reach = Math.hypot(toX - fromX, toZ - fromZ) / 2 + WALK_NEAR_M;
    const near = this.feet.filter((f) => Math.hypot(f.x - mx, f.z - mz) <= reach + Math.hypot(f.hx, f.hz));
    const around = WALK_MARGIN_M + 0.12;

    // Nodes: 0 is the start, 1 the goal, then every corner that is not inside another footprint.
    const nx: number[] = [fromX, toX];
    const nz: number[] = [fromZ, toZ];
    for (const f of near) {
      for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
        const [wx, wz] = toWorld(f, sx * (f.hx + around), sz * (f.hz + around));
        if (near.some((o) => inside(o, wx, wz, WALK_MARGIN_M))) continue;
        nx.push(wx);
        nz.push(wz);
      }
    }
    // A footprint that holds the start or the goal is no obstacle to the legs that touch that end (he is walking out of it, or into it).
    const startIn = near.map((f) => inside(f, fromX, fromZ, WALK_MARGIN_M));
    const goalIn = near.map((f) => inside(f, toX, toZ, WALK_MARGIN_M));
    const clear = (a: number, b: number): boolean => {
      for (let i = 0; i < near.length; i++) {
        if ((a === 0 && startIn[i]) || (b === 1 && goalIn[i]) || (a === 1 && goalIn[i]) || (b === 0 && startIn[i])) continue;
        if (enters(near[i], nx[a], nz[a], nx[b], nz[b], WALK_MARGIN_M) !== null) return false;
      }
      return true;
    };
    if (clear(0, 1)) return [toX, toZ];

    const n = nx.length;
    const dist = new Array<number>(n).fill(Infinity);
    const prev = new Array<number>(n).fill(-1);
    const done = new Array<boolean>(n).fill(false);
    dist[0] = 0;
    for (let step = 0; step < n; step++) {
      let u = -1;
      for (let i = 0; i < n; i++) if (!done[i] && (u < 0 || dist[i] < dist[u])) u = i;
      if (u < 0 || dist[u] === Infinity || u === 1) break;
      done[u] = true;
      for (let v = 0; v < n; v++) {
        if (done[v] || v === u) continue;
        const d = dist[u] + Math.hypot(nx[v] - nx[u], nz[v] - nz[u]);
        if (d < dist[v] && clear(u, v)) {
          dist[v] = d;
          prev[v] = u;
        }
      }
    }
    if (prev[1] < 0) return [toX, toZ]; // boxed in: the straight line will have to do
    const out: number[] = [];
    for (let v = 1; v > 0; v = prev[v]) out.unshift(nx[v], nz[v]);
    return out;
  }
}
