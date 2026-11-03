import * as THREE from 'three';

/** The bones of an enemy's group (the skeleton of its ragdoll, in the group's own frame: feet at the origin). */
export function bonesOf(group: THREE.Group): THREE.Bone[] {
  return group.children.filter((c): c is THREE.Bone => (c as THREE.Bone).isBone === true);
}

/** Pivots of the bones, in the group's frame. */
export function pivots(group: THREE.Group): THREE.Vector3[] {
  return bonesOf(group).map((b) => b.position.clone());
}

/** The skinned body mesh of an enemy's group. */
export function bodyOf(group: THREE.Group): THREE.SkinnedMesh {
  const mesh = group.children.find((c): c is THREE.SkinnedMesh => (c as THREE.SkinnedMesh).isSkinnedMesh === true);
  if (!mesh) throw new Error('no skinned body');
  return mesh;
}

/** Run `update` for `seconds` in frames of `step` (the ragdoll simulates at most 0.1 s of any one frame, as the game's loop caps them). */
export function advance(body: { update(dt: number): void }, seconds: number, step = 0.05): void {
  const frames = Math.round(seconds / step);
  for (let i = 0; i < frames; i++) body.update(step);
}
