import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { MAX_OVERHANG } from '../../src/mission/dummyDims';
import { GHILLIE_TONES, SNIPER_BASE_SCALE, sniperBodyParts, sniperRifleParts, sniperStrands } from '../../src/mission/sniperModel';
import { SNIPER_BOUNDS, SNIPER_PARTS, SNIPER_RIFLE, sniperHitSpheres } from '../../src/mission/sniperDims';
import { camoPixels, meanLinear } from '../../src/scene/enemyTextures';
import { sniperGeometries } from '../../src/scene/sniperMesh';
import { overhangs, rasterize } from '../helpers/silhouette';
import type { Disc, Projection } from '../helpers/silhouette';

// The prone sniper's hit spheres are blanketed over the ellipsoids of SNIPER_PARTS; the drawn body is a ghillie-suited
// rifleman. The body mesh (the rifle sweeps, so it is not part of the body) is rasterised from its real triangles in the same
// twelve views the spheres were made for, and no sphere's disc may reach more than MAX_OVERHANG past it.

interface View {
  name: string;
  project: Projection;
}
const DEG = Math.PI / 180;
/** The shooter looks along the body's axis, down by `deg` (90 is straight down, negative looks up from a valley). */
const pitched = (deg: number): View => ({ name: deg === 0 ? 'front' : deg === 90 ? 'top' : `looking ${deg > 0 ? 'down' : 'up'} ${Math.abs(deg)} degrees`, project: (x, y, z) => [x, y * Math.cos(deg * DEG) - z * Math.sin(deg * DEG)] });
/** The shooter is level, the sniper turned by `deg`. */
const turned = (deg: number): View => ({ name: `turned ${deg} degrees`, project: (x, y, z) => [x * Math.cos(deg * DEG) + z * Math.sin(deg * DEG), y] });
const VIEWS: View[] = [pitched(0), pitched(90), ...[10, 20, 30, 45, 60, 75].map(pitched), pitched(-10), pitched(-20), turned(10), turned(-10)];

function discsIn(view: View): Disc[] {
  return sniperHitSpheres().map((s) => {
    const [u, v] = view.project(s.x, s.y, s.z);
    return { u, v, r: s.radius, label: `${s.name} sphere (${s.x.toFixed(2)}, ${s.y.toFixed(2)}, ${s.z.toFixed(2)}) r${s.radius}` };
  });
}

describe('sniper body mesh covers the hit spheres', () => {
  const { body } = sniperGeometries();
  for (const view of VIEWS) {
    it(`seen ${view.name}, no sphere's disc reaches 3 cm past the silhouette`, () => {
      const bad = overhangs(rasterize(body, view.project), discsIn(view), MAX_OVERHANG + 0.0005, 120);
      expect(bad.slice(0, 5)).toEqual([]);
    });
  }

  it('the measure fails a body slimmer than his hit spheres (so it is not vacuous)', () => {
    const slim = body.clone().scale(0.7, 1, 1);
    const front = pitched(0);
    expect(overhangs(rasterize(slim, front.project), discsIn(front), MAX_OVERHANG + 0.0005, 120).length).toBeGreaterThan(20);
  });
});

describe('sniper body mesh shape', () => {
  const { body, rifle } = sniperGeometries();
  body.computeBoundingBox();
  rifle.computeBoundingBox();
  const box = body.boundingBox as THREE.Box3;
  const rifleBox = rifle.boundingBox as THREE.Box3;

  it('is a body of the size of the hit ellipsoids that the base mass is made of: no part is smaller than its ellipsoid', () => {
    const base = sniperBodyParts().filter((p) => p.kind === 'ellipsoid' && p.surface === 'cloth');
    // the suit's five limb and trunk parts plus the hood are the hit ellipsoids at SNIPER_BASE_SCALE
    for (const part of SNIPER_PARTS) {
      expect(base.some((b) => b.kind === 'ellipsoid' && Math.abs(b.c[2] - part.cz) < 1e-9 && Math.abs(b.c[0] - part.cx) < 1e-9)).toBe(true);
    }
    expect(SNIPER_BASE_SCALE).toBeGreaterThanOrEqual(1);
    expect(SNIPER_BASE_SCALE).toBeLessThanOrEqual(1.06);
  });

  it('lies on the ground, low, and stays within a hand of the old bounds (strands and the hat reach a few cm past them)', () => {
    expect(box.min.y).toBeGreaterThanOrEqual(-0.01);
    expect(box.min.y).toBeLessThan(0.03);
    const b = SNIPER_BOUNDS;
    const slack = 0.1;
    expect(box.min.x).toBeGreaterThanOrEqual(b.cx - b.hx - slack);
    expect(box.max.x).toBeLessThanOrEqual(b.cx + b.hx + slack);
    expect(box.max.y).toBeLessThanOrEqual(b.cy + b.hy + slack);
    expect(box.min.z).toBeGreaterThanOrEqual(b.cz - b.hz - slack);
    expect(box.max.z).toBeLessThanOrEqual(b.cz + b.hz + slack);
  });

  it('has a ghillie suit: hundreds of strands in several tones, rooted on the base mass and never in front of the face', () => {
    const strands = sniperStrands();
    expect(strands.length).toBeGreaterThan(600);
    expect(new Set(strands.map((s) => s.color)).size).toBe(GHILLIE_TONES.length);
    for (const s of strands) {
      expect(s.root[2]).toBeLessThanOrEqual(0.19 + 1e-9);
      expect(s.tip[1]).toBeGreaterThan(0);
      const length = Math.hypot(s.tip[0] - s.root[0], s.tip[1] - s.root[1], s.tip[2] - s.root[2]);
      expect(length).toBeGreaterThan(0.01);
      expect(length).toBeLessThan(0.13);
    }
    // seeded: the same suit every run
    expect(sniperStrands()[17]).toEqual(strands[17]);
  });

  it('stays within the 3-5 thousand triangles an enemy may cost (a body of ghillie strands and the rifle together)', () => {
    const triangles = (body.getAttribute('position').count + rifle.getAttribute('position').count) / 3;
    expect(triangles).toBeGreaterThan(2500);
    expect(triangles).toBeLessThanOrEqual(6000);
  });

  it('keeps the rifle inside the old tubes (butt to muzzle) and, at the end of its 0.3 rad sweep, inside SNIPER_BOUNDS', () => {
    const { pivot, tubes } = SNIPER_RIFLE;
    const reachZ = Math.max(...tubes.map((t) => t.z + t.length / 2));
    const reachBack = Math.min(...tubes.map((t) => t.z - t.length / 2));
    expect(rifleBox.max.z).toBeLessThanOrEqual(reachZ + 1e-6);
    expect(rifleBox.min.z).toBeGreaterThanOrEqual(reachBack - 0.01);
    // the bipod feet reach the ground, the scope stays under the old top
    expect(pivot.y + rifleBox.min.y).toBeGreaterThanOrEqual(-0.01);
    expect(pivot.y + rifleBox.max.y).toBeLessThanOrEqual(pivot.y + 0.22 + 1e-6);
    // swept: every vertex, turned about the pivot by +-0.3 rad, lies in the broad bounds (to the 3 cm the bounds' own margin allows)
    const b = SNIPER_BOUNDS;
    const position = rifle.getAttribute('position');
    for (const a of [-0.3, 0.3]) {
      for (let i = 0; i < position.count; i++) {
        const x = pivot.x + position.getX(i) * Math.cos(a) + position.getZ(i) * Math.sin(a);
        const z = pivot.z - position.getX(i) * Math.sin(a) + position.getZ(i) * Math.cos(a);
        if (x < b.cx - b.hx - 0.03 || x > b.cx + b.hx + 0.03 || z < b.cz - b.hz - 0.03 || z > b.cz + b.hz + 0.03) {
          throw new Error(`rifle vertex ${i} swept by ${a} rad is outside the bounds at (${x.toFixed(3)}, ${z.toFixed(3)})`);
        }
      }
    }
  });

  it('puts nothing between the scope lens and the glint (a depth-tested sprite): the objective ends at or behind it', () => {
    const position = rifle.getAttribute('position');
    const { glint } = SNIPER_RIFLE;
    for (let i = 0; i < position.count; i++) {
      const onAxis = Math.hypot(position.getX(i), position.getY(i) - glint.y) < 0.045;
      if (onAxis) expect(position.getZ(i), `vertex ${i}`).toBeLessThanOrEqual(glint.z + 1e-6);
    }
    // and no body vertex is in front of it either, in the body frame: the glint is at pivot + glint
    const g = new THREE.Vector3(SNIPER_RIFLE.pivot.x + glint.x, SNIPER_RIFLE.pivot.y + glint.y, SNIPER_RIFLE.pivot.z + glint.z);
    const bodyPosition = sniperGeometries().body.getAttribute('position');
    for (let i = 0; i < bodyPosition.count; i++) {
      const inFront = bodyPosition.getZ(i) > g.z && Math.hypot(bodyPosition.getX(i) - g.x, bodyPosition.getY(i) - g.y) < 0.06;
      expect(inFront, `body vertex ${i}`).toBe(false);
    }
  });

  it('has the rifle parts of a scoped bolt rifle on a bipod: steel, a stock, glass and two legs', () => {
    const parts = sniperRifleParts();
    expect(parts.filter((p) => p.surface === 'metal').length).toBeGreaterThanOrEqual(8);
    expect(parts.filter((p) => p.surface === 'glass').length).toBeGreaterThanOrEqual(1);
    expect(parts.filter((p) => p.kind === 'tube' && p.surface === 'metal' && p.a[1] < p.b[1] === false && Math.abs(p.a[2] - p.b[2]) < 1e-9).length).toBeGreaterThanOrEqual(2);
  });
});

describe('sniper colours against the old one', () => {
  const lum = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const camo = meanLinear(camoPixels());

  /** Area-weighted mean linear luminance of what faces `dir`, the camo counted at its mean colour. */
  function facingLuminance(g: THREE.BufferGeometry, dir: THREE.Vector3): number {
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
      const w = Math.max(0, b.sub(a).cross(c.sub(a)).dot(dir)) / 2;
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

  /** The old sniper: the ellipsoids' projected areas in their colours (from the front and from above). */
  function oldLuminance(axes: (p: (typeof SNIPER_PARTS)[number]) => number): number {
    let sum = 0;
    let area = 0;
    for (const p of SNIPER_PARTS) {
      const c = new THREE.Color(p.color);
      const a = axes(p);
      sum += a * lum(c.r, c.g, c.b);
      area += a;
    }
    return sum / area;
  }

  it('seen from the front and from above he is as bright as the old sniper or a little darker, never lighter', () => {
    const { body } = sniperGeometries();
    const front = facingLuminance(body, new THREE.Vector3(0, 0, 1)) / oldLuminance((p) => Math.PI * p.rx * p.ry);
    const top = facingLuminance(body, new THREE.Vector3(0, 1, 0)) / oldLuminance((p) => Math.PI * p.rx * p.rz);
    for (const ratio of [front, top]) {
      expect(ratio).toBeGreaterThan(0.8);
      expect(ratio).toBeLessThan(1.05);
    }
  });
});
