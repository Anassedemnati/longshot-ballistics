import type { Vec3 } from '../ballistics/types';
import { segmentHitsAny } from '../game/hit';
import type { Obstacle } from '../game/hit';
import type { Spot, SquadMap } from '../game/squad';
import type { TerrainField } from '../scene/terrainField';
import { layoutColliders } from './layout';
import type { MissionLayout } from './layout';
import { propFootprintRect, vehicleEngineObstacle } from './props';
import type { SceneryKind, SceneryPlacement } from './props';

// Where the soldiers can take cover, and how they get there (pure, no three.js). From the layout's props (walls, sheds, houses, parked and target
// vehicles) it works out crouch spots on the far side of each prop from the shooter, with the prop between the spot and him, on the terrain and
// outside every collider; for every spot also where the soldier stands to shoot (over a low cover, or a step round a corner of a tall one). The
// soldiers' own start places are spots too. A route between two points goes round the props' footprints by simple corner steering.
// A military base's props count like any others (its HESCO, sandbags, vehicles and tents are cover), but for the small kinds a man walks
// round without a plan (drums, a flag pole, a floodlight...): they would only crowd the route search.

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
/** Two corners farther apart than this, m, are not linked in the route graph (a soldier picks cover within 70 m: a route never needs such a hop). */
const EDGE_MAX_M = 90;

/** A prop's footprint in the world: an oriented rectangle (centre, half sizes, yaw as a collider's), the tallest top of its boxes. */
interface Footprint {
  x: number;
  z: number;
  hx: number;
  hz: number;
  yaw: number;
}

/** Base kinds left out of the footprints: small things a walker steps round, which only crowd the route search (and give no cover). */
const MINOR_KINDS: ReadonlySet<SceneryKind> = new Set<SceneryKind>(['fuelDrums', 'flagPole', 'floodlight', 'ammoCrates', 'commsMast', 'helipad', 'camoNet']);

/** The footprint of a prop of `kind` at (x, z) turned by `yaw`: the rectangle that holds every one of its boxes (a box's own yaw included). */
function footprintOf(kind: SceneryKind, x: number, z: number, yaw: number): Footprint {
  const f = propFootprintRect(kind);
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return { x: x + c * f.cx + s * f.cz, z: z - s * f.cx + c * f.cz, hx: f.hx, hz: f.hz, yaw };
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

/** Barrier kinds laid end to end along a base's perimeter: an abutting run of them is one footprint (a wall), not a row of short ones. */
const RUN_KINDS: ReadonlySet<SceneryKind> = new Set<SceneryKind>(['hesco', 'sandbags']);
/** Two barriers merge when they lie on one line (centres this far off it, m) with at most this gap between their ends, m. */
const RUN_OFFSET_M = 0.35;
const RUN_GAP_M = 0.3;

/** The footprint holding both `f` and `g` when they are two barriers of one run (same axis, in line, end to end), else null. */
function mergeRun(f: Footprint, g: Footprint): Footprint | null {
  const turn = g.yaw - f.yaw;
  if (Math.abs(Math.sin(turn)) > 0.02) return null;
  const [lx, lz] = toLocal(f, g.x, g.z);
  if (Math.abs(lz) > RUN_OFFSET_M || Math.abs(lx) - f.hx - g.hx > RUN_GAP_M) return null;
  // g turned by 0 or pi in f's frame: its half sizes lie along f's axes.
  const x0 = Math.min(-f.hx, lx - g.hx);
  const x1 = Math.max(f.hx, lx + g.hx);
  const z0 = Math.min(-f.hz, lz - g.hz);
  const z1 = Math.max(f.hz, lz + g.hz);
  const [x, z] = toWorld(f, (x0 + x1) / 2, (z0 + z1) / 2);
  return { x, z, hx: (x1 - x0) / 2, hz: (z1 - z0) / 2, yaw: f.yaw };
}

/** The footprints with every run of barriers merged into one (the route search then has a wall's four corners, not four per barrier). */
function mergeRuns(feet: Footprint[], run: boolean[]): Footprint[] {
  const out = feet.slice();
  const isRun = run.slice();
  for (let i = 0; i < out.length; i++) {
    if (!isRun[i]) continue;
    for (let j = i + 1; j < out.length; j++) {
      if (!isRun[j]) continue;
      const m = mergeRun(out[i], out[j]);
      if (!m) continue;
      out[i] = m;
      out.splice(j, 1);
      isRun.splice(j, 1);
      j = i; // the grown footprint may now meet one already passed over
    }
  }
  return out;
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
  return segmentHitsAny(a, b, obstacles);
}

export class CoverMap implements SquadMap {
  readonly spots: Spot[] = [];
  /** The spot of each soldier's start place, in layout order. */
  readonly startSpots: number[] = [];
  private readonly feet: Footprint[];
  /** The route graph (`graph`), once it is built. */
  private corners: { x: number[]; z: number[]; adj: number[][] } | null = null;

  constructor(layout: MissionLayout, field: TerrainField) {
    const eye = field.shooter;
    const obstacles = layoutColliders(layout, field);
    const props: SceneryPlacement[] = [
      ...layout.props,
      ...layout.vehicleTargets.map((v) => ({ id: v.id, kind: v.kind, x: v.x, z: v.z, yaw: v.yaw })),
      ...(layout.base ? layout.base.props.filter((p) => !MINOR_KINDS.has(p.kind)) : []),
    ];
    for (const v of layout.vehicleTargets) obstacles.push(vehicleEngineObstacle(v, field.height(v.x, v.z)));
    this.feet = mergeRuns(
      props.map((p) => footprintOf(p.kind, p.x, p.z, p.yaw)),
      props.map((p) => RUN_KINDS.has(p.kind)),
    );

    const facing = (x: number, z: number): number => Math.atan2(eye.x - x, eye.z - z);
    const free = (x: number, z: number, margin: number): boolean => !this.feet.some((f) => inside(f, x, z, margin));

    // Spots on the far side of every prop: tried round its footprint, kept where a collider hides a crouched soldier from the shooter.
    for (const f of this.feet) {
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
   * A visibility graph over the footprints' corners (grown a little): the corner-to-corner edges are worked out once (`graph`), so a walk
   * only links its two ends to the corners they see and runs A* (the straight distance to the goal never overestimates, so the route is
   * still the shortest). A military base's dozens of footprints made a search from scratch cost tens of milliseconds, mid-frame. A clear
   * line is the straight one, and a route that is boxed in falls back to the straight line.
   */
  path(fromX: number, fromZ: number, toX: number, toZ: number): number[] {
    const g = this.graph();
    // A footprint that holds the start or the goal is no obstacle to the legs that touch that end (he is walking out of it, or into it).
    const startIn = this.feet.map((f) => inside(f, fromX, fromZ, WALK_MARGIN_M));
    const goalIn = this.feet.map((f) => inside(f, toX, toZ, WALK_MARGIN_M));
    if (this.legClear(fromX, fromZ, toX, toZ, startIn, goalIn)) return [toX, toZ];

    // Nodes: the corners (0..m-1), then the start (m) and the goal (m + 1).
    const m = g.x.length;
    const S = m;
    const G = m + 1;
    const nx = [...g.x, fromX, toX];
    const nz = [...g.z, fromZ, toZ];
    const none: boolean[] = [];
    const fromStart: number[] = [];
    const toGoal = new Uint8Array(m);
    for (let i = 0; i < m; i++) {
      if (this.legClear(fromX, fromZ, g.x[i], g.z[i], startIn, none)) fromStart.push(i);
      if (this.legClear(g.x[i], g.z[i], toX, toZ, none, goalIn)) toGoal[i] = 1;
    }
    const n = m + 2;
    const h = nx.map((x, i) => Math.hypot(toX - x, toZ - nz[i]));
    const dist = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n);
    dist[S] = 0;
    const relax = (u: number, v: number): void => {
      const d = dist[u] + Math.hypot(nx[v] - nx[u], nz[v] - nz[u]);
      if (d < dist[v]) {
        dist[v] = d;
        prev[v] = u;
      }
    };
    for (let step = 0; step < n; step++) {
      let u = -1;
      for (let i = 0; i < n; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] + h[i] < dist[u] + h[u])) u = i;
      if (u < 0 || u === G) break;
      done[u] = 1;
      if (u === S) {
        for (const v of fromStart) relax(u, v);
        continue;
      }
      for (const v of g.adj[u]) if (!done[v]) relax(u, v);
      if (toGoal[u]) relax(u, G);
    }
    if (prev[G] < 0) return [toX, toZ]; // boxed in: the straight line will have to do
    const out: number[] = [];
    for (let v = G; v !== S; v = prev[v]) out.unshift(nx[v], nz[v]);
    return out;
  }

  /** The corners of the footprints (grown a little) that lie outside every other one, and which of them see each other; built on first use. */
  private graph(): { x: number[]; z: number[]; adj: number[][] } {
    if (this.corners) return this.corners;
    const around = WALK_MARGIN_M + 0.12;
    const x: number[] = [];
    const z: number[] = [];
    for (const f of this.feet) {
      for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
        const [wx, wz] = toWorld(f, sx * (f.hx + around), sz * (f.hz + around));
        if (this.feet.some((o) => inside(o, wx, wz, WALK_MARGIN_M))) continue;
        x.push(wx);
        z.push(wz);
      }
    }
    const adj: number[][] = x.map(() => []);
    const none: boolean[] = [];
    for (let i = 0; i < x.length; i++) {
      for (let j = i + 1; j < x.length; j++) {
        if (Math.hypot(x[j] - x[i], z[j] - z[i]) > EDGE_MAX_M) continue;
        if (!this.legClear(x[i], z[i], x[j], z[j], none, none)) continue;
        adj[i].push(j);
        adj[j].push(i);
      }
    }
    this.corners = { x, z, adj };
    return this.corners;
  }

  /** True when the straight leg (ax, az) -> (bx, bz) enters no footprint (grown by the walk margin), but those flagged in `skipA` / `skipB`. */
  private legClear(ax: number, az: number, bx: number, bz: number, skipA: readonly boolean[], skipB: readonly boolean[]): boolean {
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    for (let i = 0; i < this.feet.length; i++) {
      if (skipA[i] || skipB[i]) continue;
      const f = this.feet[i];
      // Broad phase: the footprint's circle (half diagonal plus the margin) beyond either end of the leg or wholly to one side of it.
      const rl = (f.hx + f.hz + WALK_MARGIN_M) * len;
      const ex = f.x - ax;
      const ez = f.z - az;
      const along = ex * dx + ez * dz;
      if (len > 0 && (along < -rl || along > len * len + rl || Math.abs(ex * dz - ez * dx) > rl)) continue;
      if (enters(f, ax, az, bx, bz, WALK_MARGIN_M) !== null) return false;
    }
    return true;
  }
}
