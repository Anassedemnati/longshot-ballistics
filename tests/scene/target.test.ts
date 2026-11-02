import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  DUMMY_BOXES,
  DUMMY_HEAD,
  FALL_DURATION,
  MAX_OVERHANG,
  RESET_DELAY,
  createTargetDummy,
  createTargetDummyAtRange,
  dummyHitSpheres,
  dummyParts,
} from '../../src/scene/target';
import { terrainHeight } from '../../src/scene/terrainHeight';
import { shootAtDummy } from '../helpers/shoot';

const RANGE = 800;

type Point = [number, number];

/** The convex hull of a point set (Andrew's monotone chain), counter-clockwise. */
function convexHull(points: Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Point, a: Point, b: Point): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const chain = (list: Point[]): Point[] => {
    const out: Point[] = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...chain(sorted), ...chain([...sorted].reverse())];
}

/** Distance from a point to a convex counter-clockwise polygon: 0 inside it. */
function distanceToPolygon(p: Point, polygon: Point[]): number {
  let inside = true;
  let best = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    if (ex * (p[1] - a[1]) - ey * (p[0] - a[0]) < 0) inside = false;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / (ex * ex + ey * ey)));
    best = Math.min(best, Math.hypot(p[0] - a[0] - t * ex, p[1] - a[1] - t * ey));
  }
  return inside ? 0 : best;
}

/** Kind and zone of the first impact of a shot through (x, height above the feet) at 800 m. */
function shotAt(x: number, height: number): { kind: string; zone?: string } {
  const events = shootAtDummy(RANGE, x, height);
  expect(events).toHaveLength(1);
  const e = events[0];
  return e.kind === 'target' ? { kind: e.kind, zone: e.zone } : { kind: e.kind };
}

describe('dummy hit zones match the visible dummy', () => {
  it('uses only the four zone names, with the specified sphere first for each', () => {
    const zones = createTargetDummyAtRange(RANGE).hitTarget.zones;
    expect(new Set(zones.map((z) => z.name))).toEqual(
      new Set(['head', 'upperTorso', 'lowerTorso', 'limbs']),
    );
    expect(zones.slice(0, 4).map((z) => z.name)).toEqual(['head', 'upperTorso', 'lowerTorso', 'limbs']);
    expect(zones.length).toBeGreaterThan(4);
  });

  describe('shots through the middle of each body part register the right zone', () => {
    const cases: Array<[string, number, number, string]> = [
      ['left arm centre', -0.27, 1.26, 'limbs'],
      ['right arm centre', 0.27, 1.26, 'limbs'],
      ['left arm, near the hand', -0.27, 1.0, 'limbs'],
      ['lower leg (0.2 m up), left', -0.1, 0.2, 'limbs'],
      ['lower leg (0.2 m up), right', 0.1, 0.2, 'limbs'],
      ['outer edge of the lower leg', 0.16, 0.3, 'limbs'],
      ['upper leg (0.7 m up), right', 0.1, 0.7, 'limbs'],
      ['upper leg (0.7 m up), left', -0.1, 0.7, 'limbs'],
      ['boot', 0.1, 0.04, 'limbs'],
      ['vest corner, top right', 0.19, 1.56, 'upperTorso'],
      ['vest corner, top left', -0.19, 1.56, 'upperTorso'],
      ['vest corner, bottom right', 0.19, 1.14, 'upperTorso'],
      ['vest corner, bottom left', -0.19, 1.14, 'upperTorso'],
      ['vest side edge', 0.2, 1.35, 'upperTorso'],
      ['chest', 0, 1.35, 'upperTorso'],
      ['pelvis corner, right', 0.14, 0.9, 'lowerTorso'],
      ['pelvis corner, left', -0.14, 0.9, 'lowerTorso'],
      ['belly', 0, 0.97, 'lowerTorso'],
      ['head', 0, 1.65, 'head'],
    ];
    for (const [label, x, height, zone] of cases) {
      it(`${label} -> ${zone}`, () => {
        expect(shotAt(x, height)).toEqual({ kind: 'target', zone });
      });
    }
  });

  describe('shots 0.1 m outside the silhouette do not hit', () => {
    const cases: Array<[string, number, number]> = [
      ['beside the right arm', 0.42, 1.26],
      ['beside the left arm', -0.42, 1.26],
      ['above the head', 0, 1.87],
      ['beside the lower leg', 0.28, 0.4],
      ['beside the lower leg, left', -0.28, 0.4],
      ['beside the pelvis, below the hand', 0.27, 0.85],
      ['between the head and the shoulder', 0.25, 1.75],
    ];
    for (const [label, x, height] of cases) {
      it(label, () => {
        expect(shotAt(x, height).kind).not.toBe('target');
      });
    }
  });

  it('every point on the front of every visible box is inside a hit sphere seen along the line of sight', () => {
    const spheres = dummyHitSpheres();
    const inset = 0.03;
    const uncovered: string[] = [];
    for (const box of DUMMY_BOXES) {
      for (let i = 0; i < 5; i++) {
        for (let j = 0; j < 5; j++) {
          const x = box.cx - box.w / 2 + inset + ((box.w - 2 * inset) * i) / 4;
          const y = box.cy - box.h / 2 + inset + ((box.h - 2 * inset) * j) / 4;
          // Shots come from the shooter's side (+Z, almost horizontal): a point is hit if its
          // (x, y) lies within a sphere's radius of the sphere's axis.
          const covered = spheres.some((s) => Math.hypot(x - s.x, y - s.y) <= s.radius);
          if (!covered) uncovered.push(`${box.name} (${x.toFixed(3)}, ${y.toFixed(3)})`);
        }
      }
    }
    // Head: points on the front of the sphere's silhouette.
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * 2 * Math.PI;
      const x = Math.cos(a) * DUMMY_HEAD.radius * 0.97;
      const y = DUMMY_HEAD.cy + Math.sin(a) * DUMMY_HEAD.radius * 0.97;
      if (!spheres.some((s) => Math.hypot(x - s.x, y - s.y) <= s.radius)) uncovered.push(`head ${k}`);
    }
    expect(uncovered).toEqual([]);
  });

  it('hit spheres overhang the silhouette of the drawn shapes by at most 3 cm', () => {
    // The shapes as the scene draws them (rounded boxes, head sphere, goggles, scarf), not the sharp DUMMY_BOXES
    // they are built from: the outline of each convex mesh seen from the front is the hull of its vertices.
    const outlines: Point[][] = [];
    for (const part of dummyParts()) {
      const position = part.geometry.getAttribute('position');
      const points: Point[] = [];
      for (let i = 0; i < position.count; i++) points.push([position.getX(i), position.getY(i)]);
      outlines.push(convexHull(points));
    }
    expect(outlines.length).toBe(DUMMY_BOXES.length - 1 + 3); // no neck (the scarf covers it), plus head, goggles, scarf
    let worst = 0;
    let where = '';
    for (const s of dummyHitSpheres()) {
      for (let k = 0; k < 360; k++) {
        const a = (k / 360) * 2 * Math.PI;
        const p: Point = [s.x + Math.cos(a) * s.radius, s.y + Math.sin(a) * s.radius];
        if (p[1] < 0) continue; // below the ground nobody sees it
        const d = Math.min(...outlines.map((outline) => distanceToPolygon(p, outline)));
        if (d > worst) {
          worst = d;
          where = `${s.name} sphere (${s.x.toFixed(3)}, ${s.y.toFixed(3)}) r${s.radius} at (${p[0].toFixed(3)}, ${p[1].toFixed(3)})`;
        }
      }
    }
    // Half a millimetre of slack for the polygons that stand in for the rounded corners.
    expect(worst, where).toBeLessThanOrEqual(MAX_OVERHANG + 0.0005);
  });
});

describe('dummy body mesh', () => {
  it('is every part merged into one geometry with its colour in a vertex attribute (a soldier is one draw call)', () => {
    const dummy = createTargetDummy({ x: 0, y: 0, z: 0 }, 0);
    const meshes: THREE.Mesh[] = [];
    dummy.group.traverse((o) => {
      if (o instanceof THREE.Mesh) meshes.push(o);
    });
    expect(meshes).toHaveLength(1);
    const body = meshes[0];
    const parts = dummyParts();
    const vertices = (g: THREE.BufferGeometry): number => (g.index ? g.index.count : g.getAttribute('position').count); // merged non-indexed: three per triangle
    expect(body.geometry.getAttribute('position').count).toBe(parts.reduce((n, p) => n + vertices(p.geometry), 0));
    expect(body.geometry.getAttribute('color')).toBeDefined();
    expect((body.material as THREE.MeshStandardMaterial).vertexColors).toBe(true);
    expect(body.castShadow && body.receiveShadow).toBe(true);
    // the colours are the parts': khaki head and vest/limbs from DUMMY_BOXES, dark goggles
    const colors = body.geometry.getAttribute('color');
    const first = new THREE.Color(parts[0].color);
    expect([colors.getX(0), colors.getY(0), colors.getZ(0)]).toEqual([first.r, first.g, first.b].map((v) => Math.fround(v)));
    expect(new Set(parts.map((p) => p.color)).size).toBeGreaterThanOrEqual(3);
    // and the merged body stays inside the boxes the hit spheres are built for
    body.geometry.computeBoundingBox();
    const box = body.geometry.boundingBox as THREE.Box3;
    expect(box.min.y).toBeGreaterThanOrEqual(-0.02);
    expect(box.max.y).toBeLessThan(1.95);
  });
});

describe('dummy fall and reset', () => {
  const groundY = terrainHeight(0, -RANGE);

  function standing() {
    const dummy = createTargetDummyAtRange(RANGE);
    expect(dummy.down).toBe(false);
    return dummy;
  }

  it('stands upright until it is knocked down', () => {
    const dummy = standing();
    dummy.update(10);
    expect(dummy.down).toBe(false);
    expect(dummy.group.rotation.x).toBe(0);
    expect(dummy.group.position.y).toBe(groundY);
  });

  it('tips over backwards and lies on the sand once the fall is over', () => {
    const dummy = standing();
    dummy.knockDown();
    expect(dummy.down).toBe(true);
    dummy.update(FALL_DURATION);
    expect(dummy.group.rotation.x).toBeCloseTo(-Math.PI / 2, 9);
    expect(dummy.group.position.y).toBeGreaterThan(groundY);
    expect(dummy.down).toBe(true);
  });

  it('stays down for 3 s after it has finished falling, then stands up again by itself', () => {
    expect(RESET_DELAY).toBe(3);
    const dummy = standing();
    dummy.knockDown();
    dummy.update(FALL_DURATION);
    dummy.update(RESET_DELAY - 0.1);
    expect(dummy.down).toBe(true);
    expect(dummy.group.rotation.x).toBeCloseTo(-Math.PI / 2, 9);
    dummy.update(0.1);
    expect(dummy.down).toBe(false);
    expect(dummy.group.rotation.x).toBe(0);
    expect(dummy.group.position.y).toBe(groundY);
  });

  it('counts the 3 s from the end of the fall, not from the knock-down', () => {
    const dummy = standing();
    dummy.knockDown();
    dummy.update(FALL_DURATION / 2);
    dummy.update(RESET_DELAY); // only half the fall + 3 s since the knock-down
    expect(dummy.down).toBe(true);
    dummy.update(FALL_DURATION / 2 + 0.01);
    expect(dummy.down).toBe(false);
  });

  it('works with small frame steps', () => {
    const dummy = standing();
    dummy.knockDown();
    let t = 0;
    while (dummy.down && t < 10) {
      dummy.update(1 / 60);
      t += 1 / 60;
    }
    expect(dummy.down).toBe(false);
    expect(t).toBeCloseTo(FALL_DURATION + RESET_DELAY, 1);
  });

  it('reset() stands it up at once, mid-fall or lying', () => {
    const dummy = standing();
    dummy.knockDown();
    dummy.update(FALL_DURATION / 2);
    dummy.reset();
    expect(dummy.down).toBe(false);
    expect(dummy.group.rotation.x).toBe(0);
    expect(dummy.group.position.y).toBe(groundY);

    dummy.knockDown();
    dummy.update(FALL_DURATION + 1);
    dummy.reset();
    expect(dummy.down).toBe(false);
    expect(dummy.group.rotation.x).toBe(0);
    expect(dummy.group.position.y).toBe(groundY);
  });

  it('can be knocked down again after a reset and falls and resets again', () => {
    const dummy = standing();
    dummy.knockDown();
    dummy.update(FALL_DURATION + RESET_DELAY);
    expect(dummy.down).toBe(false);

    dummy.knockDown();
    expect(dummy.down).toBe(true);
    dummy.update(FALL_DURATION / 2);
    expect(dummy.group.rotation.x).toBeLessThan(0);
    expect(dummy.group.rotation.x).toBeGreaterThan(-Math.PI / 2);
    dummy.update(FALL_DURATION / 2);
    expect(dummy.group.rotation.x).toBeCloseTo(-Math.PI / 2, 9);
    dummy.update(RESET_DELAY);
    expect(dummy.down).toBe(false);
  });

  it('a second knock-down while it is already down does not restart the timers', () => {
    const dummy = standing();
    dummy.knockDown();
    dummy.update(FALL_DURATION + RESET_DELAY - 0.5);
    dummy.knockDown();
    dummy.update(0.5);
    expect(dummy.down).toBe(false);
  });

  it('ignores zero, negative and non-finite frame times', () => {
    const dummy = standing();
    dummy.knockDown();
    for (const dt of [0, -1, NaN, Infinity]) dummy.update(dt);
    expect(dummy.group.rotation.x).toBe(0); // the fall has not started
    expect(dummy.down).toBe(true);
    dummy.update(FALL_DURATION);
    for (const dt of [-5, NaN, Infinity]) dummy.update(dt);
    expect(dummy.down).toBe(true);
  });

  it('shots hit it again once it has stood back up', () => {
    // The game offers the hit spheres to the bullets only while `down` is false.
    const dummy = standing();
    dummy.knockDown();
    dummy.update(FALL_DURATION + RESET_DELAY);
    const targets = dummy.down ? [] : [dummy.hitTarget];
    expect(targets).toHaveLength(1);
    expect(targets[0].zones[0].center.y).toBeCloseTo(groundY + DUMMY_HEAD.cy, 9);
  });
  it('with autoReset off (mission soldiers) it stays down for good, and reset() still stands it up', () => {
    const dummy = createTargetDummy({ x: 0, y: groundY, z: -RANGE }, 0, 'soldier-0', { autoReset: false });
    dummy.knockDown();
    dummy.update(FALL_DURATION);
    for (let i = 0; i < 100; i++) dummy.update(1);
    expect(dummy.down).toBe(true);
    expect(dummy.group.rotation.x).toBeCloseTo(-Math.PI / 2, 9);
    dummy.reset();
    expect(dummy.down).toBe(false);
  });

  it('autoReset defaults to on and the id is the hit target id', () => {
    const dummy = createTargetDummy({ x: 0, y: groundY, z: -RANGE }, 0, 'soldier-7');
    expect(dummy.hitTarget.id).toBe('soldier-7');
    dummy.knockDown();
    dummy.update(FALL_DURATION + RESET_DELAY);
    expect(dummy.down).toBe(false);
  });

  it('dummies share their geometries and materials', () => {
    const a = createTargetDummy({ x: 0, y: 0, z: -100 }, 0, 'a');
    const b = createTargetDummy({ x: 5, y: 0, z: -100 }, 0.3, 'b');
    const parts = (g: ReturnType<typeof createTargetDummy>['group']) =>
      g.children.map((c) => c as unknown as { geometry: unknown; material: unknown });
    const pa = parts(a.group);
    const pb = parts(b.group);
    expect(pa.length).toBe(1); // the whole body is one mesh: one draw call per soldier
    expect(pa.length).toBe(pb.length);
    pa.forEach((part, i) => {
      expect(part.geometry).toBe(pb[i].geometry);
      expect(part.material).toBe(pb[i].material);
    });
  });
});
