import { describe, expect, it } from 'vitest';
import { SoldierAnimator, cycleLength } from '../../src/mission/soldierAnim';
import type { AnimIntent } from '../../src/mission/soldierAnim';
import { S } from '../../src/mission/soldierRig';

const sprint: AnimIntent = { speed: 4.3, gait: 'sprint', stance: 'crouch', aim: false, turnRate: 0, aimYaw: 0, aimPitch: 0 };
const still = (stance: AnimIntent['stance'], aim = false): AnimIntent => ({ speed: 0, gait: 'none', stance, aim, turnRate: 0, aimYaw: 0, aimPitch: 0 });
const DT = 1 / 60;

function step(a: SoldierAnimator, intent: AnimIntent, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / DT); i++) a.update(DT, intent);
}

describe('SoldierAnimator', () => {
  it('plants a foot on the ground while it carries him: a stance foot does not slide over the ground', () => {
    const a = new SoldierAnimator(1);
    step(a, still('stand'), 0.5);
    step(a, sprint, 1); // up to speed and into the gait
    let body = 0;
    let contact = 0;
    let frames = 0;
    let worst = 0;
    const last = [Infinity, Infinity];
    for (let i = 0; i < 240; i++) {
      a.update(DT, sprint);
      body += sprint.speed * DT;
      [S.footL, S.footR].forEach((foot, k) => {
        const y = a.joints[foot * 3 + 1];
        const worldZ = body + a.joints[foot * 3 + 2];
        // On the ground: ankle at its 0.16 m height (and it was too, the frame before).
        if (y < 0.165 && last[k] !== Infinity) {
          contact++;
          worst = Math.max(worst, Math.abs(worldZ - last[k]));
        }
        last[k] = y < 0.165 ? worldZ : Infinity;
      });
      frames++;
    }
    expect(contact).toBeGreaterThan(frames * 0.2); // each foot is down about a third of the time
    expect(worst).toBeLessThan(0.03); // and does not move 3 cm in a frame over the ground (that is 1.8 m/s of skating)
  });

  it('covers a cycle of ground in a cycle: a longer stride at a higher speed, and a crouch-run shorter than a sprint', () => {
    expect(cycleLength('sprint', 4.3)).toBeGreaterThan(cycleLength('sprint', 3));
    expect(cycleLength('crouchRun', 2.5)).toBeLessThan(cycleLength('sprint', 4.3));
    expect(cycleLength('sprint', 4.3)).toBeCloseTo(2.5, 1);
  });

  it('lowers him to a crouch in about a quarter of a second, and brings him back up', () => {
    const a = new SoldierAnimator(2);
    step(a, still('stand'), 1);
    const up = a.joints[S.head * 3 + 1];
    expect(up).toBeGreaterThan(1.6);
    step(a, still('crouch'), 0.15);
    const half = a.joints[S.head * 3 + 1];
    expect(half).toBeLessThan(up - 0.15); // already moving
    expect(half).toBeGreaterThan(1.2); // not there yet
    step(a, still('crouch'), 1);
    expect(a.joints[S.head * 3 + 1]).toBeLessThan(1.25);
    step(a, still('stand'), 1.2);
    expect(a.joints[S.head * 3 + 1]).toBeGreaterThan(1.6);
  });

  it('leans forward when he sprints and brings the rifle up to the shoulder when he aims', () => {
    const a = new SoldierAnimator(3);
    step(a, still('stand'), 1);
    const z0 = a.joints[S.head * 3 + 2];
    step(a, sprint, 1);
    expect(a.joints[S.head * 3 + 2]).toBeGreaterThan(z0 + 0.1);
    const b = new SoldierAnimator(3);
    step(b, still('kneel', true), 1);
    // Shouldered: the muzzle is a rifle's length in front of the butt, level, and the butt is up at the shoulder.
    expect(b.joints[S.muzzle * 3 + 2] - b.joints[S.butt * 3 + 2]).toBeGreaterThan(0.9);
    expect(b.joints[S.butt * 3 + 1]).toBeGreaterThan(1.0);
  });

  it('kicks the muzzle up and the butt back for a round, and settles again', () => {
    const a = new SoldierAnimator(4);
    step(a, still('kneel', true), 1);
    const rest = a.joints[S.muzzle * 3 + 1];
    a.kick();
    a.update(DT, still('kneel', true));
    expect(a.joints[S.muzzle * 3 + 1]).toBeGreaterThan(rest + 0.01);
    step(a, still('kneel', true), 0.5);
    expect(Math.abs(a.joints[S.muzzle * 3 + 1] - rest)).toBeLessThan(0.005);
  });

  it('follows the ground under each foot', () => {
    const a = new SoldierAnimator(5);
    for (let i = 0; i < 60; i++) a.update(DT, still('stand'), (x) => (x > 0 ? 0.2 : 0)); // his left foot stands on a step
    expect(a.joints[S.footL * 3 + 1] - a.joints[S.footR * 3 + 1]).toBeGreaterThan(0.15);
  });

  it('reports the speed of every joint for the fall that carries his run into it', () => {
    const a = new SoldierAnimator(6);
    step(a, sprint, 1);
    const v = new Float64Array(a.joints.length);
    a.velocities(v);
    let fastest = 0;
    for (let i = 0; i < v.length; i++) fastest = Math.max(fastest, Math.abs(v[i]));
    expect(fastest).toBeGreaterThan(1); // legs swing
    expect(fastest).toBeLessThan(15);
  });
});
