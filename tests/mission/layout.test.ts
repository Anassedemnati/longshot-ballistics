import { describe, expect, it } from 'vitest';
import { segmentBox } from '../../src/game/hit';
import type { Obstacle } from '../../src/game/hit';
import { DEFAULT_MISSION, clampMission, randomMission } from '../../src/mission/config';
import type { Density, MissionConfig } from '../../src/mission/config';
import { DUMMY_BOXES, DUMMY_HEAD, DUMMY_UPRIGHT, LOWER_TORSO_CY, UPPER_TORSO_CY } from '../../src/mission/dummyDims';
import {
  generateLayout,
  layoutColliders,
  legacyLayout,
  lineOfSightClear,
  soldierAimPoints,
  soldierUprightBounds,
} from '../../src/mission/layout';
import type { MissionLayout } from '../../src/mission/layout';
import { propColliders, propFootprintRadius, vehicleEngineObstacle, vehicleTargetColliders } from '../../src/mission/props';
import { createRng } from '../../src/mission/random';
import type { ThemeId } from '../../src/mission/themes';
import * as targetModule from '../../src/scene/target';
import { SECTOR_HALF_ANGLE_RAD, SECTOR_MAX_RANGE, createTerrainField } from '../../src/scene/terrainField';
import type { TerrainField } from '../../src/scene/terrainField';

const DEG = Math.PI / 180;
const THEMES: ThemeId[] = ['desert', 'arctic', 'valley'];

const base = (over: Partial<MissionConfig>): MissionConfig => clampMission({ ...DEFAULT_MISSION, ...over });
const bearingOf = (x: number, z: number): number => Math.atan2(x, -z);
const rangeOf = (x: number, z: number): number => Math.hypot(x, z);

/** Obstacles built independently of the generator from the public prop helpers. */
function independentObstacles(layout: MissionLayout, field: TerrainField): { cover: Obstacle[]; engines: Obstacle[] } {
  const cover: Obstacle[] = [];
  for (const p of layout.props) cover.push(...propColliders(p, field.height(p.x, p.z)));
  const engines: Obstacle[] = [];
  for (const v of layout.vehicleTargets) {
    const g = field.height(v.x, v.z);
    cover.push(...vehicleTargetColliders(v, g).body);
    engines.push(vehicleEngineObstacle(v, g));
  }
  return { cover, engines };
}

function bounds(layout: MissionLayout, field: TerrainField, except?: string): Obstacle[] {
  return layout.soldiers.filter((s) => s.id !== except).map((s) => soldierUprightBounds(s, field));
}

function setup(config: MissionConfig): { field: TerrainField; layout: MissionLayout } {
  const field = createTerrainField(config.theme, config.seed);
  return { field, layout: generateLayout(config, field) };
}

/** Everything the generator promises, checked from scratch. Returns how many soldiers are behind cover. */
function checkLayout(config: MissionConfig, field: TerrainField, layout: MissionLayout): number {
  expect(layout.soldiers).toHaveLength(config.soldiers);
  expect(layout.vehicleTargets).toHaveLength(config.vehicleTargets);

  const { cover, engines } = independentObstacles(layout, field);
  const eye = field.shooter;
  let behind = 0;

  for (const s of layout.soldiers) {
    expect(rangeOf(s.x, s.z)).toBeGreaterThanOrEqual(config.rangeMin - 1);
    expect(rangeOf(s.x, s.z)).toBeLessThanOrEqual(config.rangeMax + 1);
    expect(s.range).toBeCloseTo(rangeOf(s.x, s.z), 6);
    expect(Math.abs(bearingOf(s.x, s.z))).toBeLessThanOrEqual(SECTOR_HALF_ANGLE_RAD + 1e-9);

    const aim = soldierAimPoints(s, field);
    const obstacles = [...cover, ...engines, ...bounds(layout, field, s.id)];
    expect(lineOfSightClear(eye, aim.head, field, obstacles), `${s.id} head`).toBe(true);
    expect(lineOfSightClear(eye, aim.upperTorso, field, obstacles), `${s.id} upper torso`).toBe(true);

    if (s.behindCover) {
      behind++;
      expect(lineOfSightClear(eye, aim.lowerTorso, field, cover), `${s.id} lower torso blocked`).toBe(false);
    }
  }

  for (const v of layout.vehicleTargets) {
    expect(rangeOf(v.x, v.z)).toBeGreaterThanOrEqual(config.rangeMin - 1);
    expect(rangeOf(v.x, v.z)).toBeLessThanOrEqual(config.rangeMax + 1);
    expect(Math.abs(bearingOf(v.x, v.z))).toBeLessThanOrEqual(SECTOR_HALF_ANGLE_RAD + 1e-9);
    const g = field.height(v.x, v.z);
    const { engineCenter } = vehicleTargetColliders(v, g);
    const others = [...cover, ...engines.filter((e) => !e.id.startsWith(`${v.id}:`)), ...bounds(layout, field)];
    expect(lineOfSightClear(eye, engineCenter, field, others), `${v.id} engine`).toBe(true);
  }

  for (const p of layout.props) {
    expect(rangeOf(p.x, p.z)).toBeGreaterThanOrEqual(100);
    expect(rangeOf(p.x, p.z)).toBeLessThanOrEqual(SECTOR_MAX_RANGE);
    expect(Math.abs(bearingOf(p.x, p.z))).toBeLessThanOrEqual(SECTOR_HALF_ANGLE_RAD + 1e-9);
  }
  for (let i = 0; i < layout.props.length; i++) {
    for (let j = i + 1; j < layout.props.length; j++) {
      const a = layout.props[i];
      const b = layout.props[j];
      const gap = Math.hypot(a.x - b.x, a.z - b.z) - propFootprintRadius(a.kind) - propFootprintRadius(b.kind);
      expect(gap, `${a.id} vs ${b.id} footprints`).toBeGreaterThan(0);
    }
  }
  return behind;
}

const randomConfigs: MissionConfig[] = Array.from({ length: 30 }, (_, i) => {
  const rng = createRng(7000 + i);
  return randomMission(rng);
});

describe('aim points and line of sight', () => {
  it('aim points stand on the ground at the dummy zone heights', () => {
    const field = createTerrainField('desert', 1);
    const s = { id: 's', x: 20, z: -500, yaw: 0.1, range: 500.4, behindCover: false };
    const g = field.height(20, -500);
    const a = soldierAimPoints(s, field);
    expect(a.head).toEqual({ x: 20, y: g + DUMMY_HEAD.cy, z: -500 });
    expect(a.upperTorso).toEqual({ x: 20, y: g + UPPER_TORSO_CY, z: -500 });
    expect(a.lowerTorso).toEqual({ x: 20, y: g + LOWER_TORSO_CY, z: -500 });
  });

  it('target.ts re-exports the pure dummy dimensions (one source for mesh, hit spheres and layout)', () => {
    expect(targetModule.DUMMY_HEAD).toBe(DUMMY_HEAD);
    expect(targetModule.DUMMY_BOXES).toBe(DUMMY_BOXES);
  });

  it('the upright bounds are a box on the ground around the body, with the aim points inside', () => {
    const field = createTerrainField('desert', 1);
    const s = { id: 's', x: 20, z: -500, yaw: 0.4, range: 500.4, behindCover: false };
    const b = soldierUprightBounds(s, field);
    expect(b.box.halfSize).toEqual({ x: DUMMY_UPRIGHT.halfWidth, y: DUMMY_UPRIGHT.halfHeight, z: DUMMY_UPRIGHT.halfDepth });
    expect(b.box.yaw).toBe(0.4);
    expect(b.box.center.y).toBeCloseTo(field.height(20, -500) + 0.9, 9);
    const aim = soldierAimPoints(s, field);
    for (const p of [aim.head, aim.upperTorso, aim.lowerTorso]) expect(segmentBox(p, p, b.box)).toBe(0);
  });

  it('is blocked by a box on the line and by terrain, clear otherwise', () => {
    const flat: TerrainField = { theme: 'desert', height: () => 0, shooter: { x: 0, y: 2, z: 0 }, outcrops: [] };
    const from = { x: 0, y: 2, z: 0 };
    const to = { x: 0, y: 1, z: -300 };
    expect(lineOfSightClear(from, to, flat, [])).toBe(true);
    const wall: Obstacle = { id: 'w', material: 'wall', box: { center: { x: 0, y: 1, z: -150 }, halfSize: { x: 3, y: 1, z: 0.2 }, yaw: 0 } };
    expect(lineOfSightClear(from, to, flat, [wall])).toBe(false);
    const aside: Obstacle = { id: 'w2', material: 'wall', box: { center: { x: 10, y: 1, z: -150 }, halfSize: { x: 3, y: 1, z: 0.2 }, yaw: 0 } };
    expect(lineOfSightClear(from, to, flat, [aside])).toBe(true);
    const ridge: TerrainField = { ...flat, height: (_x, z) => (Math.abs(z + 100) < 10 ? 5 : 0) };
    expect(lineOfSightClear(from, to, ridge, [])).toBe(false);
    // A ridge behind the target does not matter.
    const behind: TerrainField = { ...flat, height: (_x, z) => (z < -400 ? 50 : 0) };
    expect(lineOfSightClear(from, to, behind, [])).toBe(true);
  });
});

describe('generateLayout', () => {
  it('honours every promise for 30 random configs (counts, bands, bearings, line of sight, cover, props)', () => {
    for (const config of randomConfigs) {
      const { field, layout } = setup(config);
      checkLayout(config, field, layout);
    }
  });

  it('honours the promises in the three range bands with a busy scene', () => {
    const bands: Array<[number, number]> = [
      [100, 200],
      [600, 1000],
      [1300, 1500],
    ];
    for (const [rangeMin, rangeMax] of bands) {
      for (let k = 0; k < 6; k++) {
        const config = base({
          theme: THEMES[k % 3],
          rangeMin,
          rangeMax,
          soldiers: 10,
          vehicleTargets: 3,
          buildings: 'many',
          vehicles: 'many',
          seed: 100 + k * 31,
        });
        const { field, layout } = setup(config);
        checkLayout(config, field, layout);
      }
    }
  });

  it('places soldiers at least 6 m apart when the band has room', () => {
    for (let k = 0; k < 10; k++) {
      const config = base({ rangeMin: 500, rangeMax: 900, soldiers: 10, buildings: 'many', vehicles: 'many', seed: 3000 + k });
      const { layout } = setup(config);
      for (let i = 0; i < layout.soldiers.length; i++) {
        for (let j = i + 1; j < layout.soldiers.length; j++) {
          const a = layout.soldiers[i];
          const b = layout.soldiers[j];
          expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(6);
        }
      }
    }
  });

  it('keeps soldiers and vehicle targets out of every prop and vehicle box', () => {
    for (const config of randomConfigs.slice(0, 12)) {
      const { field, layout } = setup(config);
      const { cover } = independentObstacles(layout, field);
      for (const s of layout.soldiers) {
        for (const o of cover) {
          const dx = s.x - o.box.center.x;
          const dz = s.z - o.box.center.z;
          const c = Math.cos(o.box.yaw);
          const sn = Math.sin(o.box.yaw);
          const lx = c * dx - sn * dz;
          const lz = sn * dx + c * dz;
          const inside = Math.abs(lx) < o.box.halfSize.x + 0.3 && Math.abs(lz) < o.box.halfSize.z + 0.3;
          expect(inside, `${s.id} inside ${o.id}`).toBe(false);
        }
      }
    }
  });

  it('soldiers face the shooter within 15 degrees', () => {
    for (const config of randomConfigs.slice(0, 10)) {
      const { layout } = setup(config);
      for (const s of layout.soldiers) {
        const facing = Math.atan2(-s.x, -s.z);
        let d = s.yaw - facing;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        expect(Math.abs(d)).toBeLessThanOrEqual(15 * DEG + 1e-9);
      }
    }
  });

  it('is deterministic: the same config gives a deep-equal layout, another seed a different one', () => {
    const config = base({ soldiers: 8, vehicleTargets: 2, buildings: 'many', vehicles: 'many', seed: 4242 });
    const a = setup(config).layout;
    const b = setup(config).layout;
    expect(b).toEqual(a);
    const other = setup({ ...config, seed: 4243 }).layout;
    expect(other).not.toEqual(a);
  });

  it('props follow the density counts (buildings = houses + walls + sheds, vehicles = trucks + jeeps), in every band', () => {
    const ranges: Record<Density, [number, number]> = { none: [0, 0], few: [3, 5], many: [8, 12] };
    const vranges: Record<Density, [number, number]> = { none: [0, 0], few: [2, 3], many: [5, 7] };
    const bands: Array<[number, number]> = [
      [400, 1100],
      [100, 100],
      [100, 105],
      [800, 800],
      [1500, 1500],
    ];
    for (const [rangeMin, rangeMax] of bands) {
      for (const buildings of ['none', 'few', 'many'] as const) {
        for (const vehicles of ['none', 'few', 'many'] as const) {
          for (let k = 0; k < 5; k++) {
            const config = base({ rangeMin, rangeMax, buildings, vehicles, soldiers: 5, seed: 900 + k * 13 });
            const { layout } = setup(config);
            const b = layout.props.filter((p) => p.kind === 'house' || p.kind === 'wall' || p.kind === 'shed').length;
            const v = layout.props.filter((p) => p.kind === 'truck' || p.kind === 'jeep').length;
            const label = `${rangeMin}-${rangeMax} buildings ${buildings} vehicles ${vehicles} seed ${k}`;
            expect(b, label).toBeGreaterThanOrEqual(ranges[buildings][0]);
            expect(b, label).toBeLessThanOrEqual(ranges[buildings][1]);
            expect(v, label).toBeGreaterThanOrEqual(vranges[vehicles][0]);
            expect(v, label).toBeLessThanOrEqual(vranges[vehicles][1]);
          }
        }
      }
    }
  });

  it('with many buildings and 10 soldiers in 600-1000 m at least 2 soldiers stand behind cover (every seed)', () => {
    for (let k = 0; k < 24; k++) {
      const config = base({
        theme: THEMES[k % 3],
        rangeMin: 600,
        rangeMax: 1000,
        soldiers: 10,
        buildings: 'many',
        vehicles: k % 2 === 0 ? 'many' : 'few',
        vehicleTargets: k % 3,
        seed: 500 + k * 17,
      });
      const { field, layout } = setup(config);
      const behind = checkLayout(config, field, layout);
      expect(behind, `seed ${config.seed}`).toBeGreaterThanOrEqual(2);
    }
  });

  it('cover also works close in and far out', () => {
    for (const [rangeMin, rangeMax] of [
      [100, 200],
      [1300, 1500],
    ] as const) {
      let total = 0;
      for (let k = 0; k < 8; k++) {
        const config = base({ rangeMin, rangeMax, soldiers: 10, buildings: 'many', vehicles: 'many', seed: 77 + k * 11 });
        const { field, layout } = setup(config);
        total += checkLayout(config, field, layout);
      }
      expect(total, `${rangeMin}-${rangeMax}`).toBeGreaterThan(0);
    }
  });

  it('places everything for the worst case (10 soldiers, 3 vehicle targets, many/many, band 800-800) in under 500 ms', () => {
    const config = base({ rangeMin: 800, rangeMax: 800, soldiers: 10, vehicleTargets: 3, buildings: 'many', vehicles: 'many', seed: 123 });
    const field = createTerrainField(config.theme, config.seed);
    const t0 = performance.now();
    const layout = generateLayout(config, field);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(500);
    expect(layout.soldiers).toHaveLength(10);
    expect(layout.vehicleTargets).toHaveLength(3);
    checkLayout(config, field, layout);
  });

  it('always places every target, even when 10 soldiers share a 100 m arc with no room for 6 m spacing', () => {
    const config = base({ rangeMin: 100, rangeMax: 100, soldiers: 10, vehicleTargets: 3, buildings: 'many', vehicles: 'many', seed: 5 });
    const { field, layout } = setup(config);
    checkLayout(config, field, layout);
  });

  it('crowded worst case (band 100-100, 10 soldiers, 3 vehicle targets, many/many): every soldier keeps line of sight and stands outside every box', () => {
    for (let k = 0; k < 36; k++) {
      const config = base({
        theme: THEMES[k % 3],
        rangeMin: 100,
        rangeMax: 100,
        soldiers: 10,
        vehicleTargets: 3,
        buildings: 'many',
        vehicles: 'many',
        seed: 3000 + k * 29,
      });
      const { field, layout } = setup(config);
      checkLayout(config, field, layout); // counts, bands, bearings, head and upper-torso line of sight, engines in view
      const { cover, engines } = independentObstacles(layout, field);
      for (const s of layout.soldiers) {
        const aim = soldierAimPoints(s, field);
        const g = field.height(s.x, s.z);
        for (const y of [g + 0.05, aim.lowerTorso.y, aim.upperTorso.y, aim.head.y]) {
          for (const o of [...cover, ...engines]) {
            expect(segmentBox({ x: s.x, y, z: s.z }, { x: s.x, y, z: s.z }, o.box), `${s.id} inside ${o.id} (seed ${config.seed})`).toBeNull();
          }
        }
      }
    }
  });

  it('with no props there is no cover; legacy config gives one soldier straight downrange', () => {
    const none = setup(base({ buildings: 'none', vehicles: 'none', soldiers: 6, seed: 9 })).layout;
    expect(none.props).toEqual([]);
    expect(none.soldiers.every((s) => !s.behindCover)).toBe(true);

    const legacy = base({ theme: 'desert', rangeMin: 800, rangeMax: 800, soldiers: 1, vehicleTargets: 0, buildings: 'none', vehicles: 'none', seed: 1 });
    const { layout } = setup(legacy);
    expect(layout.props).toEqual([]);
    expect(layout.vehicleTargets).toEqual([]);
    expect(layout.soldiers).toHaveLength(1);
    expect(layout.soldiers[0].x).toBe(0);
    expect(layout.soldiers[0].z).toBe(-800);
    expect(layout.soldiers[0].yaw).toBe(0);
    expect(layout.soldiers[0].range).toBe(800);
    expect(layout.soldiers[0].behindCover).toBe(false);
    expect(legacyLayout(legacy)).toEqual(layout);
  });

  it('layoutColliders returns the props plus the vehicle-target bodies (what the bullets must stop on)', () => {
    const config = base({ soldiers: 4, vehicleTargets: 2, buildings: 'many', vehicles: 'few', seed: 31 });
    const { field, layout } = setup(config);
    const mine = layoutColliders(layout, field);
    const theirs = independentObstacles(layout, field).cover;
    expect(mine.map((o) => o.id).sort()).toEqual(theirs.map((o) => o.id).sort());
  });
});
