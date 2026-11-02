import { afterEach, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { configurePosition, POSITIONS, terrainHeight } from '../../src/scene/terrainHeight';
import { parseConfig } from '../../src/game/config';
import { solveAim, predict } from '../../src/game/assistance';
import { RIFLES } from '../../src/ballistics/rifles';
import { DESERT_ATMO } from '../../src/ballistics/atmosphere';
import { findZeroElevation } from '../../src/ballistics/trajectory';
afterEach(() => configurePosition('ridge'));
for (const position of ['valley','ridge','mountain'] as const) {
  it(`${position} has grounded eyes and a clear ballistic solution at short and long ranges`, () => {
    expect(parseConfig(`position=${position}`).position).toBe(position);
    const origin = configurePosition(position);
    expect(origin.y).toBeCloseTo(POSITIONS[position].height + .4);
    const eye = new Vector3(origin.x,origin.y,origin.z);
    const rifle = RIFLES['308'];
    const wind = () => ({x:4.47,y:0,z:0});
    const zero = findZeroElevation(rifle,DESERT_ATMO);
    for(const range of [100,800,1500]) {
      const target = new Vector3(0,terrainHeight(0,-range)+1.35,-range);
      const aim = solveAim(eye,target,rifle,DESERT_ATMO,wind,zero);
      expect(aim).not.toBeNull();
      const result = predict(eye,aim!.clone().sub(eye).normalize(),rifle,DESERT_ATMO,wind,zero,range);
      expect(result.impact!.distanceTo(target)).toBeLessThan(.01);
      for(const point of result.points) expect(point.y).toBeGreaterThan(terrainHeight(point.x,point.z));
    }
  });
}
it('invalid firing positions fall back to ridge',()=>expect(parseConfig('position=sky').position).toBe('ridge'));
