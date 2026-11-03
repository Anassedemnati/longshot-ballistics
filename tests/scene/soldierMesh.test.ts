import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { describe, expect, it } from 'vitest';
import { DUMMY_BOXES, DUMMY_HEAD, DUMMY_KHAKI, MAX_OVERHANG } from '../../src/mission/dummyDims';
import { SURFACES } from '../../src/mission/enemySurface';
import { SOLDIER_RIFLE_BUTT, SOLDIER_RIFLE_DIR, soldierModel } from '../../src/mission/soldierModel';
import { camoPixels, meanLinear } from '../../src/scene/enemyTextures';
import { soldierGeometry } from '../../src/scene/soldierMesh';
import { dummyHitSpheres } from '../../src/scene/target';
import { overhangs, rasterize } from '../helpers/silhouette';
import type { Disc, Projection } from '../helpers/silhouette';

// The soldier is drawn as a rifleman, but his hit spheres are still blanketed over the old boxes (dummyDims.ts). These tests
// measure, from the real triangles, that what is drawn covers every sphere: no sphere's disc reaches more than MAX_OVERHANG
// past the silhouette. The measure itself is checked against the old boxy mesh (it passes) and against a slimmed soldier (it fails).

/** The shooter looks at the soldier's front, down by `deg` (negative: up from a valley): a point's place in the image plane. */
const pitched = (deg: number): Projection => {
  const c = Math.cos((deg * Math.PI) / 180);
  const s = Math.sin((deg * Math.PI) / 180);
  return (x, y, z) => [x, y * c - z * s];
};

/** The discs of every hit sphere in the view `deg` down. */
function discs(deg: number): Disc[] {
  const c = Math.cos((deg * Math.PI) / 180);
  return dummyHitSpheres().map((s) => ({ u: s.x, v: s.y * c, r: s.radius, label: `${s.name} sphere (${s.x.toFixed(3)}, ${s.y.toFixed(3)}) r${s.radius}` }));
}

/** The old blocky soldier (rounded boxes, a head sphere, goggles, a scarf), rebuilt from DUMMY_BOXES for the control. */
function oldBoxySoldier(): THREE.BufferGeometry {
  const radii: Record<string, number> = { vest: 0.03, pelvis: 0.025, 'left arm': 0.02, 'right arm': 0.02, 'left leg': 0.02, 'right leg': 0.02, 'left boot': 0.02, 'right boot': 0.02 };
  const parts: THREE.BufferGeometry[] = [new THREE.SphereGeometry(DUMMY_HEAD.radius, 22, 16).translate(0, DUMMY_HEAD.cy, 0)];
  for (const b of DUMMY_BOXES) {
    if (b.name !== 'neck') parts.push(new RoundedBoxGeometry(b.w, b.h, b.d, 3, radii[b.name] ?? 0).translate(b.cx, b.cy, b.cz));
  }
  parts.push(new RoundedBoxGeometry(0.19, 0.045, 0.045, 3, 0.011).translate(0, 1.68, 0.105));
  parts.push(new THREE.CylinderGeometry(0.1, 0.08, 0.1, 18).translate(0, 1.56, 0));
  const merged = mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)));
  if (!merged) throw new Error('old soldier did not merge');
  return merged;
}

/** From a valley (10 degrees up), level, and from a hill (10 and 20 degrees down): the shooter's eye is a dozen metres above the ground, so these span every range of a mission. */
const VIEWS = [-10, 0, 10, 20];

describe('soldier mesh covers the hit spheres', () => {
  for (const deg of VIEWS) {
    it(`seen from ${deg === 0 ? 'the front' : `${Math.abs(deg)} degrees ${deg > 0 ? 'above' : 'below'}`}, no sphere's disc reaches 3 cm past the silhouette`, () => {
      const silhouette = rasterize(soldierGeometry(), pitched(deg));
      const bad = overhangs(silhouette, discs(deg), MAX_OVERHANG + 0.0005, 180, 0);
      expect(bad.slice(0, 5)).toEqual([]);
    });
  }

  it('the measure passes the old boxy soldier (so it is not asking for the impossible)', () => {
    for (const deg of VIEWS) {
      const bad = overhangs(rasterize(oldBoxySoldier(), pitched(deg)), discs(deg), MAX_OVERHANG + 0.0005, 180, 0);
      expect(bad.slice(0, 5), `${deg} degrees`).toEqual([]);
    }
  });

  it('the measure fails a soldier slimmer than his hit spheres (so it is not vacuous)', () => {
    const slim = soldierGeometry().clone().scale(0.85, 1, 1);
    const bad = overhangs(rasterize(slim, pitched(0)), discs(0), MAX_OVERHANG + 0.0005, 180, 0);
    expect(bad.length).toBeGreaterThan(50);
    const short = soldierGeometry().clone().scale(1, 0.92, 1);
    expect(overhangs(rasterize(short, pitched(0)), discs(0), MAX_OVERHANG + 0.0005, 180, 0).length).toBeGreaterThan(50);
  });
});

describe('soldier mesh shape', () => {
  const g = soldierGeometry();
  g.computeBoundingBox();
  const box = g.boundingBox as THREE.Box3;

  it('stands on the ground at human height, helmet included', () => {
    expect(box.min.y).toBeGreaterThanOrEqual(-0.02);
    expect(box.min.y).toBeLessThan(0.01);
    expect(box.max.y).toBeGreaterThan(1.75);
    expect(box.max.y).toBeLessThan(1.9);
  });

  it('is the width of a soldier with a rifle, and not deeper than a man with a pack and a rifle at the low ready', () => {
    expect(box.max.x).toBeLessThan(0.45);
    expect(box.min.x).toBeGreaterThan(-0.45);
    expect(box.min.z).toBeGreaterThan(-0.35); // the pack
    expect(box.max.z).toBeLessThan(0.75); // the muzzle
  });

  it('stays within the 3-5 thousand triangles an enemy may cost (13 of them are on screen)', () => {
    const triangles = g.getAttribute('position').count / 3;
    expect(triangles).toBeGreaterThan(2500);
    expect(triangles).toBeLessThanOrEqual(5000);
  });

  it('has a normal, texture coordinates, a colour and a surface on every vertex, and unit normals', () => {
    const n = g.getAttribute('position').count;
    for (const name of ['normal', 'uv', 'color', 'surface']) expect(g.getAttribute(name).count, name).toBe(n);
    expect(g.getAttribute('surface').itemSize).toBe(4);
    for (let i = 0; i < n; i += 37) {
      expect(Math.hypot(g.getAttribute('normal').getX(i), g.getAttribute('normal').getY(i), g.getAttribute('normal').getZ(i))).toBeCloseTo(1, 4);
    }
  });

  it('only uses surfaces that exist, in the ranges the shader expects', () => {
    const s = g.getAttribute('surface');
    for (let i = 0; i < s.count; i++) {
      expect(s.getX(i)).toBeGreaterThanOrEqual(0);
      expect(s.getX(i)).toBeLessThanOrEqual(1);
      expect(s.getY(i)).toBeGreaterThan(0.1);
      expect(s.getY(i)).toBeLessThanOrEqual(1);
      expect(s.getZ(i)).toBeGreaterThanOrEqual(0);
      expect(s.getZ(i)).toBeLessThanOrEqual(1);
    }
    // camo cloth, plain gear, skin and steel are all there
    const camo = new Set<string>();
    for (let i = 0; i < s.count; i++) camo.add([s.getX(i), s.getY(i), s.getZ(i), s.getW(i)].map((v) => v.toFixed(2)).join());
    for (const key of ['camo', 'gear', 'skin', 'metal'] as const) {
      const def = SURFACES[key];
      expect(camo.has([def.camo, def.roughness, def.metalness, def.bump].map((v) => v.toFixed(2)).join()), key).toBe(true);
    }
  });
});

describe('soldier model: his kit', () => {
  const flat = soldierModel().flatMap((group) => group.parts);

  it('has all the parts of a rifleman: legs, boots, torso, pouches, pack, head, helmet, arms, gloves and a rifle', () => {
    expect(flat.filter((p) => p.kind === 'lathe').length).toBeGreaterThanOrEqual(3); // belt, cummerbund, helmet (and its band)
    expect(flat.filter((p) => p.surface === 'metal').length).toBeGreaterThanOrEqual(4); // the rifle
    expect(flat.filter((p) => p.surface === 'skin').length).toBeGreaterThanOrEqual(3);
    expect(flat.filter((p) => p.surface === 'glass').length).toBeGreaterThanOrEqual(2);
    expect(flat.filter((p) => p.surface === 'gear').length).toBeGreaterThanOrEqual(12);
    expect(flat.filter((p) => p.surface === 'camo').length).toBeGreaterThanOrEqual(12);
  });

  it('carries the rifle across the belly: butt at his right hip, muzzle forward and to his left, a little down', () => {
    expect(SOLDIER_RIFLE_BUTT[0]).toBeLessThan(-0.2);
    expect(SOLDIER_RIFLE_DIR[0]).toBeGreaterThan(0.4);
    expect(SOLDIER_RIFLE_DIR[2]).toBeGreaterThan(0.3);
    expect(SOLDIER_RIFLE_DIR[1]).toBeLessThan(0);
    expect(SOLDIER_RIFLE_BUTT[1]).toBeGreaterThan(1.0);
    expect(SOLDIER_RIFLE_BUTT[1]).toBeLessThan(1.3);
  });
});

describe('soldier colours against the old one', () => {
  const lum = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const camo = meanLinear(camoPixels());

  /** Area-weighted mean linear luminance of what faces +Z (the shooter), the camo counted at its mean colour. */
  function frontLuminance(g: THREE.BufferGeometry): number {
    const pos = g.getAttribute('position');
    const col = g.getAttribute('color');
    const sur = g.getAttribute('surface');
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    let sum = 0;
    let weight = 0;
    for (let t = 0; t + 2 < pos.count; t += 3) {
      a.fromBufferAttribute(pos, t);
      b.fromBufferAttribute(pos, t + 1);
      c.fromBufferAttribute(pos, t + 2);
      const w = Math.max(0, b.sub(a).cross(c.sub(a)).z) / 2;
      if (w <= 0) continue;
      const k = sur.getX(t);
      let r = 0;
      let gg = 0;
      let bb = 0;
      for (let v = 0; v < 3; v++) {
        r += col.getX(t + v) / 3;
        gg += col.getY(t + v) / 3;
        bb += col.getZ(t + v) / 3;
      }
      sum += w * lum(r * (1 - k + k * camo.r), gg * (1 - k + k * camo.g), bb * (1 - k + k * camo.b));
      weight += w;
    }
    return sum / weight;
  }

  it('the camo averages to the old khaki, so he is no lighter against the ground than he was', () => {
    const old = new THREE.Color(DUMMY_KHAKI);
    const oldLuminance = lum(old.r, old.g, old.b);
    expect(camo.luminance / oldLuminance).toBeGreaterThan(0.95);
    expect(camo.luminance / oldLuminance).toBeLessThan(1.1);
  });

  it('the whole soldier, seen from the front, is as bright as the old one or a little darker, never lighter', () => {
    // the old soldier: front faces of the boxes (width x height) in their colours, and the head disc in khaki
    let sum = 0;
    let area = 0;
    for (const box of DUMMY_BOXES) {
      if (box.name === 'neck') continue;
      const c = new THREE.Color(box.color);
      sum += box.w * box.h * lum(c.r, c.g, c.b);
      area += box.w * box.h;
    }
    const head = new THREE.Color(DUMMY_KHAKI);
    sum += Math.PI * DUMMY_HEAD.radius ** 2 * lum(head.r, head.g, head.b);
    area += Math.PI * DUMMY_HEAD.radius ** 2;
    const ratio = frontLuminance(soldierGeometry()) / (sum / area);
    expect(ratio).toBeGreaterThan(0.85);
    expect(ratio).toBeLessThan(1.02);
  });
});
