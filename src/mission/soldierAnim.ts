import { createRng } from './random';
import type { Rng } from './random';
import { JOINT_FLOATS, poseJoints, standingPose } from './soldierPose';
import type { PoseParams } from './soldierPose';

// How a soldier moves: the procedural animation of one soldier, on top of the pose maths of soldierPose.ts. Pure (no three.js, no clock of its
// own, its only randomness a seeded rng). The brain (game/squad.ts) says WHAT he is doing, as an `AnimIntent`: how fast he moves and in which
// style, which stance he holds when he stands, whether the rifle is at his shoulder, where he aims. This turns it into the numbers of a pose,
// every frame, and every number chases its target with a time constant of about a tenth of a second, so changing from a sprint to a crouch,
// or from the crouch to a kneeling shot, is a blend of a quarter second and never a jump.
//
// The gait is tied to the DISTANCE he covers, not to the clock (a stride is a length of ground), so a foot on the ground is carried back
// exactly as fast as he moves forward and does not skate.

/** How he moves when he moves: a sprint (upright, long strides, port arms) or a crouch-run (low, short strides, the rifle up). */
export type Gait = 'none' | 'sprint' | 'crouchRun';
/** How he holds himself when he stands still. */
export type Stance = 'stand' | 'crouch' | 'kneel';

/** What the brain wants of the body this frame. */
export interface AnimIntent {
  /** Ground speed, m/s. */
  speed: number;
  gait: Gait;
  stance: Stance;
  /** The rifle is at his shoulder. */
  aim: boolean;
  /** How fast his heading changes, rad/s (positive: toward his left); he leans into the turn. */
  turnRate: number;
  /** Where the target is, relative to the way his body faces: yaw (positive: toward his left) and pitch, rad. */
  aimYaw: number;
  aimPitch: number;
}

/** Ground height at a point of the body's frame (x to his left, z in front), relative to the ground at his feet, m. */
export type GroundProbe = (x: number, z: number) => number;

/** One posture: where the pelvis rides, how far the torso leans, and where the feet stand when he is still. */
interface Posture {
  pelvisY: number;
  pitch: number;
  footL: readonly [number, number, number];
  footR: readonly [number, number, number];
}

/** The ankle joint's height above the sole, m (the rig's, 0.16). */
const ANKLE_Y = 0.16;

const STANCES: Record<Stance, Posture> = {
  stand: { pelvisY: 0.99, pitch: 0.02, footL: [0.1, ANKLE_Y, 0.04], footR: [-0.1, ANKLE_Y, -0.01] },
  // A deep crouch, head about 1.1 m up: behind a wall of 1.2 m he is not to be seen.
  crouch: { pelvisY: 0.52, pitch: 0.62, footL: [0.19, ANKLE_Y, 0.14], footR: [-0.19, ANKLE_Y, -0.1] },
  // On the right knee: the left foot far forward, the right shin along the ground.
  kneel: { pelvisY: 0.6, pitch: 0.1, footL: [0.17, ANKLE_Y, 0.42], footR: [-0.12, 0.18, -0.34] },
};

/** The two ways to move: pelvis height and lean, how much of a stride the foot is on the ground, how high the heel kicks, how wide the feet, how much the pelvis bobs. */
const GAITS = {
  sprint: { pelvisY: 0.88, pitch: 0.25, duty: 0.3, lift: 0.26, width: 0.1, bob: 0.032, cycleBase: 0.4, cycleRate: 0.49 },
  crouchRun: { pelvisY: 0.7, pitch: 0.5, duty: 0.5, lift: 0.1, width: 0.13, bob: 0.02, cycleBase: 0.5, cycleRate: 0.45 },
} as const;

/** Time constants, s: posture (height, lean, feet), the rifle coming up or down, the blend into and out of the gait. */
const POSTURE_TAU = 0.13;
const AIM_TAU = 0.1;
const GAIT_RAMP_S = 0.12;
const LOOK_TAU = 0.22;
/** The recoil of a round dies away with this time constant, s. */
const RECOIL_TAU = 0.07;
/** A soldier is "moving" above this speed, m/s. */
const MOVING_MPS = 0.35;
/** He leans into a turn by this much per rad/s, capped. */
const BANK_PER_RADPS = 0.05;
const BANK_MAX = 0.2;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
/** Move `value` toward `target` by the fraction a time constant `tau` allows in `dt` seconds. */
const chase = (value: number, target: number, dt: number, tau: number): number => value + (target - value) * (1 - Math.exp(-dt / tau));
const fract = (v: number): number => v - Math.floor(v);

/** Stride of a gait at a speed: the ground one full cycle (two steps) covers, m. */
export function cycleLength(gait: 'sprint' | 'crouchRun', speed: number): number {
  const g = GAITS[gait];
  return g.cycleBase + g.cycleRate * Math.max(0, speed);
}

export class SoldierAnimator {
  /** The joints of the current pose, in the body's frame (see soldierPose.ts). */
  readonly joints = new Float64Array(JOINT_FLOATS);
  /** The joints of the frame before, and the seconds between them: what the fall needs to carry a run into it. */
  private readonly before = new Float64Array(JOINT_FLOATS);
  private stepS = 0;
  /** Extra turn of the head about the vertical on top of what the chest gives it, rad. */
  headYaw = 0;
  private readonly p: PoseParams = standingPose();
  private readonly rng: Rng;
  private time = 0;
  /** Where in a two-step cycle he is, 0..1. */
  private phase = 0;
  /** 0..1: how far into the gait the feet are (the blend between planted and striding). */
  private run = 0;
  private aim = 0;
  private recoil = 0;
  private bank = 0;
  private gait: 'sprint' | 'crouchRun' = 'sprint';
  // Where the head looks when he idles, and when it changes his mind.
  private look = 0;
  private lookTarget = 0;
  private lookIn: number;
  private readonly breathPhase: number;
  private readonly shiftPhase: number;
  // The static feet (the stance's), chasing their stance.
  private readonly footL: [number, number, number] = [...STANCES.stand.footL];
  private readonly footR: [number, number, number] = [...STANCES.stand.footR];
  private pelvisBase = STANCES.stand.pelvisY;
  private pitchBase = STANCES.stand.pitch;

  constructor(seed: number) {
    this.rng = createRng(seed);
    this.breathPhase = this.rng() * 6.28;
    this.shiftPhase = this.rng() * 6.28;
    this.lookIn = 0.5 + this.rng() * 2;
    this.phase = this.rng();
    this.pose(); // standing, from the first frame
    this.before.set(this.joints);
  }

  /** A round leaves the rifle: the rifle kicks back and the muzzle climbs, for a moment. */
  kick(): void {
    this.recoil = 1;
  }

  /** The speed, m/s, of joint `i` along each axis in the frame of the body, from the last two frames: written to `out` (3 per joint). */
  velocities(out: Float64Array): void {
    const inv = this.stepS > 1e-6 ? 1 / this.stepS : 0;
    for (let i = 0; i < JOINT_FLOATS; i++) out[i] = (this.joints[i] - this.before[i]) * inv;
  }

  /** Advance by `dt` seconds toward what `intent` asks; `ground` (optional) lifts or lowers each foot to the terrain under it. */
  update(dt: number, intent: AnimIntent, ground?: GroundProbe): void {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    this.before.set(this.joints);
    this.stepS = dt;
    this.time += dt;
    const p = this.p;
    const moving = intent.gait !== 'none' && intent.speed > MOVING_MPS;
    if (moving && intent.gait !== 'none') this.gait = intent.gait;
    const g = GAITS[this.gait];

    // The blend into and out of the gait, and the stride, which follows the ground covered.
    this.run = clamp(this.run + (moving ? dt : -dt) / GAIT_RAMP_S, 0, 1);
    if (moving) this.phase = fract(this.phase + (intent.speed * dt) / cycleLength(this.gait, intent.speed));
    const run = this.run;

    // The posture he is heading for: his gait's while moving, his stance's while still. Both feet and height chase it.
    const stance = STANCES[intent.stance];
    const postureY = moving ? g.pelvisY : stance.pelvisY;
    const posturePitch = moving ? g.pitch + (this.gait === 'sprint' ? Math.min(0.06, intent.speed * 0.012) : 0) : stance.pitch;
    this.pelvisBase = chase(this.pelvisBase, postureY, dt, POSTURE_TAU);
    this.pitchBase = chase(this.pitchBase, posturePitch, dt, POSTURE_TAU);
    for (let k = 0; k < 3; k++) {
      this.footL[k] = chase(this.footL[k], stance.footL[k], dt, POSTURE_TAU);
      this.footR[k] = chase(this.footR[k], stance.footR[k], dt, POSTURE_TAU);
    }

    // The rifle comes up to the shoulder and down again; the torso turns toward what he aims at.
    this.aim = chase(this.aim, intent.aim ? 1 : 0, dt, AIM_TAU);
    this.recoil *= Math.exp(-dt / RECOIL_TAU);
    const aimYaw = clamp(intent.aimYaw, -0.9, 0.9);

    // Idle life: a breath, a shift of weight, a look around (only while the head is free: not while aiming or running).
    const calm = (1 - run) * (1 - this.aim);
    const still = 1 - run;
    this.lookIn -= dt;
    if (this.lookIn <= 0) {
      this.lookIn = 1.5 + this.rng() * 3;
      this.lookTarget = (this.rng() * 2 - 1) * (intent.stance === 'stand' ? 0.7 : 0.9);
    }
    const lookWanted = this.aim > 0.5 ? aimYaw : run > 0.5 ? 0 : this.lookTarget;
    this.look = chase(this.look, lookWanted, dt, LOOK_TAU);
    const breath = Math.sin(this.time * 1.7 + this.breathPhase);
    const shift = Math.sin(this.time * 0.7 + this.shiftPhase);

    // The gait's own motion.
    const turn = clamp(-intent.turnRate * BANK_PER_RADPS, -BANK_MAX, BANK_MAX);
    this.bank = chase(this.bank, turn * run, dt, 0.12);
    const cyc = this.phase * 2 * Math.PI;
    const bob = g.bob * (0.5 + 0.5 * Math.cos(2 * cyc - g.duty * 2 * Math.PI)) * run;

    p.pelvisY = this.pelvisBase - bob;
    p.pelvisX = 0.012 * Math.sin(cyc) * run + 0.012 * shift * still * (intent.stance === 'stand' ? 1 : 0.4);
    p.pelvisZ = 0;
    p.pelvisRoll = 0.03 * Math.cos(cyc) * run + 0.012 * shift * still;
    p.pitch = this.pitchBase - 0.03 * this.recoil + 0.004 * breath * still;
    p.twist = 0.08 * Math.sin(cyc + 0.6) * run + aimYaw * this.aim;
    p.roll = this.bank + 0.01 * shift * calm;
    p.breath = 0.005 * breath * (1 - 0.6 * run);
    p.headPitch = 0.03 * breath * calm + 0.08 * this.recoil - 0.1 * this.aim - 0.06 * run;
    p.aim = this.aim;
    p.aimPitch = clamp(intent.aimPitch, -0.5, 0.5);
    p.recoil = this.recoil;
    this.headYaw = this.look - p.twist;

    // Feet: planted at the stance's spot, or striding; a foot on higher ground rides higher, and the pelvis drops with the lower one.
    this.speed = Math.max(0, intent.speed);
    this.dy[0] = this.foot(p.footL, this.footL, true, run, g, ground);
    this.dy[1] = this.foot(p.footR, this.footR, false, run, g, ground);
    p.pelvisY += Math.min(0, this.dy[0], this.dy[1]);

    this.pose();
  }

  /** Ground height under each foot relative to the ground at the body's origin (left, right), m. */
  private readonly dy: [number, number] = [0, 0];
  /** Ground speed of the frame being built, m/s. */
  private speed = 0;

  /**
   * One foot: the stance's spot blended with the stride's, then set on the ground under it. Returns the ground height under it (relative to the
   * ground at his feet).
   */
  private foot(out: [number, number, number], planted: readonly [number, number, number], left: boolean, run: number, g: (typeof GAITS)[keyof typeof GAITS], ground?: GroundProbe): number {
    const u = fract(this.phase + (left ? 0 : 0.5));
    const half = (g.duty * cycleLength(this.gait, this.speed)) / 2;
    let z: number;
    let lift = 0;
    if (u < g.duty) {
      z = 0.05 + half * (1 - (2 * u) / g.duty); // on the ground: carried from in front of the hips to behind them
    } else {
      const w = (u - g.duty) / (1 - g.duty);
      const e = w * w * (3 - 2 * w);
      z = 0.05 - half + 2 * half * e; // in the air: swung forward again
      lift = g.lift * Math.sin(Math.PI * w);
    }
    const x = (left ? 1 : -1) * g.width;
    const tx = planted[0] + (x - planted[0]) * run;
    const tz = planted[2] + (z - planted[2]) * run;
    const dy = ground ? ground(tx, tz) : 0;
    out[0] = tx;
    out[1] = planted[1] + lift * run + dy;
    out[2] = tz;
    return dy;
  }

  private pose(): void {
    poseJoints(this.joints, this.p);
  }
}
