import { describe, expect, it } from 'vitest';
import { Ragdoll, bindBoneFrames, bindPositions, boneTransforms } from '../../src/game/ragdoll';
import { SNIPER_RIG } from '../../src/mission/sniperRig';
import { S, SOLDIER_RIG, soldierFall } from '../../src/mission/soldierRig';
import { createRng } from '../../src/mission/random';

/** Run for `seconds` in frames of 1/60 s. */
function run(rag: Ragdoll, seconds: number): void {
  for (let i = 0; i < Math.round(seconds * 60); i++) rag.step(1 / 60);
}

const dist = (rag: Ragdoll, a: number, b: number): number =>
  Math.hypot(rag.pos[a * 3] - rag.pos[b * 3], rag.pos[a * 3 + 1] - rag.pos[b * 3 + 1], rag.pos[a * 3 + 2] - rag.pos[b * 3 + 2]);

describe('Ragdoll', () => {
  it('a soldier that is shot goes down, comes to rest on the ground and falls asleep', () => {
    const rag = new Ragdoll(SOLDIER_RIG, () => 0);
    soldierFall(rag, { point: [0, 1.35, 0.1], velocity: [0, 0, -800], zone: 'upperTorso' }, createRng(1));
    run(rag, 0.1);
    expect(rag.asleep).toBe(false);
    run(rag, 6);
    expect(rag.asleep).toBe(true);
    SOLDIER_RIG.particles.forEach((q, i) => {
      expect(rag.pos[i * 3 + 1]).toBeGreaterThanOrEqual(q.radius - 1e-6); // never into the ground
      expect(rag.pos[i * 3 + 1]).toBeLessThan(0.6); // and down on it, not standing
    });
  });

  it('keeps the bones the length they were (rigid constraints) and the torso together', () => {
    const rag = new Ragdoll(SOLDIER_RIG, () => 0);
    soldierFall(rag, { point: [0, 1.65, 0.1], velocity: [0, 0, -800], zone: 'head' }, createRng(2));
    run(rag, 0.5);
    const rest = bindPositions(SOLDIER_RIG);
    const bone = (a: number, b: number): number => Math.hypot(rest[a * 3] - rest[b * 3], rest[a * 3 + 1] - rest[b * 3 + 1], rest[a * 3 + 2] - rest[b * 3 + 2]);
    for (const [a, b] of [[S.hipL, S.kneeL], [S.kneeL, S.footL], [S.shR, S.elbR], [S.elbR, S.handR], [S.shL, S.shR], [S.pelvis, S.hipL]]) {
      expect(dist(rag, a, b)).toBeCloseTo(bone(a, b), 1);
    }
  });

  it('rests on sloped ground too: never below it', () => {
    const ground = (x: number): number => 0.3 * x;
    const rag = new Ragdoll(SOLDIER_RIG, (x) => ground(x));
    soldierFall(rag, { point: [0.1, 0.5, 0.1], velocity: [-200, 0, -700], zone: 'limbs' }, createRng(4));
    run(rag, 5);
    SOLDIER_RIG.particles.forEach((q, i) => expect(rag.pos[i * 3 + 1]).toBeGreaterThanOrEqual(ground(rag.pos[i * 3]) + q.radius - 1e-3)); // the ground is sampled once per substep: a millimetre of slack on a slope
  });

  it('knees and elbows do not bend the wrong way', () => {
    const rag = new Ragdoll(SOLDIER_RIG, () => 0);
    soldierFall(rag, { point: [0, 1.35, 0.1], velocity: [0, 0, -800], zone: 'upperTorso' }, createRng(5));
    for (let n = 0; n < 40; n++) {
      run(rag, 0.05);
      // The front of the body: hip line x spine. The knee is never behind the hip-ankle line.
      const p = (i: number, k: number): number => rag.pos[i * 3 + k];
      const lx = p(S.hipL, 0) - p(S.hipR, 0), ly = p(S.hipL, 1) - p(S.hipR, 1), lz = p(S.hipL, 2) - p(S.hipR, 2);
      const ux = p(S.chest, 0) - p(S.pelvis, 0), uy = p(S.chest, 1) - p(S.pelvis, 1), uz = p(S.chest, 2) - p(S.pelvis, 2);
      const f = [ly * uz - lz * uy, lz * ux - lx * uz, lx * uy - ly * ux];
      const fl = Math.hypot(f[0], f[1], f[2]);
      for (const [hip, knee, foot] of [[S.hipL, S.kneeL, S.footL], [S.hipR, S.kneeR, S.footR]]) {
        const s = [0, 1, 2].reduce((acc, k) => acc + (p(knee, k) - (p(hip, k) + p(foot, k)) / 2) * f[k], 0) / fl;
        expect(s).toBeGreaterThan(-0.03);
      }
    }
  });

  it('is the same fall every time for the same seed, and a different one for another', () => {
    const fall = (seed: number): number => {
      const rag = new Ragdoll(SOLDIER_RIG, () => 0);
      soldierFall(rag, { point: [0, 1.35, 0.1], velocity: [0, 0, -800], zone: 'upperTorso' }, createRng(seed));
      run(rag, 2);
      return rag.pos[S.head * 3];
    };
    expect(fall(7)).toBe(fall(7));
    expect(fall(7)).not.toBe(fall(8));
  });

  it('does nothing once asleep, and wakes when started again', () => {
    const rag = new Ragdoll(SNIPER_RIG, () => 0);
    run(rag, 6);
    expect(rag.asleep).toBe(true);
    const before = Array.from(rag.pos);
    rag.step(1);
    expect(Array.from(rag.pos)).toEqual(before);
    rag.start();
    expect(rag.asleep).toBe(false);
  });
});

describe('boneTransforms', () => {
  it('is the identity at the bind pose', () => {
    for (const rig of [SOLDIER_RIG, SNIPER_RIG]) {
      const out = new Float32Array(rig.bones.length * 7);
      boneTransforms(rig, bindBoneFrames(rig), bindPositions(rig), out);
      rig.bones.forEach((b, i) => {
        expect(out[i * 7 + 1]).toBeCloseTo(rig.particles[b.origin].p[1], 5);
        expect(Math.abs(out[i * 7 + 6])).toBeCloseTo(1, 5); // w = +-1: no rotation
        expect(Math.hypot(out[i * 7 + 3], out[i * 7 + 4], out[i * 7 + 5])).toBeCloseTo(0, 5);
      });
    }
  });

  it('a body turned as a whole turns every bone by that turn (45 degrees about Y)', () => {
    const rig = SOLDIER_RIG;
    const bind = bindPositions(rig);
    const turned = new Float64Array(bind.length);
    const c = Math.cos(Math.PI / 4);
    const s = Math.sin(Math.PI / 4);
    for (let i = 0; i < bind.length; i += 3) {
      turned[i] = c * bind[i] + s * bind[i + 2];
      turned[i + 1] = bind[i + 1];
      turned[i + 2] = -s * bind[i] + c * bind[i + 2];
    }
    const out = new Float32Array(rig.bones.length * 7);
    boneTransforms(rig, bindBoneFrames(rig), turned, out);
    const half = Math.PI / 8; // quaternion of 45 degrees about Y: (0, sin 22.5, 0, cos 22.5)
    for (let i = 0; i < rig.bones.length; i++) {
      expect(out[i * 7 + 3]).toBeCloseTo(0, 4);
      expect(Math.abs(out[i * 7 + 4])).toBeCloseTo(Math.sin(half), 4);
      expect(out[i * 7 + 5]).toBeCloseTo(0, 4);
      expect(Math.abs(out[i * 7 + 6])).toBeCloseTo(Math.cos(half), 4);
    }
  });
});
