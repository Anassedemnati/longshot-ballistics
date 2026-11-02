import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/ballistics/types';
import { rangeUnderCrosshair } from '../../src/game/rangefinder';
import type { HitTarget, Obstacle } from '../../src/game/hit';
import type { TerrainField } from '../../src/scene/terrainField';

const flat = (y = 0): TerrainField => ({ theme: 'desert', height: () => y, shooter: { x: 0, y: 10, z: 0 }, outcrops: [] });
const ORIGIN: Vec3 = { x: 0, y: 10, z: 0 };
/** Unit vector looking `down` degrees below the horizon along -Z. */
const pitched = (downDeg: number): Vec3 => {
  const a = (downDeg * Math.PI) / 180;
  return { x: 0, y: -Math.sin(a), z: -Math.cos(a) };
};
const LEVEL: Vec3 = { x: 0, y: 0, z: -1 };

const wall = (z: number, y = 10): Obstacle => ({
  id: 'wall',
  material: 'wall',
  box: { center: { x: 0, y, z }, halfSize: { x: 3, y: 2, z: 0.2 }, yaw: 0 },
});

describe('rangeUnderCrosshair', () => {
  it('finds flat ground at the slant distance (10 m up, 10 degrees down: 57.6 m)', () => {
    const r = rangeUnderCrosshair(ORIGIN, pitched(10), flat(), [], []);
    expect(r).not.toBeNull();
    expect(r as number).toBeCloseTo(10 / Math.sin((10 * Math.PI) / 180), 1);
    expect(r as number).toBeCloseTo(57.6, 1);
  });

  it('does not need a unit direction', () => {
    const d = pitched(10);
    const r = rangeUnderCrosshair(ORIGIN, { x: d.x * 5, y: d.y * 5, z: d.z * 5 }, flat(), [], []);
    expect(r as number).toBeCloseTo(57.6, 1);
  });

  it('is null for a ray at the sky', () => {
    expect(rangeUnderCrosshair(ORIGIN, pitched(-20), flat(), [], [])).toBeNull();
  });

  it('is null for a level ray over flat ground that never lands within the maximum range', () => {
    expect(rangeUnderCrosshair(ORIGIN, LEVEL, flat(), [], [])).toBeNull();
  });

  it('finds rising terrain ahead of a level ray', () => {
    const hill: TerrainField = { ...flat(), height: (_x, z) => (z < -400 ? 30 : 0) };
    const r = rangeUnderCrosshair(ORIGIN, LEVEL, hill, [], []);
    expect(r as number).toBeCloseTo(400, 0);
  });

  it('returns the wall when it stands in front of the ground', () => {
    const r = rangeUnderCrosshair(ORIGIN, LEVEL, flat(), [wall(-100)], []);
    expect(r as number).toBeCloseTo(99.8, 3); // the near face of the 0.4 m thick wall
  });

  it('prefers the ground when it is nearer than the wall', () => {
    const r = rangeUnderCrosshair(ORIGIN, pitched(10), flat(), [wall(-100, 40)], []);
    expect(r as number).toBeCloseTo(57.6, 1);
  });

  it('ignores a wall off to the side of the ray', () => {
    const side: Obstacle = { ...wall(-100), box: { ...wall(-100).box, center: { x: 20, y: 10, z: -100 } } };
    expect(rangeUnderCrosshair(ORIGIN, LEVEL, flat(), [side], [])).toBeNull();
  });

  it('returns the nearest of several obstacles', () => {
    const r = rangeUnderCrosshair(ORIGIN, LEVEL, flat(), [wall(-300), wall(-150), wall(-220)], []);
    expect(r as number).toBeCloseTo(149.8, 3);
  });

  it('returns the entry distance of a target sphere', () => {
    const t: HitTarget = { id: 't', zones: [{ name: 'upperTorso', center: { x: 0, y: 10, z: -200 }, radius: 0.5 }] };
    expect(rangeUnderCrosshair(ORIGIN, LEVEL, flat(), [], [t]) as number).toBeCloseTo(199.5, 6);
  });

  it('a target in front of a wall wins, a wall in front of a target wins', () => {
    const t: HitTarget = { id: 't', zones: [{ name: 'head', center: { x: 0, y: 10, z: -200 }, radius: 0.3 }] };
    expect(rangeUnderCrosshair(ORIGIN, LEVEL, flat(), [wall(-300)], [t]) as number).toBeCloseTo(199.7, 6);
    expect(rangeUnderCrosshair(ORIGIN, LEVEL, flat(), [wall(-100)], [t]) as number).toBeCloseTo(99.8, 3);
  });

  it('uses the broad-phase bounds without rejecting a grazing target', () => {
    const t: HitTarget = {
      id: 't',
      zones: [{ name: 'limbs', center: { x: 0.3, y: 10, z: -200 }, radius: 0.31 }],
      bounds: { center: { x: 0, y: 10, z: -200 }, radius: 0.8 },
    };
    expect(rangeUnderCrosshair(ORIGIN, LEVEL, flat(), [], [t])).not.toBeNull();
    const far: HitTarget = { ...t, bounds: { center: { x: 50, y: 10, z: -200 }, radius: 0.8 } };
    expect(rangeUnderCrosshair(ORIGIN, LEVEL, flat(), [], [far])).toBeNull();
  });

  it('a target beyond the maximum range is not reported', () => {
    const t: HitTarget = { id: 't', zones: [{ name: 'head', center: { x: 0, y: 10, z: -1000 }, radius: 0.5 }] };
    expect(rangeUnderCrosshair(ORIGIN, LEVEL, flat(), [], [t], 500)).toBeNull();
    expect(rangeUnderCrosshair(ORIGIN, LEVEL, flat(), [], [t], 1500) as number).toBeCloseTo(999.5, 6);
  });

  it('ground beyond the maximum range is not reported', () => {
    expect(rangeUnderCrosshair(ORIGIN, pitched(10), flat(), [], [], 50)).toBeNull();
  });
});
