import { DEFAULT_DT, step } from '../ballistics/integrator';
import type { Atmosphere, BulletState, Rifle, Vec3, WindField } from '../ballistics/types';
import { muzzleLaunch } from './aim';

// Aim assists (spec B.5), pure: no three.js, no DOM. The trajectory preview, the assisted-aim marker and
// the spotter calls all come from the same integrator, bore offset and zero elevation the live bullets use,
// stepped at the same 1 ms, so what they show is what a shot does.

export const WORLD_UP: Vec3 = { x: 0, y: 1, z: 0 };

/** A preview or solution flight is cut after this much flight time, s (the bullets' own limit). */
export const MAX_FLIGHT_S = 6;
/** The preview ends this far from the eye unless told otherwise, m. */
export const DEFAULT_PREVIEW_RANGE_M = 2000;
/** `solveAim` is satisfied when the shot crosses the target's plane this close to the aim point, m. */
export const SOLVE_TOLERANCE_M = 0.005;
const MAX_SOLVE_ITERATIONS = 16;
/** A target closer than this (horizontally) cannot be solved, m. */
const MIN_SOLVE_RANGE_M = 1;
/** Terrain crossing is bisected to well under a millimetre of the step. */
const GROUND_BISECTIONS = 24;

const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const lerp = (a: Vec3, b: Vec3, u: number): Vec3 => ({
  x: a.x + (b.x - a.x) * u,
  y: a.y + (b.y - a.y) * u,
  z: a.z + (b.z - a.z) * u,
});

function unit(v: Vec3): Vec3 {
  const l = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

/**
 * The up vector of a roll-free view (the player's camera: yaw, then pitch, no roll) that looks along
 * `forward`: `worldUp` with its part along `forward` removed, as a unit vector. The weapon fires with
 * exactly this `up`, so the solver and the preview use it too. Throws when the view is parallel to `worldUp`.
 */
export function levelUp(forward: Vec3, worldUp: Vec3 = WORLD_UP): Vec3 {
  const f = unit(forward);
  const d = dot(worldUp, f);
  const u = { x: worldUp.x - d * f.x, y: worldUp.y - d * f.y, z: worldUp.z - d * f.z };
  const l = Math.hypot(u.x, u.y, u.z);
  if (!(l > 1e-9)) throw new Error('levelUp: forward must not be parallel to up');
  return { x: u.x / l, y: u.y / l, z: u.z / l };
}

export interface PredictOptions {
  /** Ground height (y) at a horizontal position. The flight ends where it meets the ground. Default: no ground. */
  groundHeight?: (x: number, z: number) => number;
  /** The flight ends where it has gone this far from the eye, measured along `bearing`, m. Default 2000. */
  maxRange?: number;
  /** Horizontal direction the range is measured along (its y is ignored). Default: the horizontal part of `forward`. */
  bearing?: Vec3;
  /** Keep every n-th integration step as a point of the path (the first and the last point are always kept). Default 10. */
  sampleEvery?: number;
  /** Longest flight time, s. Default 6. */
  maxTime?: number;
  /** Integration step, s. Default 1 ms, the live bullets' own step; a drawn line can take a coarser one (5 ms is within millimetres, 5x cheaper). */
  dt?: number;
  /**
   * Where to keep the points of the path instead of a new array of new vectors (see `createPathBuffer`): the
   * preview is flown ten times a second and must not allocate for every point. Points that do not fit are dropped.
   */
  buffer?: PathBuffer;
}

/** Preallocated storage for the points of a path; `predictPath` fills it in place. */
export interface PathBuffer {
  /** `capacity` vectors, written over by every flight. */
  points: Vec3[];
}

/** A buffer for paths of up to `capacity` points. */
export function createPathBuffer(capacity: number): PathBuffer {
  return { points: Array.from({ length: capacity }, () => ({ x: 0, y: 0, z: 0 })) };
}

export interface PathPrediction {
  /** The path from the bore to its end, in order. With a buffer: the buffer's own array, of which only the first `count` points are this path. */
  points: Vec3[];
  /** How many entries of `points` belong to the path. */
  count: number;
  /** Where the flight met the ground, or null when it ended in the air (range reached, time up). */
  impact: Vec3 | null;
  /** Flight time to the end of the path, s. */
  time: number;
  /** Where the flight crossed the vertical plane `maxRange` away along the bearing; null when the ground or the time limit came first. */
  atRange: Vec3 | null;
}

/** Where along the step prev -> next (a fraction u) the ground is crossed; `prev` is above it and `next` below. */
function groundCrossing(prev: Vec3, next: Vec3, ground: (x: number, z: number) => number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < GROUND_BISECTIONS; i++) {
    const mid = 0.5 * (lo + hi);
    const p = lerp(prev, next, mid);
    if (p.y < ground(p.x, p.z)) hi = mid;
    else lo = mid;
  }
  return 0.5 * (lo + hi);
}

/**
 * Fly a shot from the rifle with the real integrator (same drag, wind and bore offset as a live bullet,
 * 1 ms steps unless `opts.dt` says otherwise) until it meets the ground, crosses `maxRange`, or runs out of time. `forward` and `up`
 * are what the weapon would fire with (see `levelUp`), `zero` the zero elevation (`findZeroElevation`).
 */
export function predictPath(
  eye: Vec3,
  forward: Vec3,
  up: Vec3,
  rifle: Rifle,
  atmo: Atmosphere,
  wind: WindField,
  zero: number,
  opts: PredictOptions = {},
): PathPrediction {
  const maxRange = opts.maxRange ?? DEFAULT_PREVIEW_RANGE_M;
  const maxTime = opts.maxTime ?? MAX_FLIGHT_S;
  const dt = opts.dt ?? DEFAULT_DT;
  const every = Math.max(1, opts.sampleEvery ?? 10);
  const ground = opts.groundHeight;
  const dirSource = opts.bearing ?? forward;
  const horizontal = Math.hypot(dirSource.x, dirSource.z);

  const launch = muzzleLaunch(eye, forward, up, rifle, zero);
  let s: BulletState = { pos: launch.origin, vel: launch.velocity, t: 0 };
  const buffer = opts.buffer;
  const points: Vec3[] = buffer ? buffer.points : [];
  let count = 0;
  /** Keep a point of the path: pushed as it is, or copied into the next vector of the buffer. */
  const keep = (p: Vec3): void => {
    if (buffer === undefined) {
      points.push(p);
    } else if (count < points.length) {
      const q = points[count];
      q.x = p.x;
      q.y = p.y;
      q.z = p.z;
    } else {
      return;
    }
    count++;
  };
  keep(s.pos);
  if (!(horizontal > 1e-9)) return { points, count, impact: null, time: 0, atRange: null };
  const bx = dirSource.x / horizontal;
  const bz = dirSource.z / horizontal;
  const along = (p: Vec3): number => (p.x - eye.x) * bx + (p.z - eye.z) * bz;

  let last = s.pos; // the last point offered (kept or not), to close the path with the final position
  const steps = Math.ceil(maxTime / dt - 1e-9);
  for (let i = 1; i <= steps; i++) {
    const prev = s;
    s = step(prev, dt, rifle.bcG7, atmo, wind);
    if (ground !== undefined && s.pos.y < ground(s.pos.x, s.pos.z)) {
      const u = groundCrossing(prev.pos, s.pos, ground);
      const impact = lerp(prev.pos, s.pos, u);
      keep(impact);
      return { points, count, impact, time: prev.t + u * dt, atRange: null };
    }
    const a1 = along(s.pos);
    if (a1 >= maxRange) {
      const a0 = along(prev.pos);
      const u = a1 > a0 ? Math.min(1, Math.max(0, (maxRange - a0) / (a1 - a0))) : 1;
      const end = lerp(prev.pos, s.pos, u);
      keep(end);
      return { points, count, impact: null, time: prev.t + u * dt, atRange: end };
    }
    if (i % every === 0) {
      keep(s.pos);
      last = s.pos;
    }
  }
  if (last !== s.pos) keep(s.pos);
  return { points, count, impact: null, time: s.t, atRange: null };
}

/**
 * The direction (unit vector) to point the rifle so the shot passes through `target`, or null when no such
 * direction is found (the target is overhead, or beyond what the bullet reaches in its flight time).
 * Iterates on the real flight: aim at the point, see where the shot crosses the target's vertical plane
 * (the plane through the target, square to the bearing from the eye), move the aim point by the miss, repeat.
 * Wind, drop, the bore offset and the downhill angle are all in the flight, none is approximated. `up` is the
 * world up the view is levelled against (see `levelUp`). No terrain is applied: the solved line of fire may
 * dip below the ground on the way (the preview shows that).
 */
export function solveAim(
  eye: Vec3,
  target: Vec3,
  rifle: Rifle,
  atmo: Atmosphere,
  wind: WindField,
  zero: number,
  up: Vec3 = WORLD_UP,
): Vec3 | null {
  const range = Math.hypot(target.x - eye.x, target.z - eye.z);
  if (!(range > MIN_SOLVE_RANGE_M)) return null;
  const bearing: Vec3 = { x: (target.x - eye.x) / range, y: 0, z: (target.z - eye.z) / range };
  const worldUp = unit(up);

  let aim = target;
  for (let i = 0; i < MAX_SOLVE_ITERATIONS; i++) {
    const dir = unit(sub(aim, eye));
    if (Math.abs(dot(dir, worldUp)) > 0.999) return null;
    const path = predictPath(eye, dir, levelUp(dir, worldUp), rifle, atmo, wind, zero, {
      maxRange: range,
      bearing,
      sampleEvery: Infinity,
    });
    if (path.atRange === null) return null;
    const miss = sub(target, path.atRange);
    if (Math.hypot(miss.x, miss.y, miss.z) < SOLVE_TOLERANCE_M) return dir;
    aim = add(aim, miss);
  }
  return null;
}

/** How far the solved direction lies from the crosshair, in milliradians of the reticle: above (+) and to the right (+). */
export interface AimOffset {
  upMil: number;
  rightMil: number;
}

/**
 * Where the solved direction lies relative to the crosshair, in the reticle's frame (`forward` the view axis,
 * `up` the view's up, right = forward x up, as in `muzzleLaunch`). Each angle is atan of the component over the
 * forward component, the same tangent scale `milToPixels` uses, so the numbers read straight off the reticle.
 */
export function aimOffsetMil(forward: Vec3, up: Vec3, solved: Vec3): AimOffset {
  const f = unit(forward);
  const right = unit(cross(f, up));
  const u = cross(right, f);
  const along = dot(solved, f);
  return {
    upMil: Math.atan2(dot(solved, u), along) * 1000,
    rightMil: Math.atan2(dot(solved, right), along) * 1000,
  };
}

const tenth = (mil: number): number => Math.round(mil * 10) / 10;

/** "Hold 1.2 mil high, 0.4 mil right"; only the parts that round to a tenth of a mil or more; "On target"; "No solution". */
export function spotterText(offset: AimOffset | null): string {
  if (offset === null) return 'No solution';
  const up = tenth(offset.upMil);
  const right = tenth(offset.rightMil);
  const parts: string[] = [];
  if (up !== 0) parts.push(`${Math.abs(up).toFixed(1)} mil ${up > 0 ? 'high' : 'low'}`);
  if (right !== 0) parts.push(`${Math.abs(right).toFixed(1)} mil ${right > 0 ? 'right' : 'left'}`);
  return parts.length === 0 ? 'On target' : `Hold ${parts.join(', ')}`;
}

/** The spotter's call for the current crosshair (`forward`, `up`) and the solved direction (null: no solution). */
export function spotterCall(forward: Vec3, up: Vec3, solved: Vec3 | null): string {
  return spotterText(solved === null ? null : aimOffsetMil(forward, up, solved));
}

/** Something the player can shoot at: its id and the point to hit (a soldier's chest, a vehicle's engine). */
export interface AimTarget {
  id: string;
  point: Vec3;
}

/** The target nearest the crosshair by angle (not by range), or null with none. */
export function nearestToCrosshair(eye: Vec3, forward: Vec3, targets: readonly AimTarget[]): AimTarget | null {
  const f = unit(forward);
  let best: AimTarget | null = null;
  let bestCos = -Infinity;
  for (const t of targets) {
    const d = sub(t.point, eye);
    const l = Math.hypot(d.x, d.y, d.z);
    if (!(l > 1e-9)) continue;
    const c = dot(d, f) / l;
    if (c > bestCos) {
      bestCos = c;
      best = t;
    }
  }
  return best;
}
