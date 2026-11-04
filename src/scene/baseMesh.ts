import * as THREE from 'three';
import type { SceneryPlacement } from '../mission/props';
import type { ThemeId } from '../mission/themes';
import { PART_CLASSES, propMaterial } from './materials';
import type { PartClass } from './materials';
import { bakeProp, propShade } from './props';

// A whole military base as one mesh per material class. A base holds 60-90 props; drawn one by one
// (`createPropMesh`) each costs its 2-5 meshes plus shadow casters, several hundred draw calls in all. Here every
// prop's baked geometry (scene/props.ts `bakeProp`, the same vertices `createPropMesh` draws) is moved to its
// placement (yaw, then its footprint centre on the ground) and appended to its class's buffer, so the base costs
// at most six meshes plus their shadow passes, whatever it holds. The base is static scenery: nothing in it is
// a vehicle target (the engine block is folded into the paint mesh), and its colliders are the props' own
// (`propColliders`, one per box), registered separately.

/** Classes whose merged mesh casts sun shadows: the bodies, barriers (plain: bags, HESCO) and canvas (trim). Glass only receives. */
const CASTS: ReadonlySet<PartClass> = new Set<PartClass>(['wall', 'roof', 'paint', 'plain', 'trim']);

interface Buffers {
  pos: number[];
  nor: number[];
  uv: number[];
  col: number[];
  idx: number[];
}

/**
 * One group holding one mesh per material class for all `placements`, each prop standing at `groundAt(x, z)` under
 * its footprint centre (the same height `world.ts` gives a prop and its colliders). Meshes name their class in
 * `userData.part` and the number of props merged in `userData.props`.
 */
export function createBaseMesh(placements: readonly SceneryPlacement[], groundAt: (x: number, z: number) => number, theme: ThemeId): THREE.Group {
  const group = new THREE.Group();
  group.name = 'military-base';
  const buffers = new Map<PartClass, Buffers>();
  const counts = new Map<PartClass, number>();
  for (const p of placements) {
    const groundY = groundAt(p.x, p.z);
    const c = Math.cos(p.yaw);
    const s = Math.sin(p.yaw);
    for (const [key, baked] of bakeProp(p.kind, theme, propShade(p.id))) {
      const cls: PartClass = key === 'engine' ? 'paint' : key;
      let buf = buffers.get(cls);
      if (!buf) {
        buf = { pos: [], nor: [], uv: [], col: [], idx: [] };
        buffers.set(cls, buf);
      }
      counts.set(cls, (counts.get(cls) ?? 0) + 1);
      const g = baked.geometry;
      const pos = g.getAttribute('position');
      const nor = g.getAttribute('normal');
      const uv = g.getAttribute('uv');
      const col = g.getAttribute('color');
      const base = buf.pos.length / 3;
      for (let i = 0; i < pos.count; i++) {
        // Local +X maps to (cos yaw, 0, -sin yaw), local +Z to (sin yaw, 0, cos yaw): three.js rotation.y.
        const x = pos.getX(i);
        const z = pos.getZ(i);
        buf.pos.push(p.x + c * x + s * z, groundY + pos.getY(i), p.z - s * x + c * z);
        const nx = nor.getX(i);
        const nz = nor.getZ(i);
        buf.nor.push(c * nx + s * nz, nor.getY(i), -s * nx + c * nz);
        buf.uv.push(uv.getX(i), uv.getY(i));
        buf.col.push(col.getX(i), col.getY(i), col.getZ(i));
      }
      const index = g.getIndex();
      if (!index) throw new Error(`baked ${p.kind} geometry has no index`);
      for (let i = 0; i < index.count; i++) buf.idx.push(base + index.getX(i));
    }
  }
  for (const cls of PART_CLASSES) {
    const buf = buffers.get(cls);
    if (!buf) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(buf.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(buf.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(buf.col, 3));
    g.setIndex(buf.pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(buf.idx, 1) : new THREE.Uint16BufferAttribute(buf.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    const mesh = new THREE.Mesh(g, propMaterial(theme, cls));
    mesh.name = `base ${cls}`;
    mesh.castShadow = CASTS.has(cls);
    mesh.receiveShadow = true;
    mesh.userData.part = cls;
    mesh.userData.props = counts.get(cls) ?? 0;
    mesh.matrixAutoUpdate = false; // static scenery
    mesh.updateMatrix();
    group.add(mesh);
  }
  return group;
}
