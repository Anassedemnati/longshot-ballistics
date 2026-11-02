import type { Vec3 } from '../../src/ballistics/types';
import type { Obstacle } from '../../src/game/hit';
import { DEFAULT_MISSION, clampMission } from '../../src/mission/config';
import type { FiringPosition, MissionConfig } from '../../src/mission/config';
import { generateLayout, layoutColliders, lineOfSightClear, soldierAimPoints } from '../../src/mission/layout';
import type { MissionLayout } from '../../src/mission/layout';
import { vehicleEngineObstacle } from '../../src/mission/props';
import { sniperAimPoints } from '../../src/mission/sniperDims';
import type { ThemeId } from '../../src/mission/themes';
import { createTerrainField } from '../../src/scene/terrainField';
import type { TerrainField } from '../../src/scene/terrainField';

export const THEMES: ThemeId[] = ['desert', 'arctic', 'valley'];
export const POSITIONS: FiringPosition[] = ['valley', 'ridge', 'mountain'];

export interface Mission {
  config: MissionConfig;
  field: TerrainField;
  layout: MissionLayout;
}

/** The largest mission (10 soldiers, 3 vehicle targets, 3 enemy snipers, many buildings and vehicles) at one firing position. */
export function bigMission(theme: ThemeId, seed: number, position: FiringPosition): Mission {
  const config = clampMission({
    ...DEFAULT_MISSION,
    theme,
    seed,
    position,
    rangeMin: 100,
    rangeMax: 1500,
    soldiers: 10,
    vehicleTargets: 3,
    buildings: 'many',
    vehicles: 'many',
    enemySnipers: 3,
  });
  const field = createTerrainField(theme, seed, position);
  return { config, field, layout: generateLayout(config, field) };
}

/** Every point the shooter must be able to see: soldiers' head and upper torso, vehicle engines, snipers' head and upper torso. */
export function aimPoints(layout: MissionLayout, field: TerrainField): Vec3[] {
  const out: Vec3[] = [];
  for (const s of layout.soldiers) {
    const a = soldierAimPoints(s, field);
    out.push(a.head, a.upperTorso);
  }
  for (const v of layout.vehicleTargets) out.push(vehicleEngineObstacle(v, field.height(v.x, v.z)).box.center);
  for (const s of layout.snipers) {
    const a = sniperAimPoints(s);
    out.push(a.head, a.upperTorso);
  }
  return out;
}

/** Scenery colliders only (the layout's own, which every aim point was validated against). */
export function sceneryObstacles(layout: MissionLayout, field: TerrainField): Obstacle[] {
  return layoutColliders(layout, field);
}

/** True when `extra` blocks none of the lines of sight that were open without it: returns the points it blocks (empty = fine). */
export function blockedByExtra(m: Mission, extra: Obstacle[]): Vec3[] {
  const base = sceneryObstacles(m.layout, m.field);
  const both = [...base, ...extra];
  return aimPoints(m.layout, m.field).filter(
    (p) => lineOfSightClear(m.field.shooter, p, m.field, base) && !lineOfSightClear(m.field.shooter, p, m.field, both),
  );
}
