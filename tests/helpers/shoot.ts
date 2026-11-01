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

/**
 * Fire the .308 from the shooter's eye (no wind, desert air) with exactly the right hold-over to
 * pass through the point `x` metres right of the dummy's centreline and `height` metres above its
 * feet, in the plane of the dummy at `range`. Returns the first impact event.
 */
export function shootAtDummy(range: number, x: number, height: number): ImpactEvent[] {
  const dummy = createTargetDummy(range);
  const bullets = new BulletSystem({
    atmo: DESERT_ATMO,
    wind: NO_WIND,
    terrainHeight,
    targets: () => (dummy.down ? [] : [dummy.hitTarget]),
  });
  const aimY = terrainHeight(0, -range) + height;
  const elevation = elevationFor(range, aimY - SHOOTER_POS.y);
  const pitch = elevation - ZERO; // the view pitch; muzzleLaunch adds the zero elevation on top
  const azimuth = Math.atan2(x, range); // to the right of straight down the lane
  const [sp, cp, sa, ca] = [Math.sin(pitch), Math.cos(pitch), Math.sin(azimuth), Math.cos(azimuth)];
  const forward = { x: sa * cp, y: sp, z: -ca * cp };
  const up = { x: -sa * sp, y: cp, z: ca * sp }; // unit and perpendicular to forward, no roll
  const { origin, velocity } = muzzleLaunch(SHOOTER_POS, forward, up, RIFLE, ZERO);
  bullets.fire(origin, velocity, RIFLE.bcG7);
  const events: ImpactEvent[] = [];
  for (let i = 0; i < 400 && events.length === 0; i++) events.push(...bullets.update(0.016));
  return events;
}
