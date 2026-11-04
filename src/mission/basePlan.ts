import { TOWER_DECK } from './baseProps';
import type { BaseKind } from './baseProps';
import { propFootprintRect } from './props';
import type { SceneryPlacement } from './props';
import type { Rng } from './random';

// A small military base around a centre: a planner (pure, seeded) that returns prop placements and guard posts.
//
// INTEGRATION (the layout and the world, once the HVT work has landed): a mission option `base: 'none' |
// 'outpost' | 'base'`; for anything but 'none':
//   1. layout.ts:  `const base = planBase(centre, facingYaw(centre.x, centre.z), size, createRng(seed ^ BASE_SALT), field)`.
//      Keep everything else out of `base.radius` round the centre (other props, the scatter, vegetation, cover
//      spots), or treat base.props as existing props when placing them. Store `base` on the layout (e.g. `layout.base`),
//      NOT in `layout.props`: `PropPlacement.kind` is the narrow `PropKind` that the layout's own tables
//      (`KEEP_PRIORITY`, cover predicates) are keyed by. If the base props must join `layout.props` instead, widen
//      `PropPlacement.kind` to `SceneryKind` and give KEEP_PRIORITY entries for the base kinds. Note too that a base
//      prop's `LocalBox` may carry its own `yaw` (sandbag rings, howitzer trails): code that reads a box's `center`
//      and `halfSize` as axis-aligned (coverSpots `footprintOf`, the layout's low-cover tests) must then go through
//      `boxFootprintCorners` / `toWorldBox` instead.
//   2. world.ts:   `scene.add(freeze(createBaseMesh(base.props, field.height, config.theme)))` (scene/baseMesh.ts:
//      the whole base in at most six meshes; do NOT run base props through the per-prop `createPropMesh` loop:
//      that is several hundred draw calls), and
//      `for (const p of base.props) obstacles.push(...propColliders(p, field.height(p.x, p.z)))`, exactly as the
//      village props are registered. Add the same colliders to the line-of-sight obstacle lists the layout builds
//      (layout.ts gathers `propColliders` for its visibility checks).
//   3. Soldiers: spawn one per `base.guards` entry through the soldier/squad system. A 'tower' guard stands on
//      the tower deck: his ground is `field.height(tower.x, tower.z) + guard.y` (the tower is `guard.on`), so give
//      him a ground callback returning that height, as world.ts does for snipers on roofs. A 'patrol' guard walks
//      `guard.route` (a closed loop: back to the first point after the last), which stays clear of every base prop.
//
// The plan, in the base's own frame (u to the right, w forward; the front, with the gate, faces `facingYaw`):
// a square perimeter of half side S: watch towers on the corners (an outpost: on the two back corners and
// machine-gun nests on the two front ones), machine-gun nests at the middle of the other sides (a base), HESCO
// barriers and sandbag walls between them with a few gaps, a gate with a booth and a chicane of concrete
// barriers in the middle of the front. Inside, a lane runs from the gate to the back and a ring road runs round
// just inside the perimeter (the patrol route); the props stand in the quarters between: a vehicle park (one tank
// under a camouflage net), an artillery line, a helipad with its helicopter, a radar and AA site, tents, a
// generator with fuel drums, a comms mast, ammunition next to the guns, a flag and floodlights by the lane.
// The lane, the ring road and the perimeter gaps keep lines of sight open through the base.

export type BaseSize = 'outpost' | 'base';

/** Radius round the centre that every collider of the base stays inside, m (40 m and 80 m across). */
export const BASE_RADIUS: Record<BaseSize, number> = { outpost: 20, base: 40 };

/** Half side of the perimeter square, m: corner towers turned to face out diagonally still end inside the radius. */
const HALF_SIDE: Record<BaseSize, number> = { outpost: 12, base: 26 };
/** The patrol's ring road runs this far inside the perimeter line, m. */
const RING_INSET = 3;
/** Interior props stay this far inside the perimeter line, m (clear of the ring road). */
const INTERIOR_INSET = 4.6;
/** Half width of the lane from the gate to the back, m. */
const LANE_HALF: Record<BaseSize, number> = { outpost: 1.75, base: 3.5 };
/** Minimum clearance between interior props, m (room to walk between them). */
const PROP_GAP = 0.8;
/** Spacing of the rings an interior prop's spot is searched on, m (a tent fills its quarter of an outpost to 0.2 m). */
const SEARCH_STEP = 0.25;
/** A patrol route keeps this far from every prop's footprint, m. */
const ROUTE_CLEARANCE = 0.4;
/** Ground drop across a footprint above which a slot is skipped on sloped terrain, m (skirted kinds; others: half). */
const MAX_DROP = 0.6;
const SKIRTED: ReadonlySet<BaseKind> = new Set<BaseKind>(['hesco', 'sandbags', 'jersey', 'gate', 'booth', 'tent', 'watchTower', 'mgNest', 'aaGun', 'helipad', 'flagPole']);

export interface GuardPost {
  id: string;
  /** World position where the guard stands, m. */
  x: number;
  z: number;
  /**
   * 'tower' guards only: the height of the deck he stands on above the ground at the tower's footprint centre, m
   * (world height = field.height(tower.x, tower.z) + y; the tower is `on`).
   */
  y?: number;
  /** The prop he stands on or behind (tower, machine-gun nest, gate). */
  on?: string;
  /** Which way he faces, rad (yaw about +Y, as a soldier placement's yaw). */
  yaw: number;
  post: 'tower' | 'mg' | 'gate' | 'patrol';
  /** 'patrol' only: the waypoints of a closed loop (world, m), starting where he stands. */
  route?: Array<{ x: number; z: number }>;
}

export interface BasePlan {
  size: BaseSize;
  center: { x: number; z: number };
  /** The direction the front (gate) faces, rad. */
  facingYaw: number;
  /** Every collider of the base lies within this distance of the centre, m. */
  radius: number;
  props: SceneryPlacement[];
  guards: GuardPost[];
  /** Open ground inside the base (the lane and the yard), clear of every prop: spots for more soldiers. */
  yard: Array<{ x: number; z: number }>;
}

/** Terrain heights, when the base is planned on real ground. */
export interface BaseGround {
  height(x: number, z: number): number;
}

// ---------------------------------------------------------------------------------------------
// Oriented footprints (base frame)

interface Rect {
  /** Centre, base frame, m. */
  u: number;
  w: number;
  /** Half sizes along the rectangle's own axes, m. */
  hu: number;
  hw: number;
  /** The rectangle's rotation in the base frame, rad (prop convention). */
  yaw: number;
}

/** The footprint rectangle of a prop of `kind` at (u, w) turned by `yaw` (base frame). */
function rectOf(kind: BaseKind, u: number, w: number, yaw: number): Rect {
  const f = propFootprintRect(kind);
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return { u: u + c * f.cx + s * f.cz, w: w - s * f.cx + c * f.cz, hu: f.hx, hw: f.hz, yaw };
}

function axesOf(r: Rect): Array<{ u: number; w: number }> {
  const c = Math.cos(r.yaw);
  const s = Math.sin(r.yaw);
  return [
    { u: c, w: -s },
    { u: s, w: c },
  ];
}

function cornersOf(r: Rect): Array<{ u: number; w: number }> {
  const [a, b] = axesOf(r);
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([sa, sb]) => ({ u: r.u + a.u * r.hu * sa + b.u * r.hw * sb, w: r.w + a.w * r.hu * sa + b.w * r.hw * sb }));
}

/** How deep two rectangles overlap (separating-axis test), m; <= 0 when they are `gap` m apart or more. */
function overlapDepth(a: Rect, b: Rect, gap: number): number {
  let depth = Infinity;
  for (const axis of [...axesOf(a), ...axesOf(b)]) {
    const project = (r: Rect): [number, number] => {
      const ps = cornersOf(r).map((p) => p.u * axis.u + p.w * axis.w);
      return [Math.min(...ps), Math.max(...ps)];
    };
    const [a0, a1] = project(a);
    const [b0, b1] = project(b);
    depth = Math.min(depth, Math.min(a1, b1) - Math.max(a0, b0) + gap);
    if (depth <= 0) return depth;
  }
  return depth;
}

/** True when the rectangles overlap by more than 2 cm (`gap` m of clearance asked for). */
export function rectsOverlap(a: Rect, b: Rect, gap = 0): boolean {
  return overlapDepth(a, b, gap) > 0.02;
}

// ---------------------------------------------------------------------------------------------
// Planner

interface Placed {
  kind: BaseKind;
  u: number;
  w: number;
  yaw: number;
  rect: Rect;
  /** Props of one group may overlap each other (a tank under its net, a helicopter on its pad). */
  group?: number;
  id: string;
}

class Planner {
  readonly placed: Placed[] = [];
  private readonly counts = new Map<BaseKind, number>();
  private nextGroup = 1;

  constructor(
    readonly size: BaseSize,
    readonly S: number,
    readonly toWorld: (u: number, w: number) => { x: number; z: number },
    readonly facingYaw: number,
    readonly prefix: string,
    readonly field?: BaseGround,
  ) {}

  newGroup(): number {
    return this.nextGroup++;
  }

  private idFor(kind: BaseKind): string {
    const n = this.counts.get(kind) ?? 0;
    this.counts.set(kind, n + 1);
    return `${this.prefix}-${kind}-${n}`;
  }

  /** True when a prop's footprint fits: no overlap with others (`gap` m apart, except its group) and, inside, clear of the lane and ring road. */
  fits(kind: BaseKind, u: number, w: number, yaw: number, opts: { gap: number; group?: number; interior: boolean; lane?: boolean; slope?: boolean }): boolean {
    const r = rectOf(kind, u, w, yaw);
    const corners = cornersOf(r);
    if (opts.interior) {
      const lim = this.S - INTERIOR_INSET;
      if (corners.some((p) => Math.abs(p.u) > lim + 1e-9 || Math.abs(p.w) > lim + 1e-9)) return false;
      if (opts.lane !== false) {
        const lane = LANE_HALF[this.size];
        // The lane: from the gate down to the back band (the helipad of a base sits at its end).
        const laneEnd = this.size === 'base' ? -6.5 : -this.S;
        if (overlapDepth(r, { u: 0, w: (this.S + laneEnd) / 2, hu: lane, hw: (this.S - laneEnd) / 2, yaw: 0 }, 0) > 0.02) return false;
      }
    }
    for (const q of this.placed) {
      if (opts.group !== undefined && q.group === opts.group) continue;
      if (overlapDepth(r, q.rect, opts.gap) > 0.02) return false;
    }
    if (opts.slope && this.field) {
      const hs = [...corners, { u: r.u, w: r.w }].map((p) => {
        const wp = this.toWorld(p.u, p.w);
        return (this.field as BaseGround).height(wp.x, wp.z);
      });
      const drop = Math.max(...hs) - Math.min(...hs);
      if (drop > (SKIRTED.has(kind) ? MAX_DROP : MAX_DROP / 2)) return false;
    }
    return true;
  }

  /** Place a prop where it stands, no questions asked (the perimeter: towers, nests, the gate). */
  put(kind: BaseKind, u: number, w: number, yaw: number, group?: number): Placed {
    const p: Placed = { kind, u, w, yaw, rect: rectOf(kind, u, w, yaw), group, id: this.idFor(kind) };
    this.placed.push(p);
    return p;
  }

  /**
   * Place an interior prop at (u, w) or the nearest free spot within `reach` m (rings 0.25 m apart), with
   * `jitter` m of seeded play in the wish. Null when nothing fits.
   */
  near(kind: BaseKind, u: number, w: number, yaw: number, rng: Rng, opts: { reach?: number; jitter?: number; yawJitter?: number; group?: number; lane?: boolean; gap?: number } = {}): Placed | null {
    const reach = opts.reach ?? 4;
    const j = opts.jitter ?? 0.4;
    const u0 = u + (rng() * 2 - 1) * j;
    const w0 = w + (rng() * 2 - 1) * j;
    const y0 = yaw + (rng() * 2 - 1) * (opts.yawJitter ?? 0.04);
    for (let ring = 0; ring * SEARCH_STEP <= reach + 1e-9; ring++) {
      const steps = ring === 0 ? 1 : ring * 8;
      for (let k = 0; k < steps; k++) {
        const a = (k / steps) * Math.PI * 2;
        const cu = u0 + Math.cos(a) * ring * SEARCH_STEP;
        const cw = w0 + Math.sin(a) * ring * SEARCH_STEP;
        if (this.fits(kind, cu, cw, y0, { gap: opts.gap ?? PROP_GAP, group: opts.group, interior: true, lane: opts.lane, slope: true })) {
          const p: Placed = { kind, u: cu, w: cw, yaw: y0, rect: rectOf(kind, cu, cw, y0), group: opts.group, id: this.idFor(kind) };
          this.placed.push(p);
          return p;
        }
      }
    }
    return null;
  }

  /** True when a point (base frame) is at least `clear` m outside every footprint. */
  open(u: number, w: number, clear: number): boolean {
    const dot: Rect = { u, w, hu: 0.01, hw: 0.01, yaw: 0 };
    return this.placed.every((q) => overlapDepth(dot, q.rect, clear) <= 0.02);
  }
}

/** Yaw (base frame) that turns a prop's +Z toward (du, dw). */
const yawToward = (du: number, dw: number): number => Math.atan2(du, dw);

/**
 * A believable small base round `center`, its front (the gate) facing `facingYaw` (rad, prop convention: 0 faces
 * +Z). Pure: the same `rng` sequence always gives the same plan. With `field`, interior props avoid footprints the
 * ground falls away under by more than their skirts hide (the perimeter is placed regardless: its skirts and
 * the tower legs reach 0.6 m into the ground). Ids start with `prefix`.
 */
export function planBase(center: { x: number; z: number }, facingYaw: number, size: BaseSize, rng: Rng, field?: BaseGround, prefix = 'base'): BasePlan {
  const S = HALF_SIDE[size];
  const cy = Math.cos(facingYaw);
  const sy = Math.sin(facingYaw);
  // Base frame to world: like a prop's local frame (u = local x, w = local z) turned by facingYaw.
  const toWorld = (u: number, w: number): { x: number; z: number } => ({ x: center.x + cy * u + sy * w, z: center.z - sy * u + cy * w });
  const P = new Planner(size, S, toWorld, facingYaw, prefix, field);
  const guards: GuardPost[] = [];
  const guardAt = (post: GuardPost['post'], on: Placed | null, u: number, w: number, yaw: number, extra: Partial<GuardPost> = {}): void => {
    const wp = toWorld(u, w);
    guards.push({ id: `${prefix}-guard-${guards.length}`, x: wp.x, z: wp.z, yaw: yaw + facingYaw, post, ...(on ? { on: on.id } : {}), ...extra });
  };
  /** A point `d` m along a prop's own +Z from its centre (base frame). */
  const ahead = (p: Placed, d: number): { u: number; w: number } => ({ u: p.u + Math.sin(p.yaw) * d, w: p.w + Math.cos(p.yaw) * d });

  // --- Perimeter: corners --------------------------------------------------------------------
  const corners: Array<[number, number]> = [
    [-S, S],
    [S, S],
    [S, -S],
    [-S, -S],
  ];
  for (const [u, w] of corners) {
    const out = yawToward(u, w); // diagonal, outward
    if (size === 'outpost' && w > 0) {
      const nest = P.put('mgNest', u, w, out);
      const g = ahead(nest, -0.4);
      guardAt('mg', nest, g.u, g.w, out);
    } else {
      // The tower faces out along the diagonal, so the guard looks over the middle of its front parapet.
      const tower = P.put('watchTower', u, w, out);
      const g = ahead(tower, 0.3);
      guardAt('tower', tower, g.u, g.w, out, { y: TOWER_DECK });
    }
  }

  // --- Perimeter: the gate, its booth and chicane; nests at the middle of the sides (a base) ------------------
  const gate = P.put('gate', 0, S, 0);
  P.put('booth', 5.6, S + 1.8, 0);
  P.put('jersey', -1.8, S + 4.0, 0);
  P.put('jersey', 1.8, S + 7.0, 0);
  guardAt('gate', gate, -2.6, S + 1.5, 0);
  guardAt('gate', gate, 2.6, S + 1.5, 0);

  /** Sides: outward normal (nu, nw), the yaw that lays a barrier along it, and what interrupts it (centre, half length along the side). */
  interface Side {
    nu: number;
    nw: number;
    stops: Array<[number, number]>;
  }
  const cornerHalf = 2.5; // a corner tower or nest, along each side, m
  const sides: Side[] = [
    { nu: 0, nw: 1, stops: [[0, 4.4]] }, // front: the gate
    { nu: 1, nw: 0, stops: [] },
    { nu: 0, nw: -1, stops: [] },
    { nu: -1, nw: 0, stops: [] },
  ];
  if (size === 'base') {
    // Nests in the middle of the flanks and the back, and either side of the gate on the front.
    for (const side of sides) {
      const at = side.nw === 1 ? [-13, 13] : [0];
      for (const t of at) {
        const u = side.nw !== 0 ? t : side.nu * S;
        const w = side.nw !== 0 ? side.nw * S : -t;
        const nest = P.put('mgNest', u, w, yawToward(side.nu, side.nw));
        const g = ahead(nest, -0.4);
        guardAt('mg', nest, g.u, g.w, nest.yaw);
        side.stops.push([t, 2.0]);
      }
    }
  }
  let sandbagRuns = 0;
  for (const side of sides) {
    // Position `t` m along the side (front and back: t = u; flanks: t = -w).
    const along = (t: number): { u: number; w: number } => (side.nw !== 0 ? { u: t, w: side.nw * S } : { u: side.nu * S, w: -t });
    const yaw = side.nw !== 0 ? 0 : Math.PI / 2;
    const ends: Array<[number, number]> = [
      [-S - 1, -S + cornerHalf],
      [S - cornerHalf, S + 1],
    ];
    const blocked = [...ends, ...side.stops.map(([c, h]): [number, number] => [c - h, c + h])].sort((a, b) => a[0] - b[0]);
    // One gap per side in a base (a sight lane through the perimeter), at a seeded place.
    let gapUsed = size === 'outpost';
    for (let i = 0; i + 1 < blocked.length; i++) {
      let t = blocked[i][1];
      const end = blocked[i + 1][0];
      while (end - t >= 2.9) {
        const room = end - t;
        if (!gapUsed && room > 9 && rng() < 0.5) {
          t += 3.5; // leave a gap
          gapUsed = true;
          continue;
        }
        // HESCO where there is room, sandbags to fill the rest (and now and then for variety).
        const useBags = room < 5.5 || rng() < 0.2;
        const kind: BaseKind = useBags ? 'sandbags' : 'hesco';
        const len = useBags ? 3.0 : 5.5;
        const p = along(t + len / 2);
        if (P.fits(kind, p.u, p.w, yaw, { gap: -0.05, interior: false })) {
          P.put(kind, p.u, p.w, yaw);
          if (useBags) sandbagRuns++;
        }
        t += len;
      }
    }
  }

  // --- Interior --------------------------------------------------------------------------
  const L = S - INTERIOR_INSET;
  const lane = LANE_HALF[size];
  if (size === 'base') {
    // Vehicle park (front left): a tank under a camouflage net, a second tank, three trucks nose to the lane.
    const g = P.newGroup();
    const net = P.near('camoNet', -L + 4.0, L - 5.3, 0, rng, { jitter: 0.2, yawJitter: 0, group: g });
    if (net) P.near('tank', net.u, net.w - 1.4, net.yaw, rng, { jitter: 0, yawJitter: 0, reach: 0, group: g });
    P.near('tank', -lane - 6.0, L - 8.5, 0, rng, { yawJitter: 0.08 });
    const trucks: BaseKind[] = ['cargoTruck', rng() < 0.5 ? 'cargoTruck' : 'fuelTruck', 'fuelTruck'];
    trucks.forEach((kind, i) => P.near(kind, -L + 8.6, 4.2 - i * 3.6, Math.PI / 2, rng, { jitter: 0.2, gap: 0.6 }));
    // Artillery line (back left), facing the front, ammunition behind the guns.
    const guns = [-L + 1.6, -L + 6.6, -L + 11.6].map((u) => P.near('artillery', u, -L + 5.2, 0, rng, { jitter: 0.3, yawJitter: 0.05, reach: 2.5 }));
    for (const gun of guns.slice(0, 2)) if (gun) P.near('ammoCrates', gun.u + 2.5, gun.w + 6.0, Math.PI / 2, rng, { reach: 3, gap: 0.6 });
    // Helipad at the end of the lane, the helicopter on it, nose to the back.
    const hg = P.newGroup();
    // The pad's far edge on the interior limit; the helicopter a metre forward of its centre, so its tail stops short
    // of the lane patrol's turning point and its rotor clear of the artillery.
    const pad = P.near('helipad', 0, -L + 7.0, 0, rng, { jitter: 0, yawJitter: 0, group: hg, lane: false, reach: 1.5 });
    for (const d of pad ? [1.0, 0.6, 1.4] : []) {
      if (pad && P.near('helicopter', pad.u, pad.w + d, Math.PI, rng, { jitter: 0, yawJitter: 0, reach: 0, group: hg, lane: false, gap: 0.5 })) break;
    }
    // Radar and air defence (front right): the radar faces out, two AA guns either side, their ammunition.
    P.near('radar', L - 6.0, L - 5.0, 0, rng, { yawJitter: 0.1 });
    P.near('aaGun', lane + 4.0, L - 3.2, 0, rng, { yawJitter: 0.3 });
    P.near('aaGun', L - 3.0, 4.4, Math.PI / 2, rng, { yawJitter: 0.3 });
    P.near('ammoCrates', lane + 3.4, L - 9.4, rng() * Math.PI, rng, { reach: 3 });
    // Tents (back right), long side to the lane.
    P.near('tent', L - 6.5, -L + 3.0, Math.PI / 2, rng, { jitter: 0.3, yawJitter: 0.03 });
    P.near('tent', L - 6.5, -L + 9.6, Math.PI / 2, rng, { jitter: 0.3, yawJitter: 0.03 });
    // Power and comms (middle right): generator, fuel drums behind a sandbag wall, a comms mast.
    P.near('generator', lane + 3.0, 0.5, Math.PI / 2, rng);
    P.near('fuelDrums', lane + 3.4, -3.4, rng() < 0.5 ? 0 : Math.PI / 2, rng, { reach: 4, gap: 0.6 });
    P.near('sandbags', lane + 6.2, -3.2, Math.PI / 2, rng, { gap: 0.3, reach: 3 });
    P.near('commsMast', L - 4.0, -1.5, -Math.PI / 2, rng, { reach: 3 });
    // By the lane: the flag (in the lane, off the patrol line) and two floodlights facing the lane.
    P.near('flagPole', lane - 0.8, 1.0, 0, rng, { lane: false, jitter: 0.2, reach: 1 });
    P.near('floodlight', -lane - 1.2, 9.0, Math.PI / 2, rng, { jitter: 0.2 });
    P.near('floodlight', -lane - 1.2, -5.0, Math.PI / 2, rng, { jitter: 0.2 });
  } else {
    // An outpost: a tent and ammunition on the right, a truck, generator and floodlight on the left, fuel drums
    // by the front right nest, the flag by the lane.
    const o = { reach: 1.5, gap: 0.35, jitter: 0.25 };
    P.near('tent', lane + 2.85, -3.0, 0, rng, { ...o, yawJitter: 0.03 });
    P.near('ammoCrates', lane + 2.85, 3.6, 0, rng, o);
    P.near('fuelDrums', lane + 2.85, 6.3, rng() < 0.5 ? 0 : Math.PI, rng, o);
    P.near('cargoTruck', -lane - 2.85, 0.1, 0, rng, { ...o, jitter: 0.15 });
    P.near('generator', -lane - 3.3, -6.2, Math.PI / 2, rng, o);
    P.near('floodlight', -lane - 2.85, 6.3, 0, rng, o);
    P.near('flagPole', -1.2, -3.5, 0, rng, { ...o, lane: false, jitter: 0.1 });
  }
  if (sandbagRuns === 0 && !P.placed.some((p) => p.kind === 'sandbags')) P.near('sandbags', lane + 2.0, 0, 0, rng, { reach: 6 });

  // --- Patrols -----------------------------------------------------------------------------
  const ringR = S - RING_INSET;
  const loops: Array<Array<[number, number]>> = [
    [
      [-ringR, ringR],
      [ringR, ringR],
      [ringR, -ringR],
      [-ringR, -ringR],
    ],
  ];
  if (size === 'base') loops.push([[0, L], [0, -2.0]]);
  for (const loop of loops) {
    const clear = loop.every(([u, w], i) => {
      const [u1, w1] = loop[(i + 1) % loop.length];
      const n = Math.ceil(Math.hypot(u1 - u, w1 - w) / 0.5);
      for (let k = 0; k <= n; k++) if (!P.open(u + ((u1 - u) * k) / n, w + ((w1 - w) * k) / n, ROUTE_CLEARANCE)) return false;
      return true;
    });
    if (!clear) continue;
    const route = loop.map(([u, w]) => toWorld(u, w));
    guardAt('patrol', null, loop[0][0], loop[0][1], yawToward(loop[1][0] - loop[0][0], loop[1][1] - loop[0][1]), { route });
  }

  // --- Open yard spots ---------------------------------------------------------------------
  const yard: Array<{ x: number; z: number }> = [];
  for (let w = L; w >= -L; w -= 3) {
    for (const u of [-lane * 0.6, lane * 0.6]) if (P.open(u, w, 1)) yard.push(toWorld(u, w));
  }

  const props: SceneryPlacement[] = P.placed.map((p) => {
    const wp = toWorld(p.u, p.w);
    return { id: p.id, kind: p.kind, x: wp.x, z: wp.z, yaw: p.yaw + facingYaw };
  });
  return { size, center: { ...center }, facingYaw, radius: BASE_RADIUS[size], props, guards, yard };
}
