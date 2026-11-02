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
} from '../../src/scene/target';
import { terrainHeight } from '../../src/scene/terrainHeight';
import { shootAtDummy } from '../helpers/shoot';

const RANGE = 800;

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

  it('hit spheres overhang the visible silhouette by at most about 3 cm', () => {
    const rectDistance = (px: number, py: number, cx: number, cy: number, w: number, h: number): number =>
      Math.hypot(Math.max(Math.abs(px - cx) - w / 2, 0), Math.max(Math.abs(py - cy) - h / 2, 0));
    const silhouetteDistance = (px: number, py: number): number => {
      let best = Math.max(Math.hypot(px, py - DUMMY_HEAD.cy) - DUMMY_HEAD.radius, 0);
      for (const b of DUMMY_BOXES) best = Math.min(best, rectDistance(px, py, b.cx, b.cy, b.w, b.h));
      return best;
    };
    const worst: string[] = [];
    for (const s of dummyHitSpheres()) {
      for (let k = 0; k < 24; k++) {
        const a = (k / 24) * 2 * Math.PI;
        const d = silhouetteDistance(s.x + Math.cos(a) * s.radius, s.y + Math.sin(a) * s.radius);
        if (d > MAX_OVERHANG + 0.005) {
          worst.push(`${s.name} (${s.x.toFixed(2)}, ${s.y.toFixed(2)}) r${s.radius}: ${d.toFixed(3)}`);
        }
      }
    }
    expect(worst).toEqual([]);
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
});
