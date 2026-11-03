import { link } from '../game/ragdoll';
import type { Ragdoll, RigBone, RigConstraint, RigParticle, RigSpec } from '../game/ragdoll';
import { pushDirection } from './soldierRig';
import type { FallHit } from './soldierRig';

// The prone sniper's ragdoll: a lighter cousin of the soldier's (mission/soldierRig.ts). He lies flat, head toward the shooter, so there is no
// standing to lose and nothing to buckle; what is left when he is hit is a slump: the head drops onto the ground, the arms go limp and slide
// off the rifle, the body rolls a little with the bullet. Twelve joints, one bone per limb.

/** Particle indices, in the order of `SNIPER_RIG.particles`. */
export const K = {
  head: 0,
  neck: 1,
  chest: 2,
  shL: 3,
  shR: 4,
  pelvis: 5,
  hipL: 6,
  hipR: 7,
  handL: 8,
  handR: 9,
  footL: 10,
  footR: 11,
} as const;

/** The bones, in the order of `SNIPER_RIG.bones`; the model's parts name them (`SNIPER_PART_BONES` in sniperModel.ts). */
export const SNIPER_BONES = ['pelvis', 'chest', 'head', 'armL', 'armR', 'legL', 'legR'] as const;

function build(): RigSpec {
  const p: RigParticle[] = [];
  const set = (i: number, at: readonly [number, number, number], radius: number, mass: number): void => {
    p[i] = { p: at, radius, mass };
  };
  // Lying: the radius is how high the joint rests above the ground (the thickness of the body there).
  set(K.head, [0, 0.37, 0.13], 0.12, 1.5);
  set(K.neck, [0, 0.27, -0.06], 0.09, 0.8);
  set(K.chest, [0, 0.23, -0.4], 0.17, 5);
  set(K.shL, [0.2, 0.2, -0.25], 0.08, 1.5);
  set(K.shR, [-0.2, 0.2, -0.25], 0.08, 1.5);
  set(K.pelvis, [0, 0.2, -0.78], 0.14, 5);
  set(K.hipL, [0.12, 0.17, -0.9], 0.1, 1.5);
  set(K.hipR, [-0.12, 0.17, -0.9], 0.1, 1.5);
  set(K.handL, [0.25, 0.16, 0.22], 0.06, 0.5);
  set(K.handR, [-0.25, 0.16, 0.22], 0.06, 0.5);
  set(K.footL, [0.15, 0.1, -1.55], 0.08, 0.8);
  set(K.footR, [-0.15, 0.1, -1.55], 0.08, 0.8);
  const L = (a: number, b: number, lo = 1, hi = 1): RigConstraint => link(p, a, b, lo, hi);
  const constraints: RigConstraint[] = [
    L(K.head, K.neck),
    L(K.neck, K.shL), L(K.neck, K.shR), L(K.shL, K.shR), L(K.neck, K.chest), L(K.chest, K.shL), L(K.chest, K.shR),
    L(K.pelvis, K.hipL), L(K.pelvis, K.hipR), L(K.hipL, K.hipR),
    L(K.shL, K.handL), L(K.shR, K.handR),
    L(K.hipL, K.footL), L(K.hipR, K.footR),
    // The spine: a little give, so he can twist and roll at the waist.
    L(K.chest, K.pelvis, 0.9, 1.08), L(K.neck, K.pelvis, 0.92, 1.05),
    L(K.shL, K.hipL, 0.9, 1.1), L(K.shR, K.hipR, 0.9, 1.1), L(K.shL, K.hipR, 0.9, 1.1), L(K.shR, K.hipL, 0.9, 1.1),
    L(K.chest, K.hipL, 0.9, 1.1), L(K.chest, K.hipR, 0.9, 1.1),
    // The head may drop and loll but not leave his shoulders.
    L(K.head, K.chest, 0.8, 1.1), L(K.head, K.shL, 0.85, 1.12), L(K.head, K.shR, 0.85, 1.12),
  ];
  const bone = (origin: number, dirFrom: number, dirTo: number, sideFrom: number, sideTo: number): RigBone => ({ origin, dirFrom, dirTo, sideFrom, sideTo });
  // Order of SNIPER_BONES.
  const bones: RigBone[] = [
    bone(K.pelvis, K.hipR, K.hipL, K.pelvis, K.chest),
    bone(K.chest, K.shR, K.shL, K.chest, K.neck),
    bone(K.neck, K.neck, K.head, K.shR, K.shL),
    bone(K.shL, K.shL, K.handL, K.shR, K.shL),
    bone(K.shR, K.shR, K.handR, K.shR, K.shL),
    bone(K.hipL, K.hipL, K.footL, K.hipR, K.hipL),
    bone(K.hipR, K.hipR, K.footR, K.hipR, K.hipL),
  ];
  return { particles: p, constraints, hinges: [], bones };
}

/** The sniper's rig. */
export const SNIPER_RIG: RigSpec = build();

/**
 * The velocities of a prone sniper going limp: the head drops, the arms fall away from the rifle, and the bullet rolls him a little (the
 * shoulder it struck on goes up and over, the body twists with it). A head shot snaps the head back and down; the rest slumps.
 */
export function sniperFall(rag: Ragdoll, hit: FallHit | undefined, rng: () => number): void {
  const zone = hit?.zone ?? 'upperTorso';
  const d = pushDirection(hit?.velocity, [0, 0, -1]);
  const point: readonly [number, number, number] = hit?.point ?? [0, 0.25, -0.3];
  const jitter = (amount: number): number => 1 + (rng() * 2 - 1) * amount;
  const roll = (point[0] !== 0 ? Math.sign(point[0]) : rng() < 0.5 ? -1 : 1) * jitter(0.3);

  // The strings are cut: the head and arms fall, the hips settle.
  rag.kick(K.head, 0, -1.5, 0);
  rag.kick(K.neck, 0, -0.5, 0);
  rag.kick(K.handL, 0.55, -1, 0);
  rag.kick(K.handR, -0.55, -1, 0);
  rag.kick(K.footL, 0.25, 0, 0);
  rag.kick(K.footR, -0.25, 0, 0);

  const speed = zone === 'head' ? 2.2 : 1.6;
  rag.kickAt(point, d, speed * jitter(0.25), zone === 'head' ? 0.22 : 0.4);
  // The roll: the near shoulder is shoved up and across, the far one pulled down; the hips follow a little.
  rag.kick(K.shL, 0.5 * roll, 0.9 * roll, 0);
  rag.kick(K.shR, 0.5 * roll, -0.9 * roll, 0);
  rag.kick(K.chest, 0.6 * roll, 0, 0);
  rag.kick(K.hipL, 0.3 * roll, 0.4 * roll, 0);
  rag.kick(K.hipR, 0.3 * roll, -0.4 * roll, 0);
  // Chance: the arms and legs fall a little differently each time.
  for (const i of [K.handL, K.handR, K.footL, K.footR]) rag.kick(i, (rng() * 2 - 1) * 0.3, 0, (rng() * 2 - 1) * 0.3);
}
