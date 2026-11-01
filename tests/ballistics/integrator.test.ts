import { describe, expect, it } from 'vitest';
import { STANDARD_ATMO } from '../../src/ballistics/atmosphere';
import { DEFAULT_DT, step } from '../../src/ballistics/integrator';
import type { Atmosphere, BulletState, WindField } from '../../src/ballistics/types';

const NO_WIND: WindField = () => ({ x: 0, y: 0, z: 0 });
const VACUUM: Atmosphere = { ...STANDARD_ATMO, densityRatio: 0 };

function run(s0: BulletState, steps: number, atmo: Atmosphere, wind: WindField): BulletState {
  let s = s0;
  for (let i = 0; i < steps; i++) {
    s = step(s, DEFAULT_DT, 0.243, atmo, wind);
  }
  return s;
}

describe('step (RK4)', () => {
  it('uses a 1 ms default time step', () => {
    expect(DEFAULT_DT).toBe(0.001);
  });

  it('matches vacuum free flight after 1 s', () => {
    const s0: BulletState = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: -800 }, t: 0 };
    const s = run(s0, Math.round(1 / DEFAULT_DT), VACUUM, NO_WIND);
    expect(Math.abs(s.pos.y - -4.903)).toBeLessThanOrEqual(0.001);
    expect(Math.abs(s.pos.z - -800)).toBeLessThanOrEqual(0.001);
    expect(s.pos.x).toBeCloseTo(0, 12);
    expect(s.t).toBeCloseTo(1, 9);
  });

  it('does not mutate the input state', () => {
    const s0: BulletState = { pos: { x: 1, y: 2, z: 3 }, vel: { x: 4, y: 5, z: -600 }, t: 0.5 };
    const copy = structuredClone(s0);
    step(s0, DEFAULT_DT, 0.243, STANDARD_ATMO, NO_WIND);
    expect(s0).toEqual(copy);
  });

  it('drag slows the bullet in standard air', () => {
    const s0: BulletState = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: -800 }, t: 0 };
    const s = run(s0, 100, STANDARD_ATMO, NO_WIND);
    expect(s.vel.z).toBeGreaterThan(-800);
    expect(s.vel.z).toBeLessThan(-700);
  });

  it('drifts with the wind (wind +X pushes the bullet toward +X)', () => {
    const wind: WindField = () => ({ x: 5, y: 0, z: 0 });
    const s0: BulletState = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: -800 }, t: 0 };
    const s = run(s0, Math.round(1 / DEFAULT_DT), STANDARD_ATMO, wind);
    expect(s.pos.x).toBeGreaterThan(0);
  });
});
