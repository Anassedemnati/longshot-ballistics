import { describe, expect, it } from 'vitest';
import { DEFAULT_MISSION, clampMission } from '../../src/mission/config';
import type { MissionConfig } from '../../src/mission/config';
import { generateLayout, layoutColliders } from '../../src/mission/layout';
import { sniperAimPoints } from '../../src/mission/sniperDims';
import { themeAtmosphere } from '../../src/mission/themes';
import type { ThemeId } from '../../src/mission/themes';
import { createSniper } from '../../src/scene/sniper';
import { createTerrainField } from '../../src/scene/terrainField';
import { shootAtPointIn } from '../helpers/shootField';

const THEMES: ThemeId[] = ['desert', 'arctic', 'valley'];

const base = (over: Partial<MissionConfig>): MissionConfig => clampMission({ ...DEFAULT_MISSION, ...over });

// The whole chain, end to end: the layout places snipers with a clear line of sight, the scene gives each
// one hit zones from the same dimensions, and a real bullet from the player's own position (the theme's
// air, the field's ground, every cover collider of the mission in the way) registers on them.
describe('real shots at placed snipers', () => {
  for (const theme of THEMES) {
    it(`${theme}: a shot at each sniper's head or upper torso, from the player's position, hits him`, () => {
      let shots = 0;
      let roofs = 0;
      for (const seed of [1, 2, 3, 4]) {
        const config = base({
          theme,
          rangeMin: 300,
          rangeMax: 800,
          soldiers: 3,
          vehicleTargets: 1,
          buildings: 'many',
          vehicles: 'few',
          enemySnipers: 3,
          seed,
        });
        const field = createTerrainField(theme, seed);
        const layout = generateLayout(config, field);
        const obstacles = layoutColliders(layout, field);
        const atmo = themeAtmosphere(theme);
        const targets = layout.snipers.map((s) => createSniper({ x: s.x, y: s.y, z: s.z }, s.yaw, s.id).hitTarget);
        for (const s of layout.snipers) {
          if (s.site === 'roof') roofs++;
          const aim = sniperAimPoints(s);
          const head = shootAtPointIn({ field, atmo, targets, obstacles }, aim.head);
          expect(head, `${theme} seed ${seed} ${s.id} (${s.site}, ${s.range.toFixed(0)} m): head`).toHaveLength(1);
          expect(head[0]).toMatchObject({ kind: 'target', targetId: s.id, zone: 'head' });
          const torso = shootAtPointIn({ field, atmo, targets, obstacles }, aim.upperTorso);
          expect(torso, `${theme} seed ${seed} ${s.id} (${s.site}, ${s.range.toFixed(0)} m): upper torso`).toHaveLength(1);
          expect(torso[0], `${theme} seed ${seed} ${s.id} upper torso`).toMatchObject({ kind: 'target', targetId: s.id });
          shots += 2;
        }
      }
      expect(shots).toBe(24);
      expect(roofs).toBeGreaterThan(0);
    }, 60_000);
  }
});
