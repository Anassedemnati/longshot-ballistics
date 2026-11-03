import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  DUMMY_BOXES,
  DUMMY_HEAD,
  FALL_DURATION,
  RESET_DELAY,
  createTargetDummy,
  createTargetDummyAtRange,
  dummyHitSpheres,
} from '../../src/scene/target';
import { enemyMaterial } from '../../src/scene/enemyMaterial';
import { terrainHeight } from '../../src/scene/terrainHeight';
import { advance, bodyOf, bonesOf } from '../helpers/bones';
import { shootAtDummy } from '../helpers/shoot';

const RANGE = 800;
/** The standing neck's height (the pivot of the head bone), m: what a dummy that stood up again must show. */
const NECK_Y = 1.52;
/** The pivot of the head bone (the neck), in the dummy's own frame. */
const neck = (dummy: ReturnType<typeof createTargetDummy>) => bonesOf(dummy.group)[2].position;

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
});

describe('dummy body mesh', () => {
  it('is one mesh with the shared enemy material (a soldier is one draw call), casting and receiving shadows', () => {
    const dummy = createTargetDummy({ x: 0, y: 0, z: 0 }, 0);
    const meshes: THREE.Mesh[] = [];
    dummy.group.traverse((o) => {
      if (o instanceof THREE.Mesh) meshes.push(o);
    });
    expect(meshes).toHaveLength(1);
    const body = meshes[0];
    expect(body.material).toBe(enemyMaterial());
    expect(body.castShadow && body.receiveShadow).toBe(true);
    // the colour, surface and texture coordinates the shared material reads are on the geometry
    for (const name of ['position', 'normal', 'uv', 'color', 'surface']) expect(body.geometry.getAttribute(name), name).toBeDefined();
    // and the drawn soldier stands on the ground at about the height of the boxes the hit spheres are built for
    body.geometry.computeBoundingBox();
    const box = body.geometry.boundingBox as THREE.Box3;
    expect(box.min.y).toBeGreaterThanOrEqual(-0.02);
    expect(box.max.y).toBeGreaterThan(1.75);
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

  it('goes down as a limp body and lies on the sand once the fall is over', () => {
    const dummy = standing();
    expect(neck(dummy).y).toBeCloseTo(NECK_Y, 9);
    dummy.knockDown();
    expect(dummy.down).toBe(true);
    advance(dummy, FALL_DURATION);
    expect(dummy.down).toBe(true);
    expect(neck(dummy).y).toBeLessThan(0.5); // the shoulders are down on the ground, not standing, not floating
    expect(neck(dummy).y).toBeGreaterThan(0.02);
    for (const bone of bonesOf(dummy.group)) expect(bone.position.y).toBeGreaterThan(-0.05); // nothing sunk into the sand (flat range)
    expect(dummy.group.rotation.x).toBe(0); // no rigid tip: the body is posed bone by bone
  });

  it('is a body that moves on its own: knees buckle and it sags within a third of a second, then it settles and stops moving', () => {
    const dummy = standing();
    dummy.knockDown();
    advance(dummy, 0.1);
    const early = neck(dummy).y;
    expect(early).toBeLessThan(NECK_Y - 0.02);
    advance(dummy, 0.2);
    expect(neck(dummy).y).toBeLessThan(early);
    advance(dummy, FALL_DURATION);
    const settled = bonesOf(dummy.group).map((b) => b.position.clone());
    advance(dummy, 0.5);
    bonesOf(dummy.group).forEach((b, i) => expect(b.position.distanceTo(settled[i])).toBeLessThan(0.02));
  });

  it('is culled by the standing sphere while up, not at all while falling, and by a sphere around where it lies once it has settled', () => {
    const dummy = standing();
    const mesh = bodyOf(dummy.group);
    expect(mesh.frustumCulled).toBe(true);
    dummy.knockDown();
    advance(dummy, 0.1);
    expect(mesh.frustumCulled).toBe(false); // moving: the standing sphere no longer holds it
    advance(dummy, 8);
    expect(mesh.frustumCulled).toBe(true);
    const sphere = mesh.boundingSphere as THREE.Sphere;
    for (const bone of bonesOf(dummy.group)) expect(sphere.distanceToPoint(bone.position)).toBeLessThan(0); // every joint is inside it
    expect(sphere.radius).toBeLessThan(2.5); // and it is a sphere around the body, not the world
    dummy.reset();
    expect(mesh.frustumCulled).toBe(true);
    expect((mesh.boundingSphere as THREE.Sphere).center.y).toBeGreaterThan(0.5); // the standing one again
  });

  it('a head shot and a shot to the leg bring it down differently, each the same way every time', () => {
    const fall = (zone: 'head' | 'limbs') => {
      const d = createTargetDummy({ x: 0, y: groundY, z: -RANGE }, 0, 'soldier-1', { autoReset: false });
      const hit = { point: { x: 0.1, y: groundY + (zone === 'head' ? 1.65 : 0.5), z: -RANGE + 0.1 }, velocity: { x: 0, y: 0, z: -800 }, zone };
      d.knockDown(hit);
      advance(d, FALL_DURATION);
      return bonesOf(d.group).map((b) => b.position.clone());
    };
    const head = fall('head');
    const leg = fall('limbs');
    expect(fall('head').every((p, i) => p.distanceTo(head[i]) === 0)).toBe(true); // repeatable
    expect(head.some((p, i) => p.distanceTo(leg[i]) > 0.1)).toBe(true);
  });

  it('stays down for 3 s after it has finished falling, then stands up again by itself', () => {
    expect(RESET_DELAY).toBe(3);
    const dummy = standing();
    dummy.knockDown();
    advance(dummy, FALL_DURATION);
    advance(dummy, RESET_DELAY - 0.1);
    expect(dummy.down).toBe(true);
    expect(neck(dummy).y).toBeLessThan(0.5);
    dummy.update(0.1);
    expect(dummy.down).toBe(false);
    expect(neck(dummy).y).toBeCloseTo(NECK_Y, 9); // back in the bind pose at once
    expect(bodyOf(dummy.group).frustumCulled).toBe(true);
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
    advance(dummy, FALL_DURATION / 2);
    expect(neck(dummy).y).toBeLessThan(NECK_Y - 0.02);
    advance(dummy, FALL_DURATION / 2);
    expect(neck(dummy).y).toBeLessThan(0.5);
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
    advance(dummy, FALL_DURATION);
    for (let i = 0; i < 100; i++) dummy.update(1);
    expect(dummy.down).toBe(true);
    expect(neck(dummy).y).toBeLessThan(0.5);
    dummy.reset();
    expect(dummy.down).toBe(false);
    expect(neck(dummy).y).toBeCloseTo(NECK_Y, 9);
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
    // The bones are children of the group too; the visible body is its one mesh.
    const parts = (g: ReturnType<typeof createTargetDummy>['group']) =>
      g.children.filter((c) => (c as THREE.Mesh).isMesh).map((c) => c as unknown as { geometry: unknown; material: unknown });
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

describe('the HVT officer and his bodyguards are the same body', () => {
  for (const variant of ['officer', 'guard'] as const) {
    it(`a ${variant}: drawn with his own geometry on the soldier's skeleton, the same hit spheres, and he goes down as a ragdoll`, () => {
      const plain = createTargetDummy({ x: 0, y: 0, z: -300 }, 0, 'plain');
      const dummy = createTargetDummy({ x: 0, y: 0, z: -300 }, 0, variant, { autoReset: false, variant });
      const mesh = (d: typeof dummy) => {
        let found: THREE.SkinnedMesh | null = null;
        d.group.traverse((o) => {
          if (o instanceof THREE.SkinnedMesh) found = o;
        });
        return found as unknown as THREE.SkinnedMesh;
      };
      expect(mesh(dummy).geometry).not.toBe(mesh(plain).geometry);
      expect(dummy.hitTarget.zones.map((z) => [z.name, z.radius])).toEqual(plain.hitTarget.zones.map((z) => [z.name, z.radius]));
      dummy.knockDown();
      advance(dummy, FALL_DURATION + 0.5);
      expect(dummy.down).toBe(true);
      expect(neck(dummy).y).toBeLessThan(0.5);
      expect(neck(dummy).y).toBeGreaterThan(0.02);
    });
  }
});
