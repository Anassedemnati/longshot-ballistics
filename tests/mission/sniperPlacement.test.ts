import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/ballistics/types';
import type { Box, Obstacle } from '../../src/game/hit';
import { DEFAULT_MISSION, clampMission, randomMission } from '../../src/mission/config';
import type { FiringPosition, MissionConfig } from '../../src/mission/config';
import {
  facingYaw,
  generateLayout,
  layoutColliders,
  legacyLayout,
  lineOfSightClear,
  soldierAimPoints,
  soldierUprightBounds,
} from '../../src/mission/layout';
import type { MissionLayout, SniperPlacement } from '../../src/mission/layout';
import { backdropScore } from '../../src/mission/hide';
import { propColliders, rooftopSpot, vehicleEngineObstacle } from '../../src/mission/props';
import { createRng } from '../../src/mission/random';
import {
  SNIPER_PARTS,
  SNIPER_REACH,
  sniperAimPoints,
  sniperBoundsObstacle,
  sniperWorldPoint,
  sniperZones,
} from '../../src/mission/sniperDims';
import type { ThemeId } from '../../src/mission/themes';
import { SECTOR_HALF_ANGLE_RAD, SECTOR_MAX_RANGE, createTerrainField } from '../../src/scene/terrainField';
import type { TerrainField } from '../../src/scene/terrainField';

const THEMES: ThemeId[] = ['desert', 'arctic', 'valley'];
const POSITIONS: FiringPosition[] = ['valley', 'ridge', 'mountain'];
const BANDS: Array<[number, number]> = [
  [100, 160],
  [300, 300],
  [600, 1000],
  [1200, 1500],
];
const DEG = Math.PI / 180;

const base = (over: Partial<MissionConfig>): MissionConfig => clampMission({ ...DEFAULT_MISSION, ...over });

function setup(config: MissionConfig): { field: TerrainField; layout: MissionLayout } {
  const field = createTerrainField(config.theme, config.seed, config.position);
  return { field, layout: generateLayout(config, field) };
}

/** True when a point lies inside an oriented box (yaw only). */
function pointInBox(c: Vec3, box: Box): boolean {
  const cos = Math.cos(box.yaw);
  const sin = Math.sin(box.yaw);
  const dx = c.x - box.center.x;
  const dz = c.z - box.center.z;
  const lx = cos * dx - sin * dz;
  const lz = sin * dx + cos * dz;
  return Math.abs(lx) <= box.halfSize.x && Math.abs(c.y - box.center.y) <= box.halfSize.y && Math.abs(lz) <= box.halfSize.z;
}

/** Points on the surface of every body part (ellipsoid), in the body frame, from a fixed spiral. */
const BODY_SURFACE: Vec3[] = SNIPER_PARTS.flatMap((p) =>
  Array.from({ length: 120 }, (_, i) => {
    const t = (i + 0.5) / 120;
    const phi = Math.acos(1 - 2 * t);
    const theta = Math.PI * (1 + Math.sqrt(5)) * i;
    return {
      x: p.cx + p.rx * Math.sin(phi) * Math.cos(theta),
      y: p.cy + p.ry * Math.cos(phi),
      z: p.cz + p.rz * Math.sin(phi) * Math.sin(theta),
    };
  }),
);

/** Every collider the shooter's sight lines meet, built independently of the generator. */
function colliders(layout: MissionLayout, field: TerrainField): Obstacle[] {
  const out: Obstacle[] = [];
  for (const p of layout.props) out.push(...propColliders(p, field.height(p.x, p.z)));
  for (const v of layout.vehicleTargets) {
    const g = field.height(v.x, v.z);
    out.push(...layoutColliders({ ...layout, props: [], vehicleTargets: [v] }, field), vehicleEngineObstacle(v, g));
  }
  return out;
}

const bearingOf = (x: number, z: number): number => Math.atan2(Math.abs(x), -z);

/** Where on the house's roof a point lies, in the house's own frame (null when it is not over this house). */
function roofLocal(p: { x: number; z: number; yaw: number }, x: number, z: number): { lx: number; lz: number } {
  const c = Math.cos(p.yaw);
  const s = Math.sin(p.yaw);
  const dx = x - p.x;
  const dz = z - p.z;
  return { lx: c * dx - s * dz, lz: s * dx + c * dz };
}

/** Everything the placement promises, checked from scratch. */
function checkSnipers(config: MissionConfig, field: TerrainField, layout: MissionLayout): void {
  expect(layout.snipers).toHaveLength(config.enemySnipers);
  expect(new Set(layout.snipers.map((s) => s.id)).size).toBe(config.enemySnipers);
  const solid = colliders(layout, field);
  const eye = field.shooter;
  const soldierBounds = layout.soldiers.map((s) => soldierUprightBounds(s, field));
  const sniperBounds = layout.snipers.map((s) => sniperBoundsObstacle(s, s.id));
  const lo = Math.max(100, config.rangeMin - 150);
  const hi = Math.min(SECTOR_MAX_RANGE, config.rangeMax + 150);

  for (const s of layout.snipers) {
    const where = `${s.id} (${s.site}) at ${s.x.toFixed(1)}, ${s.z.toFixed(1)}`;
    expect(s.id).toMatch(/^sniper-\d+$/);
    expect(s.range, where).toBeCloseTo(Math.hypot(s.x, s.z), 6);
    expect(s.range, where).toBeGreaterThanOrEqual(lo - 1);
    expect(s.range, where).toBeLessThanOrEqual(hi + 1);
    expect(bearingOf(s.x, s.z), where).toBeLessThanOrEqual(SECTOR_HALF_ANGLE_RAD + 1e-9);
    expect(s.z, where).toBeLessThan(0);
    // Head toward the player, give or take a little.
    const off = Math.atan2(Math.sin(s.yaw - facingYaw(s.x, s.z)), Math.cos(s.yaw - facingYaw(s.x, s.z)));
    expect(Math.abs(off), where).toBeLessThanOrEqual(10 * DEG);

    // Where he lies: the ground, or the top of a house roof with the whole body on it.
    if (s.site === 'roof') {
      const house = layout.props.find((p) => {
        const spot = rooftopSpot(p.kind, SNIPER_REACH);
        if (!spot) return false;
        const { lx, lz } = roofLocal(p, s.x, s.z);
        return (
          Math.abs(lx - spot.cx) <= spot.halfX + 1e-9 &&
          Math.abs(lz - spot.cz) <= spot.halfZ + 1e-9 &&
          Math.abs(s.y - (field.height(p.x, p.z) + spot.top)) < 1e-9
        );
      });
      expect(house, `${where}: on the roof of a house`).toBeDefined();
    } else {
      expect(s.y, where).toBeCloseTo(field.height(s.x, s.z), 9);
    }

    // Not inside any collider: no point of the visible body and no hit-sphere centre is inside a box.
    const body = [...BODY_SURFACE.map((q) => sniperWorldPoint(s, q)), ...sniperZones(s).map((z) => z.center)];
    const inside = solid.find((o) => body.some((q) => pointInBox(q, o.box)));
    expect(inside?.id, `${where}: a body point inside a collider`).toBeUndefined();

    // Line of sight both ways between the player's eye and his head, past terrain, every collider and every soldier.
    const aim = sniperAimPoints(s);
    const others = [...solid, ...soldierBounds, ...sniperBounds.filter((b) => b.id !== `${s.id}:bounds`)];
    expect(lineOfSightClear(eye, aim.head, field, others), `${where}: eye -> head`).toBe(true);
    expect(lineOfSightClear(aim.head, eye, field, others), `${where}: head -> eye`).toBe(true);
    expect(lineOfSightClear(eye, aim.upperTorso, field, others), `${where}: eye -> upper torso`).toBe(true);
  }

  // A sniper never hides a soldier, a vehicle's engine, or another sniper from the shooter.
  for (const s of layout.soldiers) {
    const a = soldierAimPoints(s, field);
    const hiders = [...solid, ...soldierBounds.filter((b) => b.id !== `${s.id}:bounds`), ...sniperBounds];
    expect(lineOfSightClear(eye, a.head, field, hiders), `${s.id} head`).toBe(true);
    expect(lineOfSightClear(eye, a.upperTorso, field, hiders), `${s.id} upper torso`).toBe(true);
  }
  for (const s of layout.snipers) {
    const a = sniperAimPoints(s);
    const hiders = [...solid, ...soldierBounds, ...sniperBounds.filter((b) => b.id !== `${s.id}:bounds`)];
    expect(lineOfSightClear(eye, a.head, field, hiders), `${s.id} head`).toBe(true);
  }
}

describe('rooftopSpot', () => {
  it('a house has a roof to lie on, at the top of its roof slab, and nothing else does', () => {
    const house = rooftopSpot('house', SNIPER_REACH);
    expect(house).not.toBeNull();
    expect(house?.top).toBeCloseTo(3.4, 9);
    expect(house?.halfX).toBeGreaterThan(1.5);
    expect(house?.halfZ).toBeGreaterThan(1);
    for (const kind of ['wall', 'shed', 'truck', 'jeep'] as const) expect(rooftopSpot(kind, SNIPER_REACH), kind).toBeNull();
  });

  it('shrinks with the room the body needs', () => {
    const small = rooftopSpot('house', 0.5);
    const big = rooftopSpot('house', 2);
    expect(small && big && small.halfX > big.halfX).toBe(true);
    expect(rooftopSpot('house', 10)).toBeNull();
  });
});

describe('sniper placement', () => {
  it('puts no sniper in a 0-sniper mission, and the legacy range has none', () => {
    const config = base({ enemySnipers: 0 });
    expect(setup(config).layout.snipers).toEqual([]);
    expect(legacyLayout(config).snipers).toEqual([]);
  });

  it('places exactly the configured number (0, 1, 3) in every theme and band, with every promise intact', () => {
    for (const theme of THEMES) {
      for (const [rangeMin, rangeMax] of BANDS) {
        for (const enemySnipers of [0, 1, 3]) {
          for (const buildings of ['none', 'many'] as const) {
            const config = base({ theme, rangeMin, rangeMax, enemySnipers, buildings, vehicles: 'few', soldiers: 4, seed: 11 + enemySnipers });
            const { field, layout } = setup(config);
            checkSnipers(config, field, layout);
          }
        }
      }
    }
  });

  it('places three snipers with every promise intact from the valley and the mountain firing positions too', () => {
    for (const position of POSITIONS.filter((p) => p !== 'ridge')) {
      for (const theme of THEMES) {
        for (const [rangeMin, rangeMax] of BANDS) {
          for (const buildings of ['none', 'many'] as const) {
            const config = base({ theme, position, rangeMin, rangeMax, enemySnipers: 3, buildings, vehicles: 'few', soldiers: 4, seed: 31 });
            const { field, layout } = setup(config);
            checkSnipers(config, field, layout);
          }
        }
      }
    }
  });

  it('honours every promise for 40 random configs, snipers always at least one', () => {
    for (let i = 0; i < 40; i++) {
      const config = { ...randomMission(createRng(9100 + i)), enemySnipers: 1 + (i % 3) };
      const { field, layout } = setup(config);
      checkSnipers(config, field, layout);
    }
  });

  it('a busy scene with the largest mission still gets its snipers', () => {
    for (let k = 0; k < 6; k++) {
      const config = base({
        theme: THEMES[k % 3],
        rangeMin: 100,
        rangeMax: 1500,
        soldiers: 10,
        vehicleTargets: 3,
        buildings: 'many',
        vehicles: 'many',
        enemySnipers: 3,
        seed: 400 + k * 17,
      });
      const { field, layout } = setup(config);
      checkSnipers(config, field, layout);
    }
  });

  it('is deterministic: the same config gives the same layout, and the snipers do not move anything else', () => {
    for (const theme of THEMES) {
      const config = base({ theme, buildings: 'many', vehicles: 'many', enemySnipers: 3, soldiers: 5, vehicleTargets: 1, seed: 77 });
      const a = setup(config).layout;
      const b = setup(config).layout;
      expect(b).toEqual(a);
      const without = setup({ ...config, enemySnipers: 0 }).layout;
      expect(without.soldiers).toEqual(a.soldiers);
      expect(without.vehicleTargets).toEqual(a.vehicleTargets);
      expect(without.props).toEqual(a.props);
      // The first sniper of a 1-sniper mission is the first sniper of a 3-sniper mission.
      const one = setup({ ...config, enemySnipers: 1 }).layout;
      expect(one.snipers[0]).toEqual(a.snipers[0]);
    }
  });

  it('different seeds give different placements', () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 12; seed++) {
      const s = setup(base({ enemySnipers: 1, seed })).layout.snipers[0];
      seen.add(`${s.x.toFixed(2)},${s.z.toFixed(2)}`);
    }
    expect(seen.size).toBeGreaterThanOrEqual(10);
  });

  it('uses a roof where a roof is a good hide, and not otherwise: some roofs among the hides, never all of them', { timeout: 60_000 }, () => {
    const roofs = { valley: 0, ridge: 0, mountain: 0 };
    const total = { valley: 0, ridge: 0, mountain: 0 };
    for (const position of POSITIONS) {
      for (let seed = 1; seed <= 90; seed++) {
        const config = base({ theme: THEMES[seed % 3], position, rangeMin: 400, rangeMax: 700, buildings: 'many', vehicles: 'none', enemySnipers: 1, soldiers: 3, seed });
        const { field, layout } = setup(config);
        checkSnipers(config, field, layout);
        if (!layout.props.some((p) => p.kind === 'house')) continue;
        total[position]++;
        if (layout.snipers[0].site === 'roof') roofs[position]++;
      }
    }
    for (const position of POSITIONS) expect(total[position], position).toBeGreaterThan(60);
    // From the mountain the ground behind every roof is a backdrop and the houses are the hard cover: with houses about, roofs are the usual hide, but never the only one.
    expect(roofs.mountain / total.mountain).toBeGreaterThan(0.5);
    // From the ridge, where the valley walls make better hides, a roof is a minority pick but still happens; from the valley floor, where a roof stands against the sky, it is rare.
    expect(roofs.ridge).toBeGreaterThan(0);
    expect(roofs.ridge / total.ridge).toBeLessThan(0.6);
    expect(roofs.valley / total.valley).toBeLessThan(0.3);
    // Nowhere is a roof automatic any more, the mountain included.
    for (const position of POSITIONS) expect(roofs[position] / total[position], position).toBeLessThan(0.95);
  });

  it('picks varied hides: different seeds give different sites and spots, all three kinds of site turn up, and the bearing runs to both flanks', () => {
    const sites = new Set<string>();
    const spots = new Set<string>();
    const sides = new Set<number>();
    for (const position of POSITIONS) {
      for (let seed = 1; seed <= 40; seed++) {
        const theme = THEMES[seed % 3];
        const config = base({ theme, position, rangeMin: 400, rangeMax: 700, buildings: 'many', vehicles: 'few', enemySnipers: 1, soldiers: 3, seed });
        const s = setup(config).layout.snipers[0];
        sites.add(s.site);
        spots.add(`${position},${seed},${s.x.toFixed(1)},${s.z.toFixed(1)}`);
        sides.add(Math.sign(s.x));
      }
    }
    expect(sites).toEqual(new Set(['roof', 'ridge', 'open']));
    expect(spots.size).toBe(120);
    expect(sides).toEqual(new Set([-1, 1]));
  });

  it('a given seed always gives the same hide, and another seed (same everything else) gives another', () => {
    const at = (seed: number) => {
      const s = setup(base({ rangeMin: 400, rangeMax: 700, buildings: 'many', enemySnipers: 1, seed })).layout.snipers[0];
      return `${s.site}@${s.x.toFixed(2)},${s.z.toFixed(2)}`;
    };
    expect(at(7)).toBe(at(7));
    const seen = new Set<string>();
    for (let seed = 1; seed <= 20; seed++) seen.add(at(seed));
    expect(seen.size).toBeGreaterThanOrEqual(18);
  });

  it('hides them: on a ridge or mountain most are backed by the ground behind them, and from the ridge most lie well away from the soldiers', () => {
    let backed = 0;
    let apart = 0;
    let n = 0;
    let nRidge = 0;
    for (const position of ['ridge', 'mountain'] as const) {
      for (let seed = 1; seed <= 30; seed++) {
        const config = base({ theme: THEMES[seed % 3], position, rangeMin: 400, rangeMax: 700, buildings: 'few', vehicles: 'few', enemySnipers: 1, soldiers: 4, seed });
        const { field, layout } = setup(config);
        const s = layout.snipers[0];
        n++;
        if (backdropScore(field, field.shooter, sniperAimPoints(s).head) > -0.5) backed++;
        if (position !== 'ridge') continue;
        nRidge++;
        if (Math.min(...layout.soldiers.map((o) => Math.hypot(o.x - s.x, o.z - s.z))) >= 40) apart++;
      }
    }
    expect(backed / n).toBeGreaterThan(0.8);
    expect(apart / nRidge).toBeGreaterThan(0.8);
  });

  it('with no buildings the snipers lie on the ground: on high ground at the sector edge first, in the open when it is full', () => {
    const sites = new Set<string>();
    for (let seed = 1; seed <= 12; seed++) {
      const config = base({ buildings: 'none', vehicles: 'none', enemySnipers: 3, seed });
      const { layout } = setup(config);
      for (const s of layout.snipers) {
        expect(s.site).not.toBe('roof');
        sites.add(s.site);
      }
    }
    expect(sites.has('ridge')).toBe(true);
  });

  it('puts ridge snipers near the sector edge, on higher ground than the average of the strip they were picked from', () => {
    let checked = 0;
    for (let seed = 1; seed <= 16; seed++) {
      const config = base({ buildings: 'none', vehicles: 'none', enemySnipers: 1, seed });
      const { field, layout } = setup(config);
      const s = layout.snipers[0];
      if (s.site !== 'ridge') continue;
      checked++;
      expect(bearingOf(s.x, s.z)).toBeGreaterThanOrEqual(6 * DEG);
      // The strip: the same range window, bearings 6-12 degrees, either side.
      const rng = createRng(seed);
      let sum = 0;
      const n = 80;
      for (let i = 0; i < n; i++) {
        const range = Math.max(100, config.rangeMin - 150) + rng() * (config.rangeMax + 150 - Math.max(100, config.rangeMin - 150));
        const bearing = (rng() < 0.5 ? -1 : 1) * (6 + rng() * 6) * DEG;
        sum += field.height(range * Math.sin(bearing), -range * Math.cos(bearing));
      }
      expect(field.height(s.x, s.z)).toBeGreaterThanOrEqual(sum / n);
    }
    expect(checked).toBeGreaterThan(8);
  });

  it('keeps snipers apart and off the soldiers where the band has room', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const config = base({ rangeMin: 500, rangeMax: 900, soldiers: 6, enemySnipers: 3, buildings: 'few', seed });
      const { layout } = setup(config);
      const spots: Array<SniperPlacement | { x: number; z: number }> = [...layout.snipers, ...layout.soldiers];
      for (let i = 0; i < layout.snipers.length; i++) {
        for (let j = i + 1; j < spots.length; j++) {
          expect(Math.hypot(spots[i].x - spots[j].x, spots[i].z - spots[j].z)).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });
});

describe('sniper placement: fuzz', () => {
  it('200 seeds, every theme and firing position, snipers 1-3: no placement throws and every promise (line of sight both ways, clear of boxes, in the window) holds', { timeout: 120_000 }, () => {
    const sites = new Set<string>();
    for (let seed = 1; seed <= 200; seed++) {
      const theme = THEMES[seed % 3];
      const position = POSITIONS[Math.floor(seed / 3) % 3];
      const [rangeMin, rangeMax] = BANDS[seed % BANDS.length];
      const config = base({
        theme,
        position,
        rangeMin,
        rangeMax,
        enemySnipers: 1 + (seed % 3),
        soldiers: 2 + (seed % 5),
        vehicleTargets: seed % 2,
        buildings: (['none', 'few', 'many'] as const)[seed % 3],
        vehicles: 'few',
        seed: 5000 + seed * 13,
      });
      const { field, layout } = setup(config);
      checkSnipers(config, field, layout);
      for (const s of layout.snipers) sites.add(s.site);
    }
    expect(sites).toEqual(new Set(['roof', 'ridge', 'open']));
  });

  it('the crowded worst case (10 soldiers, 3 vehicle targets, 3 snipers, many/many) still places them, from every position, in every theme', { timeout: 120_000 }, () => {
    for (let k = 0; k < 27; k++) {
      const theme = THEMES[k % 3];
      const position = POSITIONS[Math.floor(k / 3) % 3];
      const config = base({
        theme,
        position,
        rangeMin: [100, 100, 800][Math.floor(k / 9)],
        rangeMax: [100, 1500, 800][Math.floor(k / 9)],
        soldiers: 10,
        vehicleTargets: 3,
        buildings: 'many',
        vehicles: 'many',
        enemySnipers: 3,
        seed: 900 + k * 31,
      });
      const { field, layout } = setup(config);
      checkSnipers(config, field, layout);
    }
  });

  it('keeps the other targets and props where they were: the snipers are placed last and move nothing', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const config = base({ theme: THEMES[seed % 3], position: POSITIONS[seed % 3], buildings: 'many', vehicles: 'many', enemySnipers: 3, soldiers: 5, vehicleTargets: 1, seed });
      const withSnipers = setup(config).layout;
      const without = setup({ ...config, enemySnipers: 0 }).layout;
      expect(without.soldiers).toEqual(withSnipers.soldiers);
      expect(without.vehicleTargets).toEqual(withSnipers.vehicleTargets);
      expect(without.props).toEqual(withSnipers.props);
    }
  });
});

describe('a short-range rifle keeps the enemy snipers within its reach', () => {
  it('the 12.7x55 subsonic never meets a sniper past its 250 m reach', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const config = clampMission({ ...DEFAULT_MISSION, rifle: '127s', rangeMin: 150, rangeMax: 250, enemySnipers: 3, seed });
      const { field, layout } = setup(config);
      expect(layout.snipers.length, `seed ${seed}`).toBeGreaterThan(0);
      for (const s of layout.snipers) {
        expect(Math.hypot(s.x - field.shooter.x, s.z - field.shooter.z), `seed ${seed}`).toBeLessThanOrEqual(251);
      }
    }
  });
});
