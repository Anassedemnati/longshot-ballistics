import { describe, expect, it } from 'vitest';
import type { HitZone } from '../../src/game/hit';
import { boneTransforms, bindBoneFrames } from '../../src/game/ragdoll';
import { JOINT_FLOATS, poseJoints, standingPose } from '../../src/mission/soldierPose';
import { SOLDIER_BONES, SOLDIER_RIG } from '../../src/mission/soldierRig';
import { attachSpheres, placeSpheres } from '../../src/mission/soldierSpheres';
import { dummyHitSpheres } from '../../src/scene/target';

const spheres = dummyHitSpheres();
const attached = attachSpheres(spheres);
const frames = bindBoneFrames(SOLDIER_RIG);

function zones(): HitZone[] {
  return spheres.map((s) => ({ name: s.name, radius: s.radius, center: { x: 0, y: 0, z: 0 } }));
}

function bonesFor(change: Partial<ReturnType<typeof standingPose>>): Float32Array {
  const joints = new Float64Array(JOINT_FLOATS);
  poseJoints(joints, { ...standingPose(), ...change });
  const out = new Float32Array(SOLDIER_RIG.bones.length * 7);
  boneTransforms(SOLDIER_RIG, frames, joints, out);
  return out;
}

describe('hit spheres on bones', () => {
  it('hangs the head on the head, the upper torso on the chest, the lower torso on the pelvis, and limbs on arm or leg bones', () => {
    spheres.forEach((s, i) => {
      const name = SOLDIER_BONES[attached[i].bone];
      if (s.name === 'head') expect(name).toBe('head');
      else if (s.name === 'upperTorso') expect(name).toBe('chest');
      else if (s.name === 'lowerTorso') expect(name).toBe('pelvis');
      else if (Math.abs(s.x) >= 0.2) expect(name).toMatch(/Arm/);
      else expect(name).toMatch(/thigh|shin/);
    });
  });

  it('leaves every sphere where it was built when the bones are at rest', () => {
    const bind = new Float32Array(SOLDIER_RIG.bones.length * 7);
    SOLDIER_RIG.bones.forEach((b, i) => {
      const p = SOLDIER_RIG.particles[b.origin].p;
      bind.set([p[0], p[1], p[2], 0, 0, 0, 1], i * 7);
    });
    const z = zones();
    placeSpheres(attached, bind, 0, 0, 0, 0, z);
    spheres.forEach((s, i) => {
      expect(z[i].center.x).toBeCloseTo(s.x, 5);
      expect(z[i].center.y).toBeCloseTo(s.y, 5);
      expect(z[i].center.z).toBeCloseTo(0, 5);
    });
  });

  it('moves the head sphere down and forward when he crouches, and with the body when it turns and travels', () => {
    const stand = zones();
    placeSpheres(attached, bonesFor({}), 0, 0, 0, 0, stand);
    const crouch = zones();
    placeSpheres(attached, bonesFor({ pelvisY: 0.52, pitch: 0.62, footL: [0.19, 0.16, 0.14], footR: [-0.19, 0.16, -0.1] }), 0, 0, 0, 0, crouch);
    expect(crouch[0].center.y).toBeLessThan(stand[0].center.y - 0.5);
    expect(crouch[0].center.z).toBeGreaterThan(stand[0].center.z + 0.15);
    // The same crouch, the body at (10, 2, -30) turned a quarter turn: the head is where the body's frame puts it.
    const placed = zones();
    placeSpheres(attached, bonesFor({ pelvisY: 0.52, pitch: 0.62, footL: [0.19, 0.16, 0.14], footR: [-0.19, 0.16, -0.1] }), 10, 2, -30, Math.PI / 2, placed);
    expect(placed[0].center.y).toBeCloseTo(crouch[0].center.y + 2, 5);
    // yaw pi/2: local +Z (forward) maps to world +X
    expect(placed[0].center.x).toBeCloseTo(10 + crouch[0].center.z, 4);
    expect(placed[0].center.z).toBeCloseTo(-30 - crouch[0].center.x, 4);
  });
});
