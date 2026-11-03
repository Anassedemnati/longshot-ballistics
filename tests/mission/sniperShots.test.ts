import { describe, expect, it } from 'vitest';
import { DEFAULT_MISSION, clampMission } from '../../src/mission/config';
import type { FiringPosition, MissionConfig } from '../../src/mission/config';
import { generateLayout, layoutColliders } from '../../src/mission/layout';
import { sniperAimPoints } from '../../src/mission/sniperDims';
import { themeAtmosphere } from '../../src/mission/themes';
import type { ThemeId } from '../../src/mission/themes';
import { createSniper } from '../../src/scene/sniper';
import { createTerrainField } from '../../src/scene/terrainField';
import { shootAtPointIn } from '../helpers/shootField';

const THEMES: ThemeId[] = ['desert', 'arctic', 'valley'];
/** The firing positions and the seeds tried from each (the ridge, the default, gets the most). */
const POSITION_SEEDS: ReadonlyArray<readonly [FiringPosition, readonly number[]]> = [
  ['ridge', [1, 2, 3, 4]],
  ['valley', [1, 2]],
  ['mountain', [1, 2]],
];

const base = (over: Partial<MissionConfig>): MissionConfig => clampMission({ ...DEFAULT_MISSION, ...over });

// The whole chain, end to end: the layout places snipers with a clear line of sight, the scene gives each
// one hit zones from the same dimensions, and a real bullet from the player's own position (the theme's
// air, the field's ground, every cover collider of the mission in the way) registers on them.
describe('real shots at placed snipers', () => {
  /** How many of the snipers shot at below lie on a roof, ridge strip or open ground (the hides are scored, so a case may have no roof at all). */
  const seen = { roof: 0, ridge: 0, open: 0 };

  for (const [position, seeds] of POSITION_SEEDS) {
    for (const theme of THEMES) {
      it(`${theme}, from the ${position}: a shot at each sniper's head or upper torso, from the player's position, hits him`, () => {
        let shots = 0;
        for (const seed of seeds) {
          const config = base({
            theme,
            rangeMin: 300,
            rangeMax: 800,
            soldiers: 3,
            vehicleTargets: 1,
            buildings: 'many',
            vehicles: 'few',
            enemySnipers: 3,
            position,
            seed,
          });
          const field = createTerrainField(theme, seed, position);
          const layout = generateLayout(config, field);
          const obstacles = layoutColliders(layout, field);
          const atmo = themeAtmosphere(theme);
          const targets = layout.snipers.map((s) => createSniper({ x: s.x, y: s.y, z: s.z }, s.yaw, s.id).hitTarget);
          for (const s of layout.snipers) {
            seen[s.site]++;
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
        expect(shots).toBe(seeds.length * 6);
      }, 60_000);
    }
  }

  it('covers every kind of hide over the cases above: shots at rooftop, ridge-strip and open-ground snipers all registered', () => {
    expect(seen.roof).toBeGreaterThan(0);
    expect(seen.ridge).toBeGreaterThan(0);
    expect(seen.open).toBeGreaterThan(0);
  });
});
