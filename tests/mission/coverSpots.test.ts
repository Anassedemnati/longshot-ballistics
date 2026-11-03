import { describe, expect, it } from 'vitest';
import { segmentBox } from '../../src/game/hit';
import { CoverMap } from '../../src/mission/coverSpots';
import { DEFAULT_MISSION, clampMission } from '../../src/mission/config';
import { generateLayout, layoutColliders } from '../../src/mission/layout';
import { vehicleEngineObstacle } from '../../src/mission/props';
import { createRng } from '../../src/mission/random';
import { createTerrainField } from '../../src/scene/terrainField';

function mission(seed: number, soldiers = 6) {
  const config = clampMission({ ...DEFAULT_MISSION, seed, soldiers, rangeMin: 150, rangeMax: 400, buildings: 'many', vehicles: 'many', vehicleTargets: 1 });
  const field = createTerrainField(config.theme, config.seed, config.position);
  const layout = generateLayout(config, field);
  const obstacles = layoutColliders(layout, field);
  for (const v of layout.vehicleTargets) obstacles.push(vehicleEngineObstacle(v, field.height(v.x, v.z)));
  return { field, layout, map: new CoverMap(layout, field), obstacles };
}

describe('CoverMap', () => {
  it('finds cover spots round the props, each hidden from the shooter at crouch height and clear of every collider', () => {
    let total = 0;
    for (const seed of [1, 2, 3, 4, 5]) {
      const { field, layout, map, obstacles } = mission(seed);
      const generated = map.spots.slice(0, map.spots.length - layout.soldiers.length);
      total += generated.length;
      for (const s of generated) {
        const head = { x: s.x, y: field.height(s.x, s.z) + 1.0, z: s.z };
        expect(obstacles.some((o) => segmentBox(field.shooter, head, o.box) !== null), `spot ${s.x.toFixed(1)}, ${s.z.toFixed(1)} is hidden`).toBe(true);
        expect(s.hidden).toBe(true);
        // Not inside any collider's footprint.
        for (const o of obstacles) {
          const c = Math.cos(o.box.yaw);
          const sn = Math.sin(o.box.yaw);
          const dx = s.x - o.box.center.x;
          const dz = s.z - o.box.center.z;
          const lx = c * dx - sn * dz;
          const lz = sn * dx + c * dz;
          expect(Math.abs(lx) > o.box.halfSize.x + 0.3 || Math.abs(lz) > o.box.halfSize.z + 0.3).toBe(true);
        }
      }
    }
    expect(total).toBeGreaterThan(20);
  });

  it('gives every soldier a start spot, and a place to stand to shoot from every spot (over the cover or beside it) that the shooter can see', () => {
    const { field, layout, map, obstacles } = mission(7);
    expect(map.startSpots).toHaveLength(layout.soldiers.length);
    layout.soldiers.forEach((s, i) => {
      expect(map.spots[map.startSpots[i]].x).toBeCloseTo(s.x, 6);
    });
    for (const s of map.spots) {
      const px = s.x + s.peekX;
      const pz = s.z + s.peekZ;
      if (!s.hidden) continue;
      const head = { x: px, y: field.height(px, pz) + (s.peekStance === 'stand' ? 1.68 : 1.3), z: pz };
      expect(obstacles.some((o) => segmentBox(field.shooter, head, o.box) !== null), 'the peek position is in the shooter\'s view').toBe(false);
    }
  });

  it('routes round props: no leg of a path runs through a collider, and every path ends where it was asked to', () => {
    const rng = createRng(11);
    let detours = 0;
    for (const seed of [3, 4, 8]) {
      const { map, layout, obstacles } = mission(seed);
      for (let i = 0; i < 60; i++) {
        const a = layout.soldiers[Math.floor(rng() * layout.soldiers.length)];
        const b = map.spots[Math.floor(rng() * map.spots.length)];
        const p = map.path(a.x, a.z, b.x, b.z);
        expect(p[p.length - 2]).toBeCloseTo(b.x, 9);
        expect(p[p.length - 1]).toBeCloseTo(b.z, 9);
        if (p.length > 2) detours++;
        let cx = a.x;
        let cz = a.z;
        for (let k = 0; k < p.length; k += 2) {
          const from = { x: cx, y: 0.9, z: cz };
          const to = { x: p[k], y: 0.9, z: p[k + 1] };
          expect(obstacles.some((o) => segmentBox(from, to, o.box) !== null), `leg ${k / 2} of a path from soldier ${a.id}`).toBe(false);
          cx = p[k];
          cz = p[k + 1];
        }
      }
    }
    expect(detours).toBeGreaterThan(0); // some of those walks had to go round something
  });
});
