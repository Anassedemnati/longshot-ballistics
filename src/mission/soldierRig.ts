import { keepApart, link, rope } from '../game/ragdoll';
import type { Ragdoll, RigBone, RigConstraint, RigHinge, RigParticle, RigSpec } from '../game/ragdoll';
import type { ZoneName } from '../game/hit';
import { SOLDIER_JOINTS as J, SOLDIER_RIFLE_BUTT, SOLDIER_RIFLE_DIR } from './soldierModel';

// The standing soldier's ragdoll: eighteen joints (head, neck, chest, shoulders, pelvis, hips, elbows, hands, knees, ankles and the two
// ends of the rifle), the bones between them, the links that keep the torso stiff and the limits that keep knees and elbows bending
// the way they do. Pure data: game/ragdoll.ts simulates it, scene/ragdollBody.ts skins the soldier's mesh with it.

/** Particle indices, in the order of `SOLDIER_RIG.particles`. */
export const S = {
  head: 0,
  neck: 1,
  chest: 2,
  shL: 3,
  shR: 4,
  pelvis: 5,
  hipL: 6,
  hipR: 7,
  elbL: 8,
  elbR: 9,
  handL: 10,
  handR: 11,
  kneeL: 12,
  kneeR: 13,
  footL: 14,
  footR: 15,
  butt: 16,
  muzzle: 17,
} as const;

/** The bones, in the order of `SOLDIER_RIG.bones`; the model's parts name them (`skin` in soldierModel.ts). */
export const SOLDIER_BONES = ['pelvis', 'chest', 'head', 'upperArmL', 'upperArmR', 'foreArmL', 'foreArmR', 'thighL', 'thighR', 'shinL', 'shinR', 'rifle'] as const;

const RIFLE_LENGTH = 1;

function particles(): RigParticle[] {
  const knee = (side: -1 | 1) => J.knee(side);
  const ankle = (side: -1 | 1) => J.ankle(side);
  const out: RigParticle[] = [];
  // The chest joint sits a little behind the spine's line: the pack hangs 0.27 m behind it, the plate 0.15 m in front, so a radius of 0.2 rests either side on the ground.
  const set = (i: number, p: readonly [number, number, number], radius: number, mass: number): void => {
    out[i] = { p, radius, mass };
  };
  set(S.head, [0, 1.66, 0.01], 0.11, 1.5);
  set(S.neck, [0, 1.52, 0], 0.05, 0.5);
  set(S.chest, [0, 1.36, -0.065], 0.2, 5);
  set(S.shL, [J.shoulderX, J.shoulderY, 0], 0.075, 1.5);
  set(S.shR, [-J.shoulderX, J.shoulderY, 0], 0.075, 1.5);
  set(S.pelvis, [0, 0.99, 0], 0.13, 5);
  set(S.hipL, [J.hipX, J.hipY, 0], 0.09, 1.5);
  set(S.hipR, [-J.hipX, J.hipY, 0], 0.09, 1.5);
  set(S.elbL, J.leftElbow, 0.065, 0.5);
  set(S.elbR, J.rightElbow, 0.065, 0.5);
  set(S.handL, J.leftHand, 0.055, 0.4);
  set(S.handR, J.rightHand, 0.055, 0.4);
  set(S.kneeL, knee(1), 0.085, 1.2);
  set(S.kneeR, knee(-1), 0.085, 1.2);
  set(S.footL, ankle(1), 0.085, 0.8);
  set(S.footR, ankle(-1), 0.085, 0.8);
  set(S.butt, SOLDIER_RIFLE_BUTT, 0.04, 0.4);
  set(S.muzzle, [
    SOLDIER_RIFLE_BUTT[0] + SOLDIER_RIFLE_DIR[0] * RIFLE_LENGTH,
    SOLDIER_RIFLE_BUTT[1] + SOLDIER_RIFLE_DIR[1] * RIFLE_LENGTH,
    SOLDIER_RIFLE_BUTT[2] + SOLDIER_RIFLE_DIR[2] * RIFLE_LENGTH,
  ], 0.04, 0.4);
  return out;
}

function build(): RigSpec {
  const p = particles();
  const L = (a: number, b: number, lo = 1, hi = 1): RigConstraint => link(p, a, b, lo, hi);
  const constraints: RigConstraint[] = [
    // The chest block (neck, shoulders, chest) and the pelvis block (pelvis, hips) are rigid; the head hangs on the neck.
    L(S.head, S.neck),
    L(S.neck, S.shL), L(S.neck, S.shR), L(S.shL, S.shR), L(S.neck, S.chest), L(S.chest, S.shL), L(S.chest, S.shR),
    L(S.pelvis, S.hipL), L(S.pelvis, S.hipR), L(S.hipL, S.hipR),
    // The arms and legs: a bone is a rigid distance.
    L(S.shL, S.elbL), L(S.elbL, S.handL), L(S.shR, S.elbR), L(S.elbR, S.handR),
    L(S.hipL, S.kneeL), L(S.kneeL, S.footL), L(S.hipR, S.kneeR), L(S.kneeR, S.footR),
    L(S.butt, S.muzzle),
    // The spine: the two blocks stay together but may fold a little (a waist, not a hinge).
    L(S.chest, S.pelvis, 0.86, 1.06),
    L(S.neck, S.pelvis, 0.88, 1.05),
    L(S.shL, S.hipL, 0.86, 1.08), L(S.shR, S.hipR, 0.86, 1.08),
    L(S.shL, S.hipR, 0.86, 1.08), L(S.shR, S.hipL, 0.86, 1.08),
    L(S.chest, S.hipL, 0.86, 1.08), L(S.chest, S.hipR, 0.86, 1.08),
    // The neck bends only so far: the head neither dives into the chest nor hangs off the shoulders.
    L(S.head, S.chest, 0.82, 1.08),
    L(S.head, S.shL, 0.84, 1.1), L(S.head, S.shR, 0.84, 1.1),
    // Nothing folds through the body.
    keepApart(S.elbL, S.chest, 0.27), keepApart(S.elbR, S.chest, 0.27),
    keepApart(S.handL, S.pelvis, 0.14), keepApart(S.handR, S.pelvis, 0.14),
    keepApart(S.kneeL, S.pelvis, 0.33), keepApart(S.kneeR, S.pelvis, 0.33),
    keepApart(S.footL, S.pelvis, 0.3), keepApart(S.footR, S.pelvis, 0.3),
    keepApart(S.kneeL, S.kneeR, 0.1),
    // The rifle hangs from the hands on a sling's worth of slack.
    rope(p, S.handR, S.butt, 0.12), rope(p, S.handL, S.muzzle, 0.12),
  ];
  const hinge = (joint: number, a: number, c: number, side: 1 | -1): RigHinge => ({ joint, a, c, left: S.hipL, right: S.hipR, upFrom: S.pelvis, upTo: S.chest, side });
  const hinges: RigHinge[] = [
    hinge(S.kneeL, S.hipL, S.footL, 1), hinge(S.kneeR, S.hipR, S.footR, 1), // the knee stays in front of the hip-ankle line
    hinge(S.elbL, S.shL, S.handL, -1), hinge(S.elbR, S.shR, S.handR, -1), // the elbow behind the shoulder-hand line
  ];
  const bone = (origin: number, dirFrom: number, dirTo: number, sideFrom: number, sideTo: number): RigBone => ({ origin, dirFrom, dirTo, sideFrom, sideTo });
  // Order of SOLDIER_BONES.
  const bones: RigBone[] = [
    bone(S.pelvis, S.hipR, S.hipL, S.pelvis, S.chest),
    bone(S.chest, S.shR, S.shL, S.chest, S.neck),
    bone(S.neck, S.neck, S.head, S.shR, S.shL),
    bone(S.shL, S.shL, S.elbL, S.shR, S.shL),
    bone(S.shR, S.shR, S.elbR, S.shR, S.shL),
    bone(S.elbL, S.elbL, S.handL, S.shR, S.shL),
    bone(S.elbR, S.elbR, S.handR, S.shR, S.shL),
    bone(S.hipL, S.hipL, S.kneeL, S.hipR, S.hipL),
    bone(S.hipR, S.hipR, S.kneeR, S.hipR, S.hipL),
    bone(S.kneeL, S.kneeL, S.footL, S.hipR, S.hipL),
    bone(S.kneeR, S.kneeR, S.footR, S.hipR, S.hipL),
    bone(S.butt, S.butt, S.muzzle, -1, -1),
  ];
  return { particles: p, constraints, hinges, bones };
}

/** The soldier's rig. */
export const SOLDIER_RIG: RigSpec = build();

/** The bullet that brings a body down, in the body's own frame (+Z its front, feet at the origin). */
export interface FallHit {
  point: readonly [number, number, number];
  /** The bullet's velocity there, m/s (only its direction matters). */
  velocity: readonly [number, number, number];
  zone: ZoneName;
}

/** Unit vector along `v` with the vertical part limited (a shot from a hill must not drive the body into the ground), or `fallback` for the zero vector. */
export function pushDirection(v: readonly [number, number, number] | undefined, fallback: readonly [number, number, number]): [number, number, number] {
  if (!v) return [...fallback];
  const flat = Math.hypot(v[0], v[2]);
  if (flat < 1e-6) return [...fallback];
  const y = Math.max(-0.35 * flat, Math.min(0.35 * flat, v[1]));
  const l = Math.hypot(v[0], y, v[2]);
  return [v[0] / l, y / l, v[2] / l];
}

/**
 * Give a soldier standing at rest the velocities that bring him down. A bullet does not throw a man: it shoves the struck joint (more the
 * nearer), and the rest is a man whose legs have just stopped holding him up: the knees give, the hips drop, and he goes down the way the
 * hit sends him: a head shot drops him almost on the spot with the head snapped back, a chest hit staggers him back with a twist, a hit to the
 * belt folds him over it, a leg gives way and lets him fall on that side. A little chance in each (`rng`) so no two falls are alike.
 */
export function soldierFall(rag: Ragdoll, hit: FallHit | undefined, rng: () => number): void {
  const zone: ZoneName = hit?.zone ?? 'upperTorso';
  const d = pushDirection(hit?.velocity, [0, 0, -1]);
  const point: readonly [number, number, number] = hit?.point ?? [0, 1.36, 0.1];
  const side = point[0] >= 0 ? 1 : -1;
  const jitter = (amount: number): number => 1 + (rng() * 2 - 1) * amount;
  const wobble = (): number => (rng() * 2 - 1) * 0.35;
  const all = (vx: number, vy: number, vz: number, from = 0): void => {
    for (let i = from; i < S.butt; i++) rag.kick(i, vx, vy, vz);
  };

  // The strings are cut: knees buckle (forward: the shins fold back), the pelvis sags.
  rag.kick(S.kneeL, 0, -0.2, 0.7 * jitter(0.4));
  rag.kick(S.kneeR, 0, -0.2, 0.55 * jitter(0.4));
  rag.kick(S.pelvis, 0, -0.55, 0);
  rag.kick(S.hipL, 0, -0.4, 0);
  rag.kick(S.hipR, 0, -0.4, 0);

  switch (zone) {
    case 'head':
      // The head snaps back along the bullet; the body just folds under it.
      rag.kickAt(point, d, 2.4 * jitter(0.25), 0.22);
      all(d[0] * 0.15, -0.2, d[2] * 0.15);
      rag.kick(S.neck, d[0] * 0.5, 0, d[2] * 0.5);
      break;
    case 'lowerTorso':
      // Hit at the belt: the pelvis is shoved, the upper body folds forward over it.
      rag.kickAt(point, d, 1.9 * jitter(0.25), 0.3);
      for (const i of [S.chest, S.head, S.neck, S.shL, S.shR]) rag.kick(i, -d[0] * 0.5, -0.2, -d[2] * 0.5);
      rag.kick(S.kneeL, 0, 0, 0.5);
      rag.kick(S.kneeR, 0, 0, 0.5);
      break;
    case 'limbs':
      // A leg or an arm: he goes down on that side.
      rag.kickAt(point, d, 2.5 * jitter(0.25), 0.2);
      all(side * 0.55 * jitter(0.3), 0, d[2] * 0.25);
      rag.kick(side > 0 ? S.hipL : S.hipR, 0, -0.7, 0);
      rag.kick(side > 0 ? S.kneeL : S.kneeR, 0, -0.3, 0.7);
      rag.kick(side > 0 ? S.shL : S.shR, side * 0.4, 0, 0);
      break;
    default:
      // Chest: shoved back and twisted, the legs go from under him.
      rag.kickAt(point, d, 1.9 * jitter(0.25), 0.4);
      all(d[0] * 0.45, 0, d[2] * 0.45);
      rag.kick(S.shL, 0, 0, -d[2] * 0.5 * side * 0.4);
      rag.kick(S.shR, 0, 0, d[2] * 0.5 * side * 0.4);
      break;
  }
  // Chance: a flail of the arms and a sideways lurch.
  for (const i of [S.elbL, S.elbR, S.handL, S.handR]) rag.kick(i, wobble(), wobble() * 0.5, wobble());
  all(wobble() * 0.4, 0, 0);
}
