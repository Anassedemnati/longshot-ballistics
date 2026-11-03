import { S, SOLDIER_RIG } from './soldierRig';
import { SOLDIER_RIFLE_BUTT, SOLDIER_RIFLE_DIR } from './soldierModel';

// A standing, crouching, kneeling or running soldier as eighteen joints (the particles of the ragdoll rig, mission/soldierRig.ts), made by
// forward kinematics from a handful of numbers (`PoseParams`). Pure maths, no three.js: scene/ragdollBody.ts feeds the joints to the same
// `boneTransforms` the ragdoll uses, so the skin, the hit spheres and, when he is shot, the fall all start from the very same joints.
//
// Every bone is rigid in the skin, so the joints must keep the rig's bone lengths exactly: the pelvis block (pelvis and hips) and the chest
// block (neck, chest, shoulders, head) are rigid transforms of their bind positions, and each knee and elbow comes from a two-bone solve with
// the bind pose's own lengths, so no pose can stretch a thigh or open a gap at the elbow. Blending is done on the parameters, never on joints.
//
// Frame: the body's own, as the model's: origin at the feet, +Z in front of him, +Y up, +X to his left. The caller turns it by the body's yaw.

/** Joint array: three numbers (x, y, z) per rig particle, in the order of `S`. */
export const JOINT_COUNT = SOLDIER_RIG.particles.length;
export const JOINT_FLOATS = JOINT_COUNT * 3;

/** The numbers a pose is built from. All lengths in m, angles in rad. */
export interface PoseParams {
  /** Height of the pelvis joint above the ground at his feet (bind: 0.99). */
  pelvisY: number;
  /** The pelvis' sideways and forward shift from the body's origin (weight shift, sway). */
  pelvisX: number;
  pelvisZ: number;
  /** Tilt of the hips about the front axis (the pelvis drops on the side of the swinging leg). */
  pelvisRoll: number;
  /** Forward lean of the torso about the pelvis (positive: forward). */
  pitch: number;
  /** Torso turn about the vertical, relative to the hips (positive: toward his left). */
  twist: number;
  /** Sideways lean of the torso (positive: toward his right). */
  roll: number;
  /** Head nod (positive: looking down), about the neck. */
  headPitch: number;
  /** Chest rise of a breath, m. */
  breath: number;
  /** 0: rifle at the low ready across the body .. 1: shouldered and aimed. */
  aim: number;
  /** Elevation of the aimed rifle, rad. */
  aimPitch: number;
  /** 0..1: how far the rifle has kicked back (it decays on its own). */
  recoil: number;
  /**
   * 0..1: how far his hands have left the rifle's grips for the small of his back, clasped there (the HVT officer, who carries no rifle,
   * at ease). Default 0. The arms keep their bone lengths: the hands are a target for the same two-bone solve.
   */
  behind?: number;
  /** Ankle targets (the ankle joint stands this high above the sole: 0.16 m). x sideways, y up from the ground at his feet, z forward. */
  footL: [number, number, number];
  footR: [number, number, number];
}

/** A fresh parameter set: standing at ease, as the bind pose. */
export function standingPose(): PoseParams {
  const L = SOLDIER_RIG.particles[S.footL].p;
  const R = SOLDIER_RIG.particles[S.footR].p;
  return {
    pelvisY: SOLDIER_RIG.particles[S.pelvis].p[1],
    pelvisX: 0,
    pelvisZ: 0,
    pelvisRoll: 0,
    pitch: 0,
    twist: 0,
    roll: 0,
    headPitch: 0,
    breath: 0,
    aim: 0,
    aimPitch: 0,
    recoil: 0,
    footL: [L[0], L[1], L[2]],
    footR: [R[0], R[1], R[2]],
  };
}

// ---- bind-pose numbers, taken once from the rig ----

const bind = (i: number): readonly [number, number, number] => SOLDIER_RIG.particles[i].p;
const len = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const PELVIS = bind(S.pelvis);
const NECK = bind(S.neck);

/** Bone lengths of each arm and leg: [upper, lower]. */
const ARM_L = [len(bind(S.shL), bind(S.elbL)), len(bind(S.elbL), bind(S.handL))] as const;
const ARM_R = [len(bind(S.shR), bind(S.elbR)), len(bind(S.elbR), bind(S.handR))] as const;
const LEG_L = [len(bind(S.hipL), bind(S.kneeL)), len(bind(S.kneeL), bind(S.footL))] as const;
const LEG_R = [len(bind(S.hipR), bind(S.kneeR)), len(bind(S.kneeR), bind(S.footR))] as const;

/** The rifle's length, butt to muzzle, m. */
const RIFLE_LENGTH = len(bind(S.butt), bind(S.muzzle));

type V = [number, number, number];

/** Unit direction of the low-ready rifle (the bind pose's). */
const LOW_DIR: V = (() => {
  const d = [bind(S.muzzle)[0] - bind(S.butt)[0], bind(S.muzzle)[1] - bind(S.butt)[1], bind(S.muzzle)[2] - bind(S.butt)[2]];
  const l = Math.hypot(d[0], d[1], d[2]);
  return [d[0] / l, d[1] / l, d[2] / l];
})();

/**
 * Where the rifle sits when he has it at his shoulder, in the chest's bind frame (the frame of the standing model): the stock in the pocket of the
 * right shoulder, a little in front of it. Its direction is not here: aimed, it is "straight ahead of the chest, pitched by `aimPitch`".
 */
const AIM_BUTT: V = [-0.17, 1.44, 0.09];

/** Where the hands rest clasped at the small of his back, in the chest's bind frame (right, left), m. */
const BEHIND_R: V = [-0.045, 1.03, -0.19];
const BEHIND_L: V = [0.05, 1.05, -0.2];
/** Scratch for the clasped hands' place. */
const behindScratch = new Float64Array(3);

/** The rifle's frame for the direction `d` with its up as close to the world's as it gets (as the rifle bone: scene's `rifle` bone side is up). Columns x, y, z. */
function rifleFrame(d: V, out: Float64Array): void {
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  const zx = d[0] / l;
  const zy = d[1] / l;
  const zz = d[2] / l;
  // x: world up with the direction taken out, normalised: that is the rifle's "side" in the bone's own frame; y = z cross x.
  let sx = -zy * zx;
  let sy = 1 - zy * zy;
  let sz = -zy * zz;
  const sl = Math.hypot(sx, sy, sz) || 1;
  sx /= sl;
  sy /= sl;
  sz /= sl;
  out[0] = sx;
  out[1] = sy;
  out[2] = sz;
  out[3] = zy * sz - zz * sy;
  out[4] = zz * sx - zx * sz;
  out[5] = zx * sy - zy * sx;
  out[6] = zx;
  out[7] = zy;
  out[8] = zz;
}

/** Offsets of a hand's grip from the butt, in the rifle's own frame (x, y, z along its three axes), from the bind pose where the hands hold it. */
function grip(hand: readonly [number, number, number]): V {
  const f = new Float64Array(9);
  rifleFrame(LOW_DIR, f);
  const b = bind(S.butt);
  const d = [hand[0] - b[0], hand[1] - b[1], hand[2] - b[2]];
  return [
    f[0] * d[0] + f[1] * d[1] + f[2] * d[2],
    f[3] * d[0] + f[4] * d[1] + f[5] * d[2],
    f[6] * d[0] + f[7] * d[1] + f[8] * d[2],
  ];
}
const GRIP_R = grip(bind(S.handR));
const GRIP_L = grip(bind(S.handL));
/**
 * Where the hands hold the rifle when it is shouldered (offsets from the butt in the rifle's own frame, as the grips above): the right hand on
 * the pistol grip, the left a hand's breadth further back on the handguard than at the low ready, which a short arm can reach from the shoulder.
 */
const GRIP_AIM_R: V = [0, -0.04, 0.27];
const GRIP_AIM_L: V = [0, -0.035, 0.4];

/** The grip a hand takes for `aim` (0 low ready .. 1 shouldered), written to `out`. */
function gripFor(low: V, shouldered: V, aim: number, out: V): V {
  out[0] = low[0] + (shouldered[0] - low[0]) * aim;
  out[1] = low[1] + (shouldered[1] - low[1]) * aim;
  out[2] = low[2] + (shouldered[2] - low[2]) * aim;
  return out;
}
const gripScratch: V = [0, 0, 0];

// ---- small maths on scratch arrays (a pose makes no objects) ----

const frameScratch = new Float64Array(9);
const t0 = new Float64Array(3);
const t1 = new Float64Array(3);
const mid = new Float64Array(3);
const end = new Float64Array(3);

/** (x, y, z) turned by Rz(roll), then Rx(pitch), then Ry(twist), written to `out`. */
function turn(out: Float64Array, x: number, y: number, z: number, roll: number, pitch: number, twist: number): void {
  const cz = Math.cos(roll);
  const sz = Math.sin(roll);
  let x1 = x * cz - y * sz;
  let y1 = x * sz + y * cz;
  let z1 = z;
  const cx = Math.cos(pitch);
  const sx = Math.sin(pitch);
  const y2 = y1 * cx - z1 * sx;
  const z2 = y1 * sx + z1 * cx;
  y1 = y2;
  z1 = z2;
  const cy = Math.cos(twist);
  const sy = Math.sin(twist);
  const x3 = x1 * cy + z1 * sy;
  const z3 = -x1 * sy + z1 * cy;
  x1 = x3;
  out[0] = x1;
  out[1] = y1;
  out[2] = z3;
}

/**
 * Two-bone solve: root at (rx, ry, rz), wanted end at (tx, ty, tz), bones `l1` then `l2`, the middle joint toward `pole` (a direction). Writes the
 * middle joint to `mid` and the end that is actually reached (the wanted one, or the farthest the arm or leg can stretch toward it) to `end`.
 */
function solveTwoBone(rx: number, ry: number, rz: number, tx: number, ty: number, tz: number, l1: number, l2: number, px: number, py: number, pz: number): void {
  let dx = tx - rx;
  let dy = ty - ry;
  let dz = tz - rz;
  let d = Math.hypot(dx, dy, dz);
  if (d < 1e-6) {
    dx = 0;
    dy = -1;
    dz = 0;
    d = 1e-6;
  } else {
    dx /= d;
    dy /= d;
    dz /= d;
  }
  const reach = Math.min(d, l1 + l2 - 1e-4);
  const lowest = Math.abs(l1 - l2) + 1e-4;
  const r = Math.max(reach, lowest);
  // The middle joint is `a` along the line and `h` off it, toward the pole.
  const a = (l1 * l1 - l2 * l2 + r * r) / (2 * r);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const dot = px * dx + py * dy + pz * dz;
  let qx = px - dot * dx;
  let qy = py - dot * dy;
  let qz = pz - dot * dz;
  const ql = Math.hypot(qx, qy, qz);
  if (ql < 1e-6) {
    // The pole lies along the line (a straight-down leg with the pole down): any sideways direction will do.
    qx = 1;
    qy = 0;
    qz = 0;
  } else {
    qx /= ql;
    qy /= ql;
    qz /= ql;
  }
  mid[0] = rx + dx * a + qx * h;
  mid[1] = ry + dy * a + qy * h;
  mid[2] = rz + dz * a + qz * h;
  end[0] = rx + dx * r;
  end[1] = ry + dy * r;
  end[2] = rz + dz * r;
}

function put(out: Float64Array, joint: number, x: number, y: number, z: number): void {
  out[joint * 3] = x;
  out[joint * 3 + 1] = y;
  out[joint * 3 + 2] = z;
}

/**
 * Write the pose `p` into `out` (`JOINT_FLOATS` numbers). Every rigid block keeps its bind shape, every limb its bind lengths; a foot or
 * hand target out of reach is met as far as the limb stretches (so a pose that asks too much never tears the skin, it only lets the foot float).
 */
export function poseJoints(out: Float64Array, p: PoseParams): void {
  const px = p.pelvisX;
  const py = p.pelvisY;
  const pz = p.pelvisZ;
  put(out, S.pelvis, px, py, pz);

  // Hips: the pelvis block, tilted about the front axis.
  for (const [joint, side] of [[S.hipL, 1], [S.hipR, -1]] as const) {
    const b = bind(joint);
    turn(t0, b[0] - PELVIS[0], b[1] - PELVIS[1], b[2] - PELVIS[2], p.pelvisRoll, 0, 0);
    put(out, joint, px + t0[0], py + t0[1], pz + t0[2]);
    void side;
  }

  // The chest block turns about the pelvis: roll, then lean, then twist.
  const rise = p.breath;
  for (const joint of [S.chest, S.neck, S.shL, S.shR]) {
    const b = bind(joint);
    turn(t0, b[0] - PELVIS[0], b[1] - PELVIS[1], b[2] - PELVIS[2], p.roll, p.pitch, p.twist);
    put(out, joint, px + t0[0], py + t0[1] + rise, pz + t0[2]);
  }
  // The head hangs on the neck and nods about it.
  {
    const b = bind(S.head);
    const nx = out[S.neck * 3];
    const ny = out[S.neck * 3 + 1];
    const nz = out[S.neck * 3 + 2];
    const ox = b[0] - NECK[0];
    const oy = b[1] - NECK[1];
    const oz = b[2] - NECK[2];
    // nod about the chest's X axis first, then the torso's own turn
    const cn = Math.cos(p.headPitch);
    const sn = Math.sin(p.headPitch);
    turn(t0, ox, oy * cn - oz * sn, oy * sn + oz * cn, p.roll, p.pitch, p.twist);
    put(out, S.head, nx + t0[0], ny + t0[1], nz + t0[2]);
  }

  // The rifle: low ready across the body, or shouldered; the blend is of positions and directions of the rifle as a whole.
  const aim = Math.min(1, Math.max(0, p.aim));
  const bb = bind(S.butt);
  turn(t0, bb[0] - PELVIS[0], bb[1] - PELVIS[1], bb[2] - PELVIS[2], p.roll, p.pitch, p.twist);
  let lowBx = px + t0[0];
  let lowBy = py + t0[1] + rise;
  let lowBz = pz + t0[2];
  turn(t1, LOW_DIR[0], LOW_DIR[1], LOW_DIR[2], p.roll, p.pitch, p.twist);
  const lowDx = t1[0];
  const lowDy = t1[1];
  const lowDz = t1[2];
  // Aimed: level, along the chest's facing, pitched, kicked up a little by the recoil.
  const elev = p.aimPitch + 0.05 * p.recoil;
  turn(t1, 0, Math.sin(elev), Math.cos(elev), 0, 0, p.twist);
  const aimDx = t1[0];
  const aimDy = t1[1];
  const aimDz = t1[2];
  turn(t0, AIM_BUTT[0] - PELVIS[0], AIM_BUTT[1] - PELVIS[1], AIM_BUTT[2] - PELVIS[2], p.roll, p.pitch, p.twist);
  const kick = 0.05 * p.recoil;
  const aimBx = px + t0[0] - aimDx * kick;
  const aimBy = py + t0[1] + rise - aimDy * kick;
  const aimBz = pz + t0[2] - aimDz * kick;
  const bx = lowBx + (aimBx - lowBx) * aim;
  const by = lowBy + (aimBy - lowBy) * aim;
  const bz = lowBz + (aimBz - lowBz) * aim;
  lowBx = lowDx + (aimDx - lowDx) * aim;
  lowBy = lowDy + (aimDy - lowDy) * aim;
  lowBz = lowDz + (aimDz - lowDz) * aim;
  const dl = Math.hypot(lowBx, lowBy, lowBz) || 1;
  const dir: V = [lowBx / dl, lowBy / dl, lowBz / dl];
  put(out, S.butt, bx, by, bz);
  put(out, S.muzzle, bx + dir[0] * RIFLE_LENGTH, by + dir[1] * RIFLE_LENGTH, bz + dir[2] * RIFLE_LENGTH);

  // Arms: the hands go where the rifle's grips are; the elbows fall down and out.
  rifleFrame(dir, frameScratch);
  const f = frameScratch;
  const gripAt = (g: V, o: Float64Array): void => {
    o[0] = bx + f[0] * g[0] + f[3] * g[1] + f[6] * g[2];
    o[1] = by + f[1] * g[0] + f[4] * g[1] + f[7] * g[2];
    o[2] = bz + f[2] * g[0] + f[5] * g[1] + f[8] * g[2];
  };
  const hand = new Float64Array(3);
  const behind = Math.min(1, Math.max(0, p.behind ?? 0));
  for (const [sh, elbow, hd, low, shouldered, arm, side] of [
    [S.shR, S.elbR, S.handR, GRIP_R, GRIP_AIM_R, ARM_R, -1],
    [S.shL, S.elbL, S.handL, GRIP_L, GRIP_AIM_L, ARM_L, 1],
  ] as const) {
    gripAt(gripFor(low, shouldered, aim, gripScratch), hand);
    if (behind > 0) {
      // Hands off the grips to the small of the back, turning with the torso; the elbows go out and back.
      const at = side < 0 ? BEHIND_R : BEHIND_L;
      turn(behindScratch, at[0] - PELVIS[0], at[1] - PELVIS[1], at[2] - PELVIS[2], p.roll, p.pitch, p.twist);
      hand[0] += (px + behindScratch[0] - hand[0]) * behind;
      hand[1] += (py + behindScratch[1] + rise - hand[1]) * behind;
      hand[2] += (pz + behindScratch[2] - hand[2]) * behind;
    }
    turn(t1, side * (0.6 + 0.4 * behind), -1, -0.25 - 0.6 * behind, p.roll, p.pitch, p.twist);
    solveTwoBone(out[sh * 3], out[sh * 3 + 1], out[sh * 3 + 2], hand[0], hand[1], hand[2], arm[0], arm[1], t1[0], t1[1], t1[2]);
    put(out, elbow, mid[0], mid[1], mid[2]);
    put(out, hd, end[0], end[1], end[2]);
  }

  // Legs: the feet go where the targets are; the knees point forward.
  for (const [hip, knee, foot, leg, target] of [
    [S.hipL, S.kneeL, S.footL, LEG_L, p.footL],
    [S.hipR, S.kneeR, S.footR, LEG_R, p.footR],
  ] as const) {
    solveTwoBone(out[hip * 3], out[hip * 3 + 1], out[hip * 3 + 2], target[0], target[1], target[2], leg[0], leg[1], 0, 0.15, 1);
    put(out, knee, mid[0], mid[1], mid[2]);
    put(out, foot, end[0], end[1], end[2]);
  }
}

/** Where the rifle's two grips are for the joints `j` at `aim` (the hand joints should sit on them): for the tests. */
export function gripPoints(j: ArrayLike<number>, aim = 0): { right: V; left: V } {
  const b = [j[S.butt * 3], j[S.butt * 3 + 1], j[S.butt * 3 + 2]] as const;
  const d: V = [j[S.muzzle * 3] - b[0], j[S.muzzle * 3 + 1] - b[1], j[S.muzzle * 3 + 2] - b[2]];
  const f = new Float64Array(9);
  rifleFrame(d, f);
  const at = (g: V): V => [
    b[0] + f[0] * g[0] + f[3] * g[1] + f[6] * g[2],
    b[1] + f[1] * g[0] + f[4] * g[1] + f[7] * g[2],
    b[2] + f[2] * g[0] + f[5] * g[1] + f[8] * g[2],
  ];
  return { right: at(gripFor(GRIP_R, GRIP_AIM_R, aim, [0, 0, 0])), left: at(gripFor(GRIP_L, GRIP_AIM_L, aim, [0, 0, 0])) };
}

/** Rifle butt (m) of the shouldered rifle in the chest's bind frame, and the rifle's low-ready direction: exported for the tests' and the tuning's sake. */
export const RIFLE_POSE = { aimButt: AIM_BUTT, lowButt: SOLDIER_RIFLE_BUTT, lowDir: SOLDIER_RIFLE_DIR } as const;
