import { RIFLES } from '../../src/ballistics/rifles';
import { findZeroElevation, simulateToRanges } from '../../src/ballistics/trajectory';
import type { Atmosphere, Vec3, WindField } from '../../src/ballistics/types';
import { muzzleLaunch } from '../../src/game/aim';
import { BulletSystem } from '../../src/game/bullets';
import type { ImpactEvent } from '../../src/game/bullets';
import type { HitTarget, Obstacle } from '../../src/game/hit';
import type { TerrainField } from '../../src/scene/terrainField';

const NO_WIND: WindField = () => ({ x: 0, y: 0, z: 0 });
const RIFLE = RIFLES['308'];

/**
 * Fire the .308 from `field.shooter` (no wind, the given air, the field's own ground) so the bullet passes through
 * the world point `point`, with the given hit targets and obstacles in the world. Returns the first impact event,
 * whatever it is. Like `shootAtPoint`, but for any terrain field and atmosphere (a mission's own theme).
 */
export function shootAtPointIn(
  world: { field: TerrainField; atmo: Atmosphere; targets: HitTarget[]; obstacles?: Obstacle[] },
  point: Vec3,
): ImpactEvent[] {
  const { field, atmo } = world;
  const eye = field.shooter;
  const zero = findZeroElevation(RIFLE, atmo);
  const bullets = new BulletSystem({
    atmo,
    wind: NO_WIND,
    terrainHeight: field.height,
    targets: () => world.targets,
    obstacles: () => world.obstacles ?? [],
  });
  const dx = point.x - eye.x;
  const dz = point.z - eye.z;
  const range = Math.hypot(dx, dz);
  const dy = point.y - eye.y;
  // Barrel elevation that puts the bullet `dy` above the eye at `range` (bisection on the real trajectory).
  let lo = -0.5;
  let hi = 0.5;
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi);
    const [sample] = simulateToRanges(RIFLE, atmo, NO_WIND, mid, [range]);
    if (sample.height < dy) lo = mid;
    else hi = mid;
  }
  const pitch = 0.5 * (lo + hi) - zero;
  const azimuth = Math.atan2(dx, -dz);
  const [sp, cp, sa, ca] = [Math.sin(pitch), Math.cos(pitch), Math.sin(azimuth), Math.cos(azimuth)];
  const forward = { x: sa * cp, y: sp, z: -ca * cp };
  const up = { x: -sa * sp, y: cp, z: ca * sp };
  const { origin, velocity } = muzzleLaunch(eye, forward, up, RIFLE, zero);
  bullets.fire(origin, velocity, RIFLE.bcG7);
  const events: ImpactEvent[] = [];
  for (let i = 0; i < 400 && events.length === 0; i++) events.push(...bullets.update(0.016));
  return events;
}
