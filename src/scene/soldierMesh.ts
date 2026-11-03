import * as THREE from 'three';
import { soldierModel } from '../mission/soldierModel';
import { smoothstep } from '../player/rifleTextures';
import { SOLDIER_BONES } from '../mission/soldierRig';
import { EnemyBuilder } from './enemyParts';

// The geometry of the standing soldier: scene/target.ts draws it as one mesh with the shared enemy material, skinned to the bones of the ragdoll rig (mission/soldierRig.ts; scene/ragdollBody.ts). Built
// once and shared by every soldier (nothing changes it afterwards; it lives as long as the page).

let geometry: THREE.BufferGeometry | null = null;

/** Dirt and shadow baked into the colour: darker toward the ground (boots, trouser cuffs), a little darker where the body faces down. */
function soldierShade(_x: number, y: number, _z: number, _nx: number, ny: number): number {
  const dirt = 0.78 + 0.22 * smoothstep(0.02, 0.4, y);
  const under = 0.9 + 0.1 * smoothstep(-0.8, 0.3, ny);
  return dirt * under;
}

/** The soldier's one geometry (feet at the origin, front +Z), with colour, surface and texture coordinates per vertex. */
export function soldierGeometry(): THREE.BufferGeometry {
  if (geometry) return geometry;
  const builder = new EnemyBuilder(SOLDIER_BONES);
  builder.addModel(soldierModel());
  geometry = builder.build(soldierShade);
  return geometry;
}
