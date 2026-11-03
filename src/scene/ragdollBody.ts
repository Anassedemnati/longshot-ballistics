import * as THREE from 'three';
import { Ragdoll, bindBoneFrames, bindPositions, boneTransforms } from '../game/ragdoll';
import type { RigSpec } from '../game/ragdoll';
import { createRng } from '../mission/random';
import type { Rng } from '../mission/random';

// Drives a skinned enemy mesh from a Verlet ragdoll (game/ragdoll.ts). The enemy keeps ONE draw call: the shared merged geometry is bound
// to a skeleton of flat bones (children of the enemy's group, so they live in its frame: feet at the origin); each bone is a rigid piece
// of the body that pivots at one joint, and every frame while the body falls the bones take the pose the particles give them. At rest
// (and while standing) the bones sit in the bind pose, so the mesh looks exactly like the static one did.

export interface RagdollBodyOptions<H> {
  rig: RigSpec;
  /** The skinned geometry (built with the rig's bone names, scene/enemyParts.ts) and the shared material. */
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** The group the mesh and its bones go into. */
  group: THREE.Group;
  /** Ground height at (x, z) of the group's frame, m: the terrain (or a roof) under the enemy, relative to its feet. */
  ground: (x: number, z: number) => number;
  /** Gives the standing rig the velocities of a fall (see `soldierFall`, `sniperFall`). */
  crumple: (rag: Ragdoll, hit: H | undefined, rng: Rng) => void;
  name: string;
}

export interface RagdollBody<H> {
  readonly mesh: THREE.SkinnedMesh;
  /** True from `fall` until the body has come to rest. */
  readonly falling: boolean;
  /** Start the fall: `hit` is whatever the rig's `crumple` understands (the bullet, in the body's frame); `seed` makes the chance of it repeatable. */
  fall(hit: H | undefined, seed: number): void;
  /** Simulate `dt` seconds of the fall (nothing at all once it has come to rest) and pose the bones. */
  update(dt: number): void;
  /** Stand up again at once: bind pose, nothing simulated. */
  reset(): void;
  dispose(): void;
}

/** A small hash of a string: the seed of a fall (the same shot at the same soldier falls the same way). */
export function seedOf(text: string, extra = 0): number {
  let h = 2166136261 ^ extra;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A lying body reaches this far, m, beyond the sphere through its joints (the thickness of the body, its rifle and its pack). */
const LYING_MARGIN = 0.5;

export function createRagdollBody<H>(opts: RagdollBodyOptions<H>): RagdollBody<H> {
  const { rig, group } = opts;
  const bind = bindPositions(rig);
  const frames = bindBoneFrames(rig);
  const rag = new Ragdoll(rig, opts.ground);
  rag.sleep();

  // One flat bone per rig bone. Rest: at the bind pivot, no rotation; the inverse is the move back to the origin.
  const bones = rig.bones.map((b, i) => {
    const bone = new THREE.Bone();
    bone.name = `${opts.name}-bone-${i}`;
    bone.position.set(bind[b.origin * 3], bind[b.origin * 3 + 1], bind[b.origin * 3 + 2]);
    group.add(bone);
    return bone;
  });
  const inverses = bones.map((bone) => new THREE.Matrix4().makeTranslation(-bone.position.x, -bone.position.y, -bone.position.z));
  const skeleton = new THREE.Skeleton(bones, inverses);
  const mesh = new THREE.SkinnedMesh(opts.geometry, opts.material);
  mesh.name = opts.name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  // The identity bind matrix: bones and mesh share the group's frame, so a skinned vertex is just (bone pose) x (inverse bind) x vertex.
  mesh.bind(skeleton, new THREE.Matrix4());
  // Standing, the bounding sphere of the shared geometry is right (and cheaper than computing one per soldier from the skeleton).
  const standingSphere = opts.geometry.boundingSphere;
  if (standingSphere) mesh.boundingSphere = standingSphere.clone();

  const buffer = new Float32Array(rig.bones.length * 7);
  let falling = false;

  const pose = (): void => {
    boneTransforms(rig, frames, rag.pos, buffer);
    bones.forEach((bone, i) => {
      const o = i * 7;
      bone.position.set(buffer[o], buffer[o + 1], buffer[o + 2]);
      bone.quaternion.set(buffer[o + 3], buffer[o + 4], buffer[o + 5], buffer[o + 6]);
    });
  };

  return {
    mesh,
    get falling() {
      return falling;
    },
    fall(hit, seed) {
      rag.start();
      opts.crumple(rag, hit, createRng(seed));
      falling = true;
      mesh.frustumCulled = false; // the body leaves the standing pose's bounding sphere
    },
    update(dt) {
      if (!falling) return;
      rag.step(dt);
      pose();
      if (rag.asleep) {
        falling = false; // posed one last time: from here the bones stay as they are
        // Culled again like anything else, by a sphere around where the body lies (the joints plus the thickness of the body around them).
        const c = new THREE.Vector3();
        for (let i = 0; i < rag.count; i++) c.add(new THREE.Vector3(rag.pos[i * 3], rag.pos[i * 3 + 1], rag.pos[i * 3 + 2]));
        c.divideScalar(rag.count);
        let r = 0;
        for (let i = 0; i < rag.count; i++) r = Math.max(r, Math.hypot(rag.pos[i * 3] - c.x, rag.pos[i * 3 + 1] - c.y, rag.pos[i * 3 + 2] - c.z));
        mesh.boundingSphere = new THREE.Sphere(c, r + LYING_MARGIN);
        mesh.frustumCulled = true;
      }
    },
    reset() {
      falling = false;
      rag.start();
      rag.sleep();
      bones.forEach((bone, i) => {
        bone.position.set(bind[rig.bones[i].origin * 3], bind[rig.bones[i].origin * 3 + 1], bind[rig.bones[i].origin * 3 + 2]);
        bone.quaternion.identity();
      });
      if (standingSphere) mesh.boundingSphere = standingSphere.clone();
      mesh.frustumCulled = true;
    },
    dispose() {
      skeleton.dispose();
    },
  };
}
