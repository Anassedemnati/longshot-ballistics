// A small Verlet particle ragdoll (pure maths, no three.js): joints as point masses with a collision radius, bones as
// distance constraints, a few ranged links that keep a torso stiff but let it bend, hinge limits that stop knees and
// elbows folding the wrong way, gravity, damping, and a ground (the terrain height) with Coulomb friction. A fallen
// soldier is one of these: scene/ragdollBody.ts feeds the bullet's push in, steps it while it settles, and reads the
// bone poses out (`boneTransforms`) to drive a skinned mesh. It sleeps when it comes to rest, so a body lying in the
// dirt costs nothing.
//
// The simulation runs in the rig's own frame (feet at the origin, +Y up, gravity straight down whatever the soldier's
// yaw), with `ground(x, z)` giving the height of the ground there in that frame.

/** A point or vector, m. */
export type Vec = readonly [number, number, number];

/** One joint: where it stands in the bind (standing or lying) pose, how far its centre stays from the ground, and how heavy it is. */
export interface RigParticle {
  p: Vec;
  /** Collision radius, m: the particle rests this high above the ground (the body's thickness around that joint). */
  radius: number;
  /** Relative mass (heavier joints move less when a constraint pulls them). Default 1. */
  mass?: number;
}

/** The distance between particles `a` and `b` is kept within [min, max], m. A bone has min = max. */
export interface RigConstraint {
  a: number;
  b: number;
  min: number;
  max: number;
}

/**
 * A one-way hinge: `joint` (a knee or an elbow) must stay on one side of the line a-c, the side the body's front (+1) or back (-1) is on.
 * The body's front is `(left - right) x (upTo - upFrom)` (the hip line crossed with the spine: +Z for a soldier standing at rest).
 */
export interface RigHinge {
  joint: number;
  a: number;
  c: number;
  left: number;
  right: number;
  upFrom: number;
  upTo: number;
  side: 1 | -1;
}

/**
 * A bone of the skin: it pivots at particle `origin` and its frame is spanned by the direction `dirFrom -> dirTo` and a side vector
 * `sideFrom -> sideTo` (`sideFrom` < 0: world up), Gram-Schmidt style. The same function of the bind pose gives the rest frame, so
 * the bone's rotation is current frame times the inverse of the rest one: a twist follows whatever the side vector follows.
 */
export interface RigBone {
  origin: number;
  dirFrom: number;
  dirTo: number;
  sideFrom: number;
  sideTo: number;
}

export interface RigSpec {
  particles: readonly RigParticle[];
  constraints: readonly RigConstraint[];
  hinges: readonly RigHinge[];
  bones: readonly RigBone[];
}

/** Gravity, m/s^2. */
export const RAGDOLL_GRAVITY = 9.80665;
/** Fixed simulation substep, s. */
export const RAGDOLL_DT = 1 / 120;
/** Constraint passes per substep. */
const ITERATIONS = 7;
/** Frames longer than this are simulated only up to here, s (a stalled tab must not run the ragdoll for seconds). */
const MAX_FRAME = 0.1;
/** Velocity kept per substep (air and joint friction). */
const DAMPING = 0.9965;
/** Coulomb friction of cloth on dirt. */
const FRICTION = 0.85;
/** The body may sleep after this long, s, once it moves slower than SLEEP_SPEED for SLEEP_HOLD; it is cut off at MAX_TIME. */
const MIN_TIME = 0.8;
const SLEEP_SPEED = 0.07;
const SLEEP_HOLD = 0.35;
const MAX_TIME = 6;

/** The distance between two bind-pose particles, m. */
function dist(a: Vec, b: Vec): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Constraint `a`-`b` whose length is the bind pose's scaled into [lo, hi] (1, 1 is a rigid bone). */
export function link(particles: readonly RigParticle[], a: number, b: number, lo = 1, hi = 1): RigConstraint {
  const d = dist(particles[a].p, particles[b].p);
  return { a, b, min: d * lo, max: d * hi };
}

/** A pair no closer than `min` metres (an arm cannot fold into the chest). */
export function keepApart(a: number, b: number, min: number): RigConstraint {
  return { a, b, min, max: Infinity };
}

/** A pair no farther than the bind distance plus `slack` metres (a rifle on a sling). */
export function rope(particles: readonly RigParticle[], a: number, b: number, slack: number): RigConstraint {
  return { a, b, min: 0, max: dist(particles[a].p, particles[b].p) + slack };
}

export class Ragdoll {
  readonly count: number;
  /** Current positions, 3 per particle, in the rig's frame. */
  readonly pos: Float64Array;
  private readonly prev: Float64Array;
  private readonly invMass: Float64Array;
  private readonly radius: Float64Array;
  private readonly groundY: Float64Array;
  private accumulator = 0;
  private time = 0;
  private calm = 0;
  private sleeping = true;

  constructor(
    private readonly spec: RigSpec,
    /** Ground height at a position of the rig's frame, m (0 on flat ground at the feet). */
    private readonly ground: (x: number, z: number) => number,
  ) {
    this.count = spec.particles.length;
    this.pos = new Float64Array(this.count * 3);
    this.prev = new Float64Array(this.count * 3);
    this.invMass = new Float64Array(this.count);
    this.radius = new Float64Array(this.count);
    this.groundY = new Float64Array(this.count);
    spec.particles.forEach((q, i) => {
      this.invMass[i] = 1 / (q.mass ?? 1);
      this.radius[i] = q.radius;
    });
    this.start();
  }

  /** True once the body has come to rest (or the time cap ran out): `step` then does nothing. */
  get asleep(): boolean {
    return this.sleeping;
  }

  /** Seconds simulated since `start`. */
  get elapsed(): number {
    return this.time;
  }

  /** Put every particle back in the bind pose, at rest, and wake the simulation. */
  start(): void {
    this.spec.particles.forEach((q, i) => {
      for (let k = 0; k < 3; k++) {
        this.pos[i * 3 + k] = q.p[k];
        this.prev[i * 3 + k] = q.p[k];
      }
    });
    this.accumulator = 0;
    this.time = 0;
    this.calm = 0;
    this.sleeping = false;
  }

  /** Stop simulating (the pose stays where it is). */
  sleep(): void {
    this.sleeping = true;
  }

  /** Add the velocity (vx, vy, vz) m/s to particle `i`. */
  kick(i: number, vx: number, vy: number, vz: number): void {
    const k = i * 3;
    this.prev[k] -= vx * RAGDOLL_DT;
    this.prev[k + 1] -= vy * RAGDOLL_DT;
    this.prev[k + 2] -= vz * RAGDOLL_DT;
  }

  /**
   * Push the particles near `point` along `dir` (a unit vector): the particle at the point gets `speed` m/s, the ones `reach` m away
   * about a third of that (a Gaussian falloff), so a hit shoves the struck joint most and drags its neighbours.
   */
  kickAt(point: Vec, dir: Vec, speed: number, reach: number): void {
    for (let i = 0; i < this.count; i++) {
      const d = Math.hypot(this.pos[i * 3] - point[0], this.pos[i * 3 + 1] - point[1], this.pos[i * 3 + 2] - point[2]);
      const w = Math.exp(-((d / reach) * (d / reach)));
      if (w < 0.02) continue;
      this.kick(i, dir[0] * speed * w, dir[1] * speed * w, dir[2] * speed * w);
    }
  }

  /** Index of the particle nearest `point`. */
  nearest(point: Vec): number {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < this.count; i++) {
      const d = Math.hypot(this.pos[i * 3] - point[0], this.pos[i * 3 + 1] - point[1], this.pos[i * 3 + 2] - point[2]);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /** Advance by `frameDt` seconds in whole fixed substeps (the remainder carries over). Does nothing once asleep. */
  step(frameDt: number): void {
    if (this.sleeping || !Number.isFinite(frameDt) || frameDt <= 0) return;
    this.accumulator += Math.min(frameDt, MAX_FRAME);
    while (this.accumulator >= RAGDOLL_DT && !this.sleeping) {
      this.accumulator -= RAGDOLL_DT;
      this.substep();
    }
  }

  private substep(): void {
    const { pos, prev, count } = this;
    const gdt2 = RAGDOLL_GRAVITY * RAGDOLL_DT * RAGDOLL_DT;
    for (let i = 0; i < count; i++) {
      const k = i * 3;
      for (let a = 0; a < 3; a++) {
        const x = pos[k + a];
        const v = (x - prev[k + a]) * DAMPING;
        prev[k + a] = x;
        pos[k + a] = x + v - (a === 1 ? gdt2 : 0);
      }
      this.groundY[i] = this.ground(pos[k], pos[k + 2]) + this.radius[i];
    }
    for (let it = 0; it < ITERATIONS; it++) {
      for (const c of this.spec.constraints) this.solveDistance(c);
      for (const h of this.spec.hinges) this.solveHinge(h);
      this.collide();
    }
    this.time += RAGDOLL_DT;
    if (this.time >= MIN_TIME) {
      let fastest = 0;
      for (let i = 0; i < count * 3; i++) fastest = Math.max(fastest, Math.abs(pos[i] - prev[i]));
      this.calm = fastest / RAGDOLL_DT < SLEEP_SPEED ? this.calm + RAGDOLL_DT : 0;
      if (this.calm >= SLEEP_HOLD || this.time >= MAX_TIME) this.sleeping = true;
    }
  }

  private solveDistance(c: RigConstraint): void {
    const { pos } = this;
    const a = c.a * 3;
    const b = c.b * 3;
    const dx = pos[a] - pos[b];
    const dy = pos[a + 1] - pos[b + 1];
    const dz = pos[a + 2] - pos[b + 2];
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-9) return;
    const target = d > c.max ? c.max : d < c.min ? c.min : d;
    if (target === d) return;
    const wa = this.invMass[c.a];
    const wb = this.invMass[c.b];
    const k = (d - target) / d / (wa + wb);
    pos[a] -= dx * k * wa;
    pos[a + 1] -= dy * k * wa;
    pos[a + 2] -= dz * k * wa;
    pos[b] += dx * k * wb;
    pos[b + 1] += dy * k * wb;
    pos[b + 2] += dz * k * wb;
  }

  private solveHinge(h: RigHinge): void {
    const { pos } = this;
    const at = (i: number, k: number): number => pos[i * 3 + k];
    // The body's front: the hip line crossed with the spine.
    const lx = at(h.left, 0) - at(h.right, 0);
    const ly = at(h.left, 1) - at(h.right, 1);
    const lz = at(h.left, 2) - at(h.right, 2);
    const ux = at(h.upTo, 0) - at(h.upFrom, 0);
    const uy = at(h.upTo, 1) - at(h.upFrom, 1);
    const uz = at(h.upTo, 2) - at(h.upFrom, 2);
    let fx = ly * uz - lz * uy;
    let fy = lz * ux - lx * uz;
    let fz = lx * uy - ly * ux;
    const fl = Math.hypot(fx, fy, fz);
    if (fl < 1e-9) return;
    fx = (fx / fl) * h.side;
    fy = (fy / fl) * h.side;
    fz = (fz / fl) * h.side;
    const mx = (at(h.a, 0) + at(h.c, 0)) / 2;
    const my = (at(h.a, 1) + at(h.c, 1)) / 2;
    const mz = (at(h.a, 2) + at(h.c, 2)) / 2;
    const s = (at(h.joint, 0) - mx) * fx + (at(h.joint, 1) - my) * fy + (at(h.joint, 2) - mz) * fz;
    if (s >= 0) return;
    // The joint bent the wrong way: swing it back across the line, the ends move half as far the other way.
    const move = (i: number, amount: number): void => {
      pos[i * 3] += fx * amount;
      pos[i * 3 + 1] += fy * amount;
      pos[i * 3 + 2] += fz * amount;
    };
    move(h.joint, -s * 0.6);
    move(h.a, s * 0.2);
    move(h.c, s * 0.2);
  }

  private collide(): void {
    const { pos, prev } = this;
    const friction = FRICTION * RAGDOLL_GRAVITY * RAGDOLL_DT * RAGDOLL_DT;
    for (let i = 0; i < this.count; i++) {
      const k = i * 3;
      const floor = this.groundY[i];
      if (pos[k + 1] >= floor) continue;
      pos[k + 1] = floor;
      prev[k + 1] = floor; // no bounce: a body does not rebound
      // Coulomb friction: the sliding of this substep shrinks by mu * g * dt^2 (to nothing, if that is all there was).
      const sx = pos[k] - prev[k];
      const sz = pos[k + 2] - prev[k + 2];
      const slide = Math.hypot(sx, sz);
      if (slide > 0) {
        const keep = Math.max(0, slide - friction) / slide;
        prev[k] = pos[k] - sx * keep;
        prev[k + 2] = pos[k + 2] - sz * keep;
      }
    }
  }
}

// ---- bones ----

type M3 = [number, number, number, number, number, number, number, number, number];

/** Frame (columns x, y, z, row-major) from a direction and a side vector: z along the direction, x the side with that removed, y = z cross x. */
function frame(dir: Vec, side: Vec): M3 {
  const dl = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const zx = dir[0] / dl;
  const zy = dir[1] / dl;
  const zz = dir[2] / dl;
  let sx = side[0];
  let sy = side[1];
  let sz = side[2];
  let dot = sx * zx + sy * zy + sz * zz;
  sx -= dot * zx;
  sy -= dot * zy;
  sz -= dot * zz;
  let sl = Math.hypot(sx, sy, sz);
  if (sl < 1e-4 * (Math.hypot(side[0], side[1], side[2]) || 1) || sl < 1e-9) {
    // Side and direction (nearly) parallel: any perpendicular will do (the twist is unknown there anyway).
    const alt: Vec = Math.abs(zy) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    dot = alt[0] * zx + alt[1] * zy + alt[2] * zz;
    sx = alt[0] - dot * zx;
    sy = alt[1] - dot * zy;
    sz = alt[2] - dot * zz;
    sl = Math.hypot(sx, sy, sz);
  }
  sx /= sl;
  sy /= sl;
  sz /= sl;
  const yx = zy * sz - zz * sy;
  const yy = zz * sx - zx * sz;
  const yz = zx * sy - zy * sx;
  return [sx, yx, zx, sy, yy, zy, sz, yz, zz];
}

const WORLD_UP: Vec = [0, 1, 0];

/** The frame of bone `b` for the particle positions `at` (3 per particle). */
function boneFrame(b: RigBone, at: ArrayLike<number>): M3 {
  const p = (i: number, k: number): number => at[i * 3 + k];
  const dir: Vec = [p(b.dirTo, 0) - p(b.dirFrom, 0), p(b.dirTo, 1) - p(b.dirFrom, 1), p(b.dirTo, 2) - p(b.dirFrom, 2)];
  const side: Vec = b.sideFrom < 0 ? WORLD_UP : [p(b.sideTo, 0) - p(b.sideFrom, 0), p(b.sideTo, 1) - p(b.sideFrom, 1), p(b.sideTo, 2) - p(b.sideFrom, 2)];
  return frame(dir, side);
}

/** Positions of a spec's bind pose, 3 per particle. */
export function bindPositions(spec: RigSpec): Float64Array {
  const out = new Float64Array(spec.particles.length * 3);
  spec.particles.forEach((q, i) => out.set(q.p, i * 3));
  return out;
}

/** Quaternion (x, y, z, w) of the rotation matrix a * transpose(b). */
function relativeQuaternion(a: M3, b: M3, out: Float32Array | number[], o: number): void {
  // r = a * b^T
  const r = (i: number, j: number): number => a[i * 3] * b[j * 3] + a[i * 3 + 1] * b[j * 3 + 1] + a[i * 3 + 2] * b[j * 3 + 2];
  const m00 = r(0, 0), m01 = r(0, 1), m02 = r(0, 2);
  const m10 = r(1, 0), m11 = r(1, 1), m12 = r(1, 2);
  const m20 = r(2, 0), m21 = r(2, 1), m22 = r(2, 2);
  const trace = m00 + m11 + m22;
  let x: number, y: number, z: number, w: number;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = 0.25 * s;
    x = (m21 - m12) / s;
    y = (m02 - m20) / s;
    z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  const l = Math.hypot(x, y, z, w) || 1;
  out[o] = x / l;
  out[o + 1] = y / l;
  out[o + 2] = z / l;
  out[o + 3] = w / l;
}

/**
 * Every bone's pose for the particle positions `at`, 7 numbers per bone: the pivot (x, y, z) and the rotation (x, y, z, w) that takes
 * the bind pose to this one. `bindFrames` is `bindBoneFrames(spec)`, computed once.
 */
export function boneTransforms(spec: RigSpec, bindFrames: readonly M3[], at: ArrayLike<number>, out: Float32Array | number[]): void {
  spec.bones.forEach((b, i) => {
    const o = i * 7;
    out[o] = at[b.origin * 3];
    out[o + 1] = at[b.origin * 3 + 1];
    out[o + 2] = at[b.origin * 3 + 2];
    relativeQuaternion(boneFrame(b, at), bindFrames[i], out, o + 3);
  });
}

/** The rest frame of every bone (from the bind pose). */
export function bindBoneFrames(spec: RigSpec): M3[] {
  const bind = bindPositions(spec);
  return spec.bones.map((b) => boneFrame(b, bind));
}
