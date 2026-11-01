import { describe, expect, it } from 'vitest';
import { STANDARD_ATMO } from '../../src/ballistics/atmosphere';
import { DEFAULT_DT, step } from '../../src/ballistics/integrator';
import { RIFLES } from '../../src/ballistics/rifles';
import { findZeroElevation } from '../../src/ballistics/trajectory';
import type { BulletState, WindField } from '../../src/ballistics/types';
import {
  NAKED_VFOV_RAD,
  magnificationToVfov,
  milToPixels,
  muzzleLaunch,
} from '../../src/game/aim';

const DEG = Math.PI / 180;
const NO_WIND: WindField = () => ({ x: 0, y: 0, z: 0 });
const RIFLE = RIFLES['308'];

describe('magnificationToVfov', () => {
  it('is the naked-eye 60 degrees at 1x', () => {
    expect(NAKED_VFOV_RAD).toBeCloseTo(60 * DEG, 12);
    expect(magnificationToVfov(1)).toBeCloseTo(60 * DEG, 12);
  });

  it('narrows to 2*atan(tan(30deg)/10) = 6.6086 degrees at 10x', () => {
    // The task brief quotes 6.09 deg for 10x, which does not follow from its own formula
    // 2*atan(tan(NAKED/2)/mag) (that gives 6.6086 deg). The formula is the binding spec, so it is asserted here.
    expect(Math.abs(magnificationToVfov(10) - 6.6086 * DEG)).toBeLessThanOrEqual(0.01 * DEG);
    expect(magnificationToVfov(10)).toBeCloseTo(2 * Math.atan(Math.tan(30 * DEG) / 10), 12);
  });

  it('keeps narrowing with magnification', () => {
    expect(magnificationToVfov(4)).toBeGreaterThan(magnificationToVfov(10));
    expect(magnificationToVfov(10)).toBeGreaterThan(magnificationToVfov(20));
  });
});

describe('milToPixels', () => {
  it('1 mil is 8.66 px on a 1000 px tall viewport at 10x', () => {
    // The brief quotes 9.40 px, derived from its erroneous 6.09 deg vfov; the formula
    // tan(mils*0.001)/tan(vfov/2) * h/2 with the 6.6086 deg vfov gives 8.660.
    expect(Math.abs(milToPixels(1, magnificationToVfov(10), 1000) - 8.66)).toBeLessThanOrEqual(0.05);
  });

  it('matches the closed form tan(mil)/tan(vfov/2) * h/2', () => {
    const vfov = magnificationToVfov(7);
    expect(milToPixels(3.5, vfov, 800)).toBeCloseTo((Math.tan(0.0035) / Math.tan(vfov / 2)) * 400, 10);
  });

  it('doubles when the viewport height doubles (resize case)', () => {
    const vfov = magnificationToVfov(10);
    expect(milToPixels(1, vfov, 2000)).toBeCloseTo(2 * milToPixels(1, vfov, 1000), 10);
  });

  it('scales with magnification: 20x shows each mil twice as large as 10x (small angles)', () => {
    const ratio = milToPixels(1, magnificationToVfov(20), 1000) / milToPixels(1, magnificationToVfov(10), 1000);
    expect(ratio).toBeGreaterThan(1.99);
    expect(ratio).toBeLessThan(2.01);
  });

  it('is zero at zero mils and odd in the angle', () => {
    const vfov = magnificationToVfov(10);
    expect(milToPixels(0, vfov, 1000)).toBe(0);
    expect(milToPixels(-2, vfov, 1000)).toBeCloseTo(-milToPixels(2, vfov, 1000), 12);
  });
});

describe('muzzleLaunch', () => {
  const eye = { x: 0, y: 1, z: 0 };
  const forward = { x: 0, y: 0, z: -1 };
  const up = { x: 0, y: 1, z: 0 };

  it('puts the bore sightHeight below the eye and tilts the muzzle velocity up by the zero elevation', () => {
    const e = 0.0021;
    const { origin, velocity } = muzzleLaunch(eye, forward, up, RIFLE, e);
    const mv = RIFLE.muzzleVelocity;
    expect(origin.x).toBeCloseTo(0, 9);
    expect(origin.y).toBeCloseTo(0.96, 9);
    expect(origin.z).toBeCloseTo(0, 9);
    expect(Math.abs(velocity.x - 0)).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(velocity.y - mv * Math.sin(e))).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(velocity.z - -mv * Math.cos(e))).toBeLessThanOrEqual(1e-9);
  });

  it('preserves muzzle speed and rotates about the shooter\'s right axis for a yawed, pitched view', () => {
    const yaw = 30 * DEG;
    const pitch = 12 * DEG;
    const f = {
      x: -Math.sin(yaw) * Math.cos(pitch),
      y: Math.sin(pitch),
      z: -Math.cos(yaw) * Math.cos(pitch),
    };
    const u = {
      x: Math.sin(yaw) * Math.sin(pitch),
      y: Math.cos(pitch),
      z: Math.cos(yaw) * Math.sin(pitch),
    };
    const e = 0.004;
    const { velocity, origin } = muzzleLaunch(eye, f, u, RIFLE, e);
    const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
    expect(speed).toBeCloseTo(RIFLE.muzzleVelocity, 9);
    // Direction = forward*cos(e) + up*sin(e)
    expect(velocity.x / speed).toBeCloseTo(f.x * Math.cos(e) + u.x * Math.sin(e), 12);
    expect(velocity.y / speed).toBeCloseTo(f.y * Math.cos(e) + u.y * Math.sin(e), 12);
    expect(velocity.z / speed).toBeCloseTo(f.z * Math.cos(e) + u.z * Math.sin(e), 12);
    expect(origin.x).toBeCloseTo(eye.x - u.x * RIFLE.sightHeight, 12);
    expect(origin.y).toBeCloseTo(eye.y - u.y * RIFLE.sightHeight, 12);
    expect(origin.z).toBeCloseTo(eye.z - u.z * RIFLE.sightHeight, 12);
  });

  it('still elevates toward "up" when the supplied up vector is not perpendicular to forward', () => {
    const pitch = -10 * DEG; // looking 10 degrees down, world up passed in
    const f = { x: 0, y: Math.sin(pitch), z: -Math.cos(pitch) };
    const e = 0.003;
    const { velocity } = muzzleLaunch(eye, f, up, RIFLE, e);
    const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
    const mv = RIFLE.muzzleVelocity;
    expect(speed).toBeCloseTo(mv, 9);
    expect(velocity.x).toBeCloseTo(0, 9);
    expect(velocity.y / mv).toBeCloseTo(Math.sin(pitch + e), 12);
    expect(velocity.z / mv).toBeCloseTo(-Math.cos(pitch + e), 12);
  });

  it('integration check: a bullet launched at the zero elevation comes back down to the sight line at 100 m', () => {
    const zero = findZeroElevation(RIFLE, STANDARD_ATMO);
    const eyePos = { x: 0, y: 1.5, z: 0 };
    const { origin, velocity } = muzzleLaunch(eyePos, forward, up, RIFLE, zero);
    let s: BulletState = { pos: origin, vel: velocity, t: 0 };
    let crossing: number | null = null;
    while (s.t < 1 && crossing === null) {
      const prev = s;
      s = step(prev, DEFAULT_DT, RIFLE.bcG7, STANDARD_ATMO, NO_WIND);
      // The bore starts below the sight line and crosses it twice; the zero is the descending crossing.
      if (prev.pos.y >= eyePos.y && s.pos.y < eyePos.y) {
        const f = (prev.pos.y - eyePos.y) / (prev.pos.y - s.pos.y);
        crossing = -(prev.pos.z + (s.pos.z - prev.pos.z) * f);
      }
    }
    expect(crossing).not.toBeNull();
    expect(Math.abs((crossing as number) - 100)).toBeLessThanOrEqual(0.5);
  });
});
