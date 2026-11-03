import * as THREE from 'three';
import { sniperBodyParts, sniperRifleParts, sniperStrands } from '../mission/sniperModel';
import { smoothstep } from '../player/rifleTextures';
import { EnemyBuilder } from './enemyParts';

// The geometry of the prone sniper: the body (ghillie suit with its strands, hood, gloves, boots, pack) in the body
// frame, and the scoped rifle on its bipod in the rifle's own frame (the rifle sweeps about its pivot). scene/sniper.ts
// draws them with the shared enemy material. Built once and shared by every sniper.

export interface SniperGeometries {
  body: THREE.BufferGeometry;
  rifle: THREE.BufferGeometry;
}

let shared: SniperGeometries | null = null;

/** A little darker toward the ground and on what faces down: the strands lie on the dirt and shade each other. */
function sniperShade(_x: number, y: number, _z: number, _nx: number, ny: number): number {
  return (0.8 + 0.2 * smoothstep(0, 0.22, y)) * (0.88 + 0.12 * smoothstep(-0.8, 0.4, ny));
}

/** The body and rifle geometries (built on first use). */
export function sniperGeometries(): SniperGeometries {
  if (shared) return shared;
  const body = new EnemyBuilder();
  for (const part of sniperBodyParts()) body.addPart(part);
  for (const s of sniperStrands()) body.strand(s.root, s.tip, s.radius, s.color);
  const rifle = new EnemyBuilder();
  for (const part of sniperRifleParts()) rifle.addPart(part);
  shared = { body: body.build(sniperShade), rifle: rifle.build() };
  return shared;
}
