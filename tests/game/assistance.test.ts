import { describe, it, expect } from 'vitest';
import { Vector3 } from 'three';
import { predict, solveAim } from '../../src/game/assistance';
import { RIFLES } from '../../src/ballistics/rifles';
import { DESERT_ATMO } from '../../src/ballistics/atmosphere';
import { findZeroElevation } from '../../src/ballistics/trajectory';

describe('assistance', () => {
  for (const speed of [-4.47, 0, 4.47]) {
    it(`solves elevated target with wind ${speed}`, () => {
      const rifle = RIFLES['308'];
      const zero = findZeroElevation(rifle, DESERT_ATMO);
      const wind = () => ({ x: speed, y: 0, z: 0 });
      const eye = new Vector3(0, 3, 0);
      const target = new Vector3(0, 8, -800);
      const aim = solveAim(eye, target, rifle, DESERT_ATMO, wind, zero);
      expect(aim).not.toBeNull();
      const result = predict(eye, aim!.clone().sub(eye).normalize(), rifle, DESERT_ATMO, wind, zero, 800);
      expect(result.impact!.distanceTo(target)).toBeLessThan(0.01);
    });
  }
});
