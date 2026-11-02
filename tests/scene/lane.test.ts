import { describe, expect, it } from 'vitest';
import { createTargetDummyAtRange } from '../../src/scene/target';
import { terrainHeight } from '../../src/scene/terrainHeight';
import { shootAtDummy } from '../helpers/shoot';

/** Fire at the chest (1.35 m up) plus an offset. */
const shoot = (range: number, chestOffset = 0) => shootAtDummy(range, 0, 1.35 + chestOffset);

describe('range lane end to end', () => {
  for (const range of [100, 450, 800, 1200, 1500]) {
    it(`a shot with the right hold-over hits the dummy at ${range} m`, () => {
      const events = shoot(range);
      expect(events).toHaveLength(1);
      const e = events[0];
      expect(e.kind).toBe('target');
      if (e.kind !== 'target') return;
      expect(e.targetId).toBe('dummy');
      expect(['upperTorso', 'lowerTorso']).toContain(e.zone);
    });
  }

  it('a shot a metre over the head misses and the bullet flies on', () => {
    const events = shoot(300, 1.6);
    expect(events).toHaveLength(1);
    expect(events[0].kind).not.toBe('target');
  });

  it('a knocked-down dummy tips backwards (away from the shooter) and rests near the ground', () => {
    const dummy = createTargetDummyAtRange(500);
    expect(dummy.down).toBe(false);
    dummy.knockDown();
    expect(dummy.down).toBe(true);
    for (let i = 0; i < 40; i++) dummy.update(0.016);
    expect(dummy.group.rotation.x).toBeCloseTo(-Math.PI / 2, 9);
    expect(dummy.group.position.y).toBeCloseTo(terrainHeight(0, -500) + 0.1, 9);
  });

  it('the dummy stands on the ground at the target range, about 1.8 m tall, with the specified hit spheres', () => {
    const dummy = createTargetDummyAtRange(650);
    const ground = terrainHeight(0, -650);
    expect(dummy.group.position.z).toBe(-650);
    expect(dummy.group.position.y).toBe(ground);
    // The first sphere of each zone name is the one from the brief (more spheres follow it).
    const zones = Object.fromEntries(
      [...dummy.hitTarget.zones].reverse().map((z) => [z.name, z]),
    );
    expect(zones.head.radius).toBe(0.12);
    expect(zones.head.center.y).toBeCloseTo(ground + 1.65, 9);
    expect(zones.upperTorso.radius).toBe(0.22);
    expect(zones.upperTorso.center.y).toBeCloseTo(ground + 1.35, 9);
    expect(zones.lowerTorso.radius).toBe(0.2);
    expect(zones.lowerTorso.center.y).toBeCloseTo(ground + 1.0, 9);
    expect(zones.limbs.radius).toBe(0.15);
    expect(zones.limbs.center.y).toBeCloseTo(ground + 0.5, 9);
    for (const z of dummy.hitTarget.zones) expect(z.center.z).toBe(-650);
  });
});
