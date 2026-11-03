import { describe, expect, it } from 'vitest';
import { JOINT_FLOATS, gripPoints, poseJoints, standingPose } from '../../src/mission/soldierPose';
import type { PoseParams } from '../../src/mission/soldierPose';
import { S, SOLDIER_RIG } from '../../src/mission/soldierRig';

const bind = (i: number) => SOLDIER_RIG.particles[i].p;
const at = (j: Float64Array, i: number): [number, number, number] => [j[i * 3], j[i * 3 + 1], j[i * 3 + 2]];
const dist = (a: ArrayLike<number>, b: ArrayLike<number>): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** The rigid bones of the rig: pairs whose bind distance must never change. */
const BONES: Array<[number, number]> = [
  [S.head, S.neck], [S.neck, S.shL], [S.neck, S.shR], [S.shL, S.shR], [S.neck, S.chest],
  [S.pelvis, S.hipL], [S.pelvis, S.hipR], [S.hipL, S.hipR],
  [S.shL, S.elbL], [S.elbL, S.handL], [S.shR, S.elbR], [S.elbR, S.handR],
  [S.hipL, S.kneeL], [S.kneeL, S.footL], [S.hipR, S.kneeR], [S.kneeR, S.footR],
  [S.butt, S.muzzle],
];

function pose(change: Partial<PoseParams>): Float64Array {
  const out = new Float64Array(JOINT_FLOATS);
  poseJoints(out, { ...standingPose(), ...change });
  return out;
}

const POSES: Record<string, Partial<PoseParams>> = {
  standing: {},
  'standing, aimed': { aim: 1, aimPitch: 0.02 },
  crouched: { pelvisY: 0.52, pitch: 0.65, footL: [0.2, 0.16, 0.15], footR: [-0.2, 0.16, -0.12] },
  'kneeling, aimed': { pelvisY: 0.62, pitch: 0.12, aim: 1, footL: [0.17, 0.16, 0.4], footR: [-0.12, 0.2, -0.36] },
  'sprinting': { pelvisY: 0.88, pitch: 0.25, twist: 0.07, roll: 0.03, footL: [0.1, 0.16, 0.38], footR: [-0.1, 0.4, -0.3] },
  'hands behind his back (the officer)': { behind: 1, twist: 0.2 },
  'walking, hands half way back': { pelvisY: 0.965, pitch: 0.05, behind: 0.5, footL: [0.09, 0.2, 0.3], footR: [-0.09, 0.16, -0.25] },
};

describe('poseJoints', () => {
  it('stands as the bind pose: feet, hands, head and rifle where the model has them', () => {
    const j = pose({});
    for (const i of [S.head, S.neck, S.chest, S.shL, S.shR, S.pelvis, S.hipL, S.hipR, S.footL, S.footR, S.handL, S.handR, S.butt, S.muzzle]) {
      expect(dist(at(j, i), bind(i)), `joint ${i}`).toBeLessThan(0.02);
    }
  });

  for (const [name, change] of Object.entries(POSES)) {
    it(`keeps every bone at its bind length: ${name}`, () => {
      const j = pose(change);
      for (const [a, b] of BONES) {
        expect(dist(at(j, a), at(j, b)), `bone ${a}-${b}`).toBeCloseTo(dist(bind(a), bind(b)), 3);
      }
    });
  }

  for (const name of ['standing, aimed', 'kneeling, aimed']) {
    it(`holds the rifle by both grips when aimed: ${name}`, () => {
      const j = pose(POSES[name]);
      const g = gripPoints(j, 1);
      expect(dist(g.right, at(j, S.handR)), 'right hand').toBeLessThan(0.02);
      expect(dist(g.left, at(j, S.handL)), 'left hand').toBeLessThan(0.02);
    });
  }

  it('shoulders the rifle: the muzzle is in front of him and level when aimed, across his body at the low ready', () => {
    const aimed = pose({ aim: 1 });
    expect(aimed[S.muzzle * 3 + 2]).toBeGreaterThan(aimed[S.butt * 3 + 2] + 0.9);
    expect(Math.abs(aimed[S.muzzle * 3 + 1] - aimed[S.butt * 3 + 1])).toBeLessThan(0.05);
    const low = pose({});
    expect(low[S.muzzle * 3]).toBeGreaterThan(low[S.butt * 3] + 0.5);
  });

  it('plants a foot on its target while it is within reach, and stretches toward one that is not', () => {
    const near = pose({ footL: [0.1, 0.35, 0.3] });
    expect(dist(at(near, S.footL), [0.1, 0.35, 0.3])).toBeLessThan(1e-6);
    const far = pose({ footL: [0.1, 0.16, 2] });
    expect(at(far, S.footL)[2]).toBeLessThan(1);
    expect(dist(at(far, S.hipL), at(far, S.footL))).toBeLessThan(0.8);
  });

  it('lowers the pelvis and leans the head forward when crouched', () => {
    const stand = pose({});
    const crouch = pose(POSES.crouched);
    expect(crouch[S.pelvis * 3 + 1]).toBeLessThan(stand[S.pelvis * 3 + 1] - 0.4);
    expect(crouch[S.head * 3 + 1]).toBeLessThan(1.25);
    expect(crouch[S.head * 3 + 2]).toBeGreaterThan(stand[S.head * 3 + 2] + 0.2);
  });
});

describe('the officer at ease', () => {
  it('clasps his hands at the small of his back, close together, his elbows out', () => {
    const j = pose({ behind: 1 });
    for (const hand of [S.handL, S.handR]) expect(at(j, hand)[2], `hand ${hand}`).toBeLessThan(-0.1);
    expect(dist(at(j, S.handL), at(j, S.handR))).toBeLessThan(0.15);
    expect(at(j, S.elbL)[0]).toBeGreaterThan(0.2);
    expect(at(j, S.elbR)[0]).toBeLessThan(-0.2);
  });
});
