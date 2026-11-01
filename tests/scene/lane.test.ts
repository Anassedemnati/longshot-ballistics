import { describe, expect, it } from 'vitest';
import { DESERT_ATMO } from '../../src/ballistics/atmosphere';
import { RIFLES } from '../../src/ballistics/rifles';
import { findZeroElevation, simulateToRanges } from '../../src/ballistics/trajectory';
import type { WindField } from '../../src/ballistics/types';
import { muzzleLaunch } from '../../src/game/aim';
import { BulletSystem } from '../../src/game/bullets';
import type { ImpactEvent } from '../../src/game/bullets';
import { createTargetDummy } from '../../src/scene/target';
import { SHOOTER_POS, terrainHeight } from '../../src/scene/terrainHeight';

const NO_WIND: WindField = () => ({ x: 0, y: 0, z: 0 });
const RIFLE = RIFLES['308'];
const ZERO = findZeroElevation(RIFLE, DESERT_ATMO);

/** Absolute barrel elevation (rad) that puts the bullet at `dy` metres above the eye at `range`. */
function elevationFor(range: number, dy: number): number {
  let lo = -0.3; // at 100 m the target is 6 degrees below the horizon
  let hi = 0.06;
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi);
    const [sample] = simulateToRanges(RIFLE, DESERT_ATMO, NO_WIND, mid, [range]);
    if (sample.height < dy) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

function shoot(range: number, chestOffset = 0): ImpactEvent[] {
  const dummy = createTargetDummy(range);
  const bullets = new BulletSystem({
    atmo: DESERT_ATMO,
    wind: NO_WIND,
    terrainHeight,
    targets: () => (dummy.down ? [] : [dummy.hitTarget]),
  });
  const chestY = terrainHeight(0, -range) + 1.35 + chestOffset;
  const elevation = elevationFor(range, chestY - SHOOTER_POS.y);
  // Look straight down the lane, pitched so the bore (not the sight line) has `elevation`.
  const pitch = elevation - ZERO;
  const forward = { x: 0, y: Math.sin(pitch), z: -Math.cos(pitch) };
  const up = { x: 0, y: Math.cos(pitch), z: Math.sin(pitch) };
  const { origin, velocity } = muzzleLaunch(SHOOTER_POS, forward, up, RIFLE, ZERO);
  bullets.fire(origin, velocity, RIFLE.bcG7);
  const events: ImpactEvent[] = [];
  for (let i = 0; i < 400 && events.length === 0; i++) events.push(...bullets.update(0.016));
  return events;
}

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
    const dummy = createTargetDummy(500);
    expect(dummy.down).toBe(false);
    dummy.knockDown();
    expect(dummy.down).toBe(true);
    for (let i = 0; i < 40; i++) dummy.update(0.016);
    expect(dummy.group.rotation.x).toBeCloseTo(-Math.PI / 2, 9);
    expect(dummy.group.position.y).toBeCloseTo(terrainHeight(0, -500) + 0.1, 9);
  });

  it('the dummy stands on the ground at the target range, about 1.8 m tall, with the specified hit spheres', () => {
    const dummy = createTargetDummy(650);
    const ground = terrainHeight(0, -650);
    expect(dummy.group.position.z).toBe(-650);
    expect(dummy.group.position.y).toBe(ground);
    const zones = Object.fromEntries(dummy.hitTarget.zones.map((z) => [z.name, z]));
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
