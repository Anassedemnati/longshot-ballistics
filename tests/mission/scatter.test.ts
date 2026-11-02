import { describe, expect, it } from 'vitest';
import { propColliders, propFootprintRadius, vehicleTargetColliders } from '../../src/mission/props';
import {
  EYE_CLEARANCE,
  EYE_CLEAR_RADIUS,
  LANE_MARGIN,
  LOW_SHRUB_HEIGHT,
  LOW_SHRUB_WIDTH,
  MAX_BOULDERS,
  MAX_GRASS,
  MAX_NEAR_BOULDERS,
  MAX_SHRUBS,
  MAX_TREES,
  SCATTER_BOUNDS,
  SECTOR_MARGIN,
  TARGET_MARGIN,
  TREE_LINE_M,
  allItems,
  makeMeshGround,
  planScatter,
  scatterBounds,
} from '../../src/mission/scatter';
import type { ScatterItem, ScatterPlan } from '../../src/mission/scatter';
import { NEST_AREA_RADIUS } from '../../src/mission/nestPlan';
import type { MissionLayout } from '../../src/mission/layout';
import { SNOW_LINES } from '../../src/scene/snowLine';
import { buildTerrainGeometry, terrainGridAxes } from '../../src/scene/terrain';
import { createTerrainField, sectorDistance } from '../../src/scene/terrainField';
import type { TerrainField } from '../../src/scene/terrainField';
import { POSITIONS, THEMES, bigMission, blockedByExtra } from '../helpers/missions';
import type { Mission } from '../helpers/missions';

const SEEDS = [1, 7, 20261101];

function plan(m: Mission, ground?: (x: number, z: number) => number): ScatterPlan {
  return planScatter({ field: m.field, layout: m.layout, seed: m.config.seed, position: m.config.position, ground });
}

/** Distance from a point to a segment, computed here independently of the module under test. */
function toSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const abx = bx - ax;
  const abz = bz - az;
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (pz - az) * abz) / (abx * abx + abz * abz)));
  return Math.hypot(px - ax - abx * t, pz - az - abz * t);
}

/** Distance from (x, z) to an oriented footprint rectangle (0 inside it), independent of the module under test. */
function toRect(x: number, z: number, cx: number, cz: number, hx: number, hz: number, yaw: number): number {
  const dx = x - cx;
  const dz = z - cz;
  const lx = dx * Math.cos(yaw) - dz * Math.sin(yaw);
  const lz = dx * Math.sin(yaw) + dz * Math.cos(yaw);
  return Math.hypot(Math.max(0, Math.abs(lx) - hx), Math.max(0, Math.abs(lz) - hz));
}

const TREES = (p: ScatterPlan): ScatterItem[] => [...p.firs, ...p.snags, ...p.logs];

describe('planScatter', () => {
  it('is deterministic for (seed, theme, position, layout), and varies with each of them', () => {
    const m = bigMission('valley', 5, 'ridge');
    const a = plan(m);
    expect(plan(m)).toEqual(a);
    expect(plan(bigMission('valley', 6, 'ridge')).firs[0]).not.toEqual(a.firs[0]);
    expect(plan(bigMission('arctic', 5, 'ridge')).firs[0]).not.toEqual(a.firs[0]);
    expect(plan(bigMission('valley', 5, 'mountain')).firs[0]).not.toEqual(a.firs[0]);
  });

  it('counts per theme: firs and grass where the brief wants them, dead trees and shrubs in the desert, boulders everywhere', () => {
    for (const theme of THEMES) {
      const p = plan(bigMission(theme, 3, 'ridge'));
      expect(TREES(p).length).toBeLessThanOrEqual(MAX_TREES);
      expect(p.boulders.length).toBeLessThanOrEqual(MAX_BOULDERS);
      expect(p.boulders.length).toBeGreaterThan(100);
      expect(p.boulders.filter((b) => b.variant === 0).length).toBeLessThanOrEqual(MAX_NEAR_BOULDERS);
      expect(p.grass.length).toBeLessThanOrEqual(MAX_GRASS);
      expect(p.shrubs.length).toBeLessThanOrEqual(MAX_SHRUBS);
      expect(p.shrubs.length).toBeGreaterThan(30);
      if (theme === 'desert') {
        expect(p.firs).toHaveLength(0); // no firs in the desert...
        expect(p.snags.length).toBeGreaterThan(15); // ...but dead trees
        expect(p.logs.length).toBeGreaterThan(10);
        expect(p.grass).toHaveLength(0);
      } else {
        expect(p.firs.length).toBeGreaterThan(300);
        expect(p.firs.some((f) => f.variant === 0) && p.firs.some((f) => f.variant === 1)).toBe(true);
      }
      if (theme === 'valley') expect(p.grass.length).toBeGreaterThan(600);
      else expect(p.grass).toHaveLength(0);
    }
  });

  it('firs grow on the slopes, denser with height, never above the tree line, never on a cliff', () => {
    for (const theme of ['arctic', 'valley'] as const) {
      for (const seed of SEEDS) {
        const m = bigMission(theme, seed, 'ridge');
        const ground = makeMeshGround(terrainGridAxes(), m.field.height);
        const p = plan(m, ground);
        const heights = p.firs.map((f) => ground(f.x, f.z));
        expect(TREE_LINE_M[theme], theme).toBe(SNOW_LINES[theme].line); // the trees stop where the terrain's snow begins
        expect(Math.max(...heights), `${theme} ${seed}`).toBeLessThanOrEqual(TREE_LINE_M[theme]);
        // most of the stands are well up the walls, hardly any on the flat floor
        expect(heights.filter((h) => h >= 10).length / heights.length).toBeGreaterThan(0.6);
        expect(heights.filter((h) => h < 3).length / heights.length).toBeLessThan(0.15);
        // and denser upslope than down: more firs between 10 and 60 m than under 10 m (the area is smaller, the density higher)
        expect(heights.filter((h) => h >= 30 && h < 60).length).toBeGreaterThan(heights.filter((h) => h < 10).length);
        for (const f of p.firs) {
          const slope = Math.hypot(ground(f.x + 1.5, f.z) - ground(f.x - 1.5, f.z), ground(f.x, f.z + 1.5) - ground(f.x, f.z - 1.5)) / 3;
          expect(slope).toBeLessThan(1.1);
        }
        // some on the near walls and some round the map's edges
        const dist = p.firs.map((f) => Math.hypot(f.x, f.z));
        expect(dist.filter((d) => d < 700).length).toBeGreaterThan(100);
        expect(dist.filter((d) => d > 1300).length).toBeGreaterThan(10);
      }
    }
  });

  for (const theme of THEMES) {
    for (const position of POSITIONS) {
      it(`${theme} / ${position}: every item keeps off the lines of sight, the targets, the props and the nest, and stands on the ground`, () => {
        for (const seed of SEEDS.slice(0, 2)) {
          const m = bigMission(theme, seed, position);
          const { field, layout } = m;
          const eye = field.shooter;
          const ground = makeMeshGround(terrainGridAxes(), field.height);
          const p = plan(m, ground);
          const targets: Array<{ x: number; z: number; r: number }> = [
            ...layout.soldiers.map((s) => ({ x: s.x, z: s.z, r: TARGET_MARGIN })),
            ...layout.vehicleTargets.map((v) => ({ x: v.x, z: v.z, r: Math.max(TARGET_MARGIN, propFootprintRadius(v.kind)) })),
            ...layout.snipers.map((s) => ({ x: s.x, z: s.z, r: TARGET_MARGIN })),
          ];
          expect(layout.snipers).toHaveLength(3);
          const rects = [
            ...layout.props.flatMap((q) => propColliders(q, field.height(q.x, q.z))),
            ...layout.vehicleTargets.flatMap((v) => vehicleTargetColliders(v, field.height(v.x, v.z)).body),
          ].map((o) => o.box);
          // trees and logs, and the shrubs that are not the low ones round the compounds, stay out of the sector too
          const tallKinds = new Set<ScatterItem>([...p.firs, ...p.snags, ...p.logs, ...p.shrubs.filter((sh) => sh.height > LOW_SHRUB_HEIGHT + 1e-9 || sh.radius > LOW_SHRUB_WIDTH * 1.15 + 1e-9)]);
          const bad: string[] = [];
          for (const it of allItems(p)) {
            const at = `(${it.x.toFixed(1)}, ${it.z.toFixed(1)}) r=${it.radius.toFixed(2)}`;
            const B = SCATTER_BOUNDS;
            if (it.x - it.radius < B.xMin || it.x + it.radius > B.xMax || it.z - it.radius < B.zMin || it.z + it.radius > B.zMax) bad.push(`${at} off the map`);
            if (!(it.radius > 0 && it.height > 0)) bad.push(`${at} no size`);
            if (it.y > ground(it.x, it.z) + 0.01 || it.y < ground(it.x, it.z) - 0.4 * it.height - 0.35) bad.push(`${at} not on the ground`);
            if (Math.hypot(it.x - eye.x, it.z - eye.z) < NEST_AREA_RADIUS + it.radius) bad.push(`${at} in the nest area`);
            for (const t of targets) {
              if (Math.hypot(it.x - t.x, it.z - t.z) < t.r + it.radius) bad.push(`${at} within ${t.r} m of a target`);
              if (toSegment(it.x, it.z, eye.x, eye.z, t.x, t.z) < it.radius + LANE_MARGIN) bad.push(`${at} on a line of sight`);
            }
            for (const box of rects) {
              if (toRect(it.x, it.z, box.center.x, box.center.z, box.halfSize.x, box.halfSize.z, box.yaw) < it.radius) bad.push(`${at} touches a prop`);
            }
            if (tallKinds.has(it) && sectorDistance(it.x, it.z) < it.radius + SECTOR_MARGIN) bad.push(`${at} (tall) in the engagement sector`);
            if (Math.hypot(it.x - eye.x, it.z - eye.z) < EYE_CLEAR_RADIUS && it.y + it.height > eye.y - EYE_CLEARANCE + 1e-9) bad.push(`${at} reaches the eye`);
          }
          expect(bad.slice(0, 5), `${theme}/${position}/${seed}`).toEqual([]);
        }
      });

      it(`${theme} / ${position}: with every item as a solid box, every target the shooter could see is still in his line of sight`, () => {
        for (const seed of SEEDS.slice(0, 2)) {
          const m = bigMission(theme, seed, position);
          const p = plan(m, makeMeshGround(terrainGridAxes(), m.field.height));
          expect(blockedByExtra(m, scatterBounds(p))).toEqual([]);
        }
      });
    }
  }

  it('items inside the engagement sector are small boulders, grass and low shrubs only (and low shrubs do stand round the compounds)', () => {
    const m = bigMission('valley', 3, 'valley');
    const p = plan(m);
    for (const it of allItems(p)) {
      if (sectorDistance(it.x, it.z) > 0) continue;
      expect(p.boulders.includes(it) || p.grass.includes(it) || p.shrubs.includes(it)).toBe(true);
      if (p.boulders.includes(it)) expect(it.sx).toBeLessThanOrEqual(1.0 * 1.15 + 1e-9);
      if (p.shrubs.includes(it)) {
        expect(it.height).toBeLessThanOrEqual(LOW_SHRUB_HEIGHT + 1e-9);
        expect(it.sx).toBeLessThanOrEqual(LOW_SHRUB_WIDTH + 1e-9);
      }
    }
    expect(allItems(p).some((it) => sectorDistance(it.x, it.z) === 0)).toBe(true); // grass does grow near the lanes
    const nearProps = (it: ScatterItem): boolean => m.layout.props.some((q) => Math.hypot(it.x - q.x, it.z - q.z) < 30);
    expect(m.layout.props.length).toBeGreaterThan(5);
    expect(p.shrubs.filter(nearProps).length).toBeGreaterThan(20); // shrubs round the compounds
    expect(p.boulders.filter(nearProps).length).toBeGreaterThan(20); // and boulders
  });

  it('works on a layout without props and without targets', () => {
    const field = createTerrainField('valley', 4, 'ridge');
    const layout: MissionLayout = { soldiers: [], vehicleTargets: [], snipers: [], props: [] };
    const p = planScatter({ field, layout, seed: 4, position: 'ridge' });
    expect(p.firs.length).toBeGreaterThan(300);
    expect(p.boulders.length).toBeGreaterThan(50);
  });
});

describe('makeMeshGround', () => {
  it('is the terrain mesh surface: the vertex heights at the vertices, the mesh triangles between them', () => {
    const field: TerrainField = createTerrainField('valley', 2, 'mountain');
    const axes = terrainGridAxes();
    const ground = makeMeshGround(axes, field.height);
    const geometry = buildTerrainGeometry(field);
    const pos = geometry.getAttribute('position');
    const index = geometry.getIndex();
    if (!index) throw new Error('no index');
    const nx = axes.xs.length;
    // vertices
    const nz = axes.zs.length;
    for (const [i, j] of [[Math.floor(nx / 2), Math.floor(nz / 2)], [Math.floor(nx / 3), Math.floor(nz / 5)], [5, 5], [nx - 2, Math.floor(nz / 2)]]) {
      const k = j * nx + i;
      expect(ground(pos.getX(k), pos.getZ(k))).toBeCloseTo(pos.getY(k), 4); // the mesh's buffers are float32
    }
    // interior points, against the mesh's own triangles (found independently through the index buffer)
    let checked = 0;
    for (let n = 0; n < 400; n++) {
      const x = -300 + ((n * 37) % 600) + 0.37;
      const z = -300 + ((n * 91) % 650) + 0.61;
      const i = axes.xs.findIndex((v, idx) => v <= x && x < axes.xs[idx + 1]);
      const j = axes.zs.findIndex((v, idx) => v <= z && z < axes.zs[idx + 1]);
      const first = (j * (nx - 1) + i) * 6;
      let y: number | null = null;
      for (let t = 0; t < 2 && y === null; t++) {
        const [a, b, c] = [index.getX(first + t * 3), index.getX(first + t * 3 + 1), index.getX(first + t * 3 + 2)];
        const d = (pos.getZ(b) - pos.getZ(c)) * (pos.getX(a) - pos.getX(c)) + (pos.getX(c) - pos.getX(b)) * (pos.getZ(a) - pos.getZ(c));
        const l1 = ((pos.getZ(b) - pos.getZ(c)) * (x - pos.getX(c)) + (pos.getX(c) - pos.getX(b)) * (z - pos.getZ(c))) / d;
        const l2 = ((pos.getZ(c) - pos.getZ(a)) * (x - pos.getX(c)) + (pos.getX(a) - pos.getX(c)) * (z - pos.getZ(c))) / d;
        const l3 = 1 - l1 - l2;
        if (l1 >= -1e-9 && l2 >= -1e-9 && l3 >= -1e-9) y = l1 * pos.getY(a) + l2 * pos.getY(b) + l3 * pos.getY(c);
      }
      expect(y).not.toBeNull();
      expect(ground(x, z)).toBeCloseTo(y as number, 3);
      checked++;
    }
    expect(checked).toBe(400);
  });

  it('falls back to the field height outside the grid, and differs from it on a steep coarse face', () => {
    const field = createTerrainField('desert', 1, 'ridge');
    const ground = makeMeshGround(terrainGridAxes(), field.height);
    expect(ground(5000, 5000)).toBe(field.height(5000, 5000));
    let worst = 0;
    for (let x = -1900; x < 1900; x += 37) for (let z = -2900; z < 900; z += 41) worst = Math.max(worst, Math.abs(ground(x, z) - field.height(x, z)));
    expect(worst).toBeGreaterThan(0.05); // the coarse grid really does differ from the field (that is why the scatter uses the mesh)
  });

  it('on the mountain the mesh tip lies metres below the field apex (the nest platform covers it)', () => {
    const field = createTerrainField('valley', 2, 'mountain');
    const ground = makeMeshGround(terrainGridAxes(), field.height);
    expect(field.height(0, 0) - ground(0, 0)).toBeGreaterThan(2);
  });
});
