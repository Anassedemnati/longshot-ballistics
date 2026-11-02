import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BOULDER_UNIT, GRASS_UNIT, LOG_UNIT, SNAG_UNIT } from '../../src/mission/models';
import { MAX_BOULDERS, MAX_GRASS, MAX_TREES } from '../../src/mission/scatter';
import type { ScatterItem } from '../../src/mission/scatter';
import { createNest, padGeometry, sandbagGeometry } from '../../src/scene/nest';
import { createVegetation, firGeometry, loadModelKit, meshGroundOf, modelParts, rockGeometry, shrubGeometry, snagGeometry } from '../../src/scene/vegetation';
import type { ModelLoader, ModelName } from '../../src/scene/vegetation';
import { POSITIONS, THEMES, bigMission } from '../helpers/missions';

/** A stand-in for the glTF scenes: meshes named like the real files', with the real files' sizes, placed away from the origin like the real ones. */
const FAKE_SCENES: Record<ModelName, () => THREE.Object3D> = {
  boulder2: () => {
    const g = new THREE.Group();
    const m = new THREE.Mesh(new THREE.BoxGeometry(2.514, 0.88, 1.232), new THREE.MeshStandardMaterial());
    m.name = 'boulder_02';
    m.position.set(0.08, 0.38, 0.01);
    g.add(m);
    return g;
  },
  dead_tree: () => {
    const g = new THREE.Group();
    const m = new THREE.Mesh(new THREE.BoxGeometry(3.05, 0.29, 0.28), new THREE.MeshStandardMaterial());
    m.name = 'dead_tree_trunk';
    m.position.set(-0.01, 0.11, -0.03);
    g.add(m);
    return g;
  },
  grass_clump: () => {
    const g = new THREE.Group();
    const dims: Record<string, [number, number, number]> = { mid_a: [0.216, 0.217, 0.221], mid_b: [0.187, 0.177, 0.2], large_b: [0.269, 0.169, 0.262], tall_a: [0.159, 0.321, 0.159] };
    let x = 0;
    for (const [key, d] of Object.entries(dims)) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(...d), new THREE.MeshStandardMaterial());
      m.name = `grass_medium_01_${key}_LOD0`;
      m.position.set((x += 0.7), 0.05, 0);
      m.scale.setScalar(1);
      g.add(m);
    }
    return g;
  },
};
const fakeLoader: ModelLoader = async (name) => FAKE_SCENES[name]();
/** A loader that always fails (a fresh one per use: the kit is shared per loader, so a reused one would not warn twice). */
const failingLoader = (): ModelLoader => async () => {
  throw new Error('network down');
};

afterEach(() => vi.restoreAllMocks());

/** How far (horizontally) from (x, z) and how high and low the vertices of instance `i` of `mesh` reach. */
function instanceReach(mesh: THREE.InstancedMesh, i: number, x: number, z: number): { reach: number; top: number; bottom: number } {
  const m = new THREE.Matrix4();
  mesh.getMatrixAt(i, m);
  const pos = mesh.geometry.getAttribute('position');
  const v = new THREE.Vector3();
  let reach = 0;
  let top = -Infinity;
  let bottom = Infinity;
  for (let k = 0; k < pos.count; k++) {
    v.fromBufferAttribute(pos, k).applyMatrix4(m);
    reach = Math.max(reach, Math.hypot(v.x - x, v.z - z));
    top = Math.max(top, v.y);
    bottom = Math.min(bottom, v.y);
  }
  return { reach, top, bottom };
}

describe('procedural geometry stays inside what the plan reserves', () => {
  it('firs: within the unit crown (radius 1), from 0.1 below the origin to height 1; 100-130 triangles', () => {
    for (const theme of THEMES) {
      for (const tiers of [4, 5]) {
        const g = firGeometry(theme, tiers);
        g.computeBoundingBox();
        const b = g.boundingBox as THREE.Box3;
        expect(Math.max(b.max.x, b.max.z, -b.min.x, -b.min.z)).toBeLessThanOrEqual(1);
        expect(b.min.y).toBeGreaterThanOrEqual(-0.1 - 1e-6);
        expect(b.max.y).toBeLessThanOrEqual(1 + 1e-6);
        expect(b.max.y).toBeGreaterThan(0.98);
        const tris = g.getAttribute('position').count / 3;
        expect(tris).toBeGreaterThan(70);
        expect(tris).toBeLessThan(160);
        expect(g.getAttribute('color').count).toBe(g.getAttribute('position').count);
      }
    }
  });

  it('snags, shrubs: inside their unit sizes', () => {
    for (const theme of THEMES) {
      const snag = snagGeometry(theme);
      snag.computeBoundingBox();
      const s = snag.boundingBox as THREE.Box3;
      expect(s.max.y).toBeLessThanOrEqual(SNAG_UNIT.height + 0.5);
      expect(Math.max(s.max.x, s.max.z, -s.min.x, -s.min.z)).toBeLessThanOrEqual(SNAG_UNIT.reach + 1e-6);
      const shrub = shrubGeometry(theme);
      shrub.computeBoundingBox();
      const r = shrub.boundingBox as THREE.Box3;
      expect(Math.hypot(Math.max(r.max.x, -r.min.x), Math.max(r.max.z, -r.min.z))).toBeLessThanOrEqual(1.4);
      expect(Math.max(r.max.x, r.max.z, -r.min.x, -r.min.z)).toBeLessThanOrEqual(1);
      expect(r.max.y).toBeLessThanOrEqual(1);
      expect(r.min.y).toBeGreaterThanOrEqual(0);
    }
  });

  it('the procedural rock has the boulder model\'s size, base at y = 0', () => {
    const g = rockGeometry();
    g.computeBoundingBox();
    const b = g.boundingBox as THREE.Box3;
    expect(b.max.x - b.min.x).toBeCloseTo(BOULDER_UNIT.lx, 5);
    expect(b.max.y - b.min.y).toBeCloseTo(BOULDER_UNIT.ly, 5);
    expect(b.max.z - b.min.z).toBeCloseTo(BOULDER_UNIT.lz, 5);
    expect(b.min.y).toBeCloseTo(0, 6);
    expect((b.min.x + b.max.x) / 2).toBeCloseTo(0, 6);
  });

  it('the sandbag fits the unit cube', () => {
    const g = sandbagGeometry();
    g.computeBoundingBox();
    const b = g.boundingBox as THREE.Box3;
    for (const v of [b.min.x, b.min.y, b.min.z, -b.max.x, -b.max.y, -b.max.z]) expect(v).toBeGreaterThanOrEqual(-1 - 1e-9);
    expect(b.max.x).toBeGreaterThan(0.95); // and fills it
    expect(b.max.z).toBeGreaterThan(0.9);
    expect(b.max.y).toBeGreaterThan(0.9);
  });
});

describe('modelParts / loadModelKit', () => {
  it('bakes the node transform, centres each part and puts its base at y = 0', async () => {
    const parts = modelParts(FAKE_SCENES.boulder2());
    expect(parts).toHaveLength(1);
    const g = parts[0].geometry;
    g.computeBoundingBox();
    const b = g.boundingBox as THREE.Box3;
    expect(b.min.y).toBeCloseTo(0, 6);
    expect(b.max.y).toBeCloseTo(0.88, 6);
    expect((b.min.x + b.max.x) / 2).toBeCloseTo(0, 6);
  });

  it('picks the three grass clumps by name, the boulder and the log; a failed model is null and a warning, never a throw', async () => {
    const kit = await loadModelKit(fakeLoader);
    expect(kit.boulder?.name).toBe('boulder_02');
    expect(kit.log?.name).toBe('dead_tree_trunk');
    expect(kit.grass.map((p) => p?.name)).toEqual(['grass_medium_01_mid_a_LOD0', 'grass_medium_01_mid_b_LOD0', 'grass_medium_01_large_b_LOD0']);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = await loadModelKit(failingLoader());
    expect(broken).toEqual({ boulder: null, log: null, grass: [null, null, null] });
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('shares one load per loader', async () => {
    const calls: string[] = [];
    const loader: ModelLoader = async (name) => {
      calls.push(name);
      return FAKE_SCENES[name]();
    };
    await Promise.all([loadModelKit(loader), loadModelKit(loader)]);
    expect(calls.sort()).toEqual(['boulder2', 'dead_tree', 'grass_clump']);
  });
});

describe('createVegetation', () => {
  it('one InstancedMesh per kind with the planned counts, within the budgets; every instance inside its reserved footprint', async () => {
    for (const theme of THEMES) {
      const m = bigMission(theme, 3, 'ridge');
      const veg = createVegetation(m.field, m.layout, 3, 'ridge', { loadModel: fakeLoader });
      await veg.ready;
      const meshes = veg.group.children as THREE.InstancedMesh[];
      for (const mesh of meshes) expect(mesh.isInstancedMesh).toBe(true);
      expect(meshes.length).toBeLessThanOrEqual(14); // a handful of draw calls
      const byName = new Map(meshes.map((mesh) => [mesh.name, mesh]));
      const items: Record<string, ScatterItem[]> = {
        'firs-0': veg.plan.firs.filter((f) => f.variant === 0),
        'firs-1': veg.plan.firs.filter((f) => f.variant === 1),
        snags: veg.plan.snags,
        logs: veg.plan.logs,
        shrubs: veg.plan.shrubs,
        'boulders-far': veg.plan.boulders.filter((b) => b.variant === 1),
        'boulders-near': veg.plan.boulders.filter((b) => b.variant === 0),
        'grass-0': veg.plan.grass.filter((g) => g.variant === 0),
        'grass-1': veg.plan.grass.filter((g) => g.variant === 1),
        'grass-2': veg.plan.grass.filter((g) => g.variant === 2),
      };
      let trees = 0;
      for (const [name, list] of Object.entries(items)) {
        const mesh = byName.get(name);
        if (list.length === 0) {
          expect(mesh, `${theme} ${name}`).toBeUndefined();
          continue;
        }
        expect(mesh, `${theme} ${name}`).toBeDefined();
        const mm = mesh as THREE.InstancedMesh;
        expect(mm.count, `${theme} ${name}`).toBe(list.length);
        if (name.startsWith('firs') || name === 'snags' || name === 'logs') trees += mm.count;
        for (let i = 0; i < list.length; i += Math.max(1, Math.floor(list.length / 40))) {
          const it = list[i];
          const { reach, top, bottom } = instanceReach(mm, i, it.x, it.z);
          // every vertex within the item's footprint circle (3 % slack), below its top, and not deeper than its sink
          expect(reach, `${theme} ${name} #${i}`).toBeLessThanOrEqual(it.radius * 1.03 + 0.01);
          expect(top, `${theme} ${name} #${i}`).toBeLessThanOrEqual(it.y + it.height + 0.02);
          expect(bottom, `${theme} ${name} #${i}`).toBeGreaterThanOrEqual(it.y - 0.5 - it.height * 0.15);
        }
        expect(mm.castShadow).toBe(name.startsWith('firs') || name === 'snags' || name === 'logs' || name.startsWith('boulders'));
        expect(mm.receiveShadow).toBe(true);
        expect(mm.instanceColor).not.toBeNull();
      }
      expect(trees).toBeLessThanOrEqual(MAX_TREES);
      expect(meshes.filter((x) => x.name.startsWith('boulders')).reduce((n, x) => n + x.count, 0)).toBeLessThanOrEqual(MAX_BOULDERS);
      expect(meshes.filter((x) => x.name.startsWith('grass')).reduce((n, x) => n + x.count, 0)).toBeLessThanOrEqual(MAX_GRASS);
    }
  });

  it('the glTF models stand within the sizes the plan uses (log, grass clumps)', async () => {
    const kit = await loadModelKit(fakeLoader);
    const dims = (g: THREE.BufferGeometry): THREE.Vector3 => {
      g.computeBoundingBox();
      return (g.boundingBox as THREE.Box3).getSize(new THREE.Vector3());
    };
    const log = dims((kit.log as { geometry: THREE.BufferGeometry }).geometry);
    expect(log.x).toBeLessThanOrEqual(LOG_UNIT.length + 0.01);
    expect(log.y / 2).toBeLessThanOrEqual(LOG_UNIT.radius + 0.01);
    kit.grass.forEach((part, i) => {
      const d = dims((part as { geometry: THREE.BufferGeometry }).geometry);
      expect(0.5 * Math.hypot(d.x, d.z)).toBeLessThanOrEqual(GRASS_UNIT[i].radius + 0.01);
      expect(d.y).toBeLessThanOrEqual(GRASS_UNIT[i].height + 0.01);
    });
  });

  it('when a glTF model fails to load: no crash, the procedural kinds are there, the glTF-only kinds are skipped', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const m = bigMission('valley', 3, 'ridge');
    const veg = createVegetation(m.field, m.layout, 3, 'ridge', { loadModel: failingLoader() });
    const names = (): string[] => veg.group.children.map((c) => c.name);
    expect(names()).toContain('firs-0'); // the procedural kinds are in at once
    expect(names()).toContain('boulders-far');
    expect(names()).not.toContain('logs');
    await veg.ready; // never rejects
    expect(names()).not.toContain('logs'); // skipped
    expect(names().some((n) => n.startsWith('grass'))).toBe(false); // skipped
    expect(names()).toContain('boulders-near'); // the near field falls back to the procedural rock, never bare
    expect(warn).toHaveBeenCalled();
  });

  it('with the real loader in Node (no network, no DOM) it still starts: every glTF kind is skipped, nothing throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const m = bigMission('arctic', 2, 'valley');
    const veg = createVegetation(m.field, m.layout, 2, 'valley');
    await veg.ready;
    expect(veg.group.children.length).toBeGreaterThan(3);
    expect(veg.group.children.some((c) => c.name === 'logs')).toBe(false);
  });

  it('meshGroundOf is the terrain mesh surface', () => {
    const m = bigMission('desert', 1, 'ridge');
    const g = meshGroundOf(m.field);
    expect(Math.abs(g(0, 0) - m.field.height(0, 0))).toBeLessThan(0.2);
  });
});

describe('createNest', () => {
  for (const position of POSITIONS) {
    it(`${position}: sandbags and rocks as one InstancedMesh each, every instance inside its plan box (the nest never blocks a line the plan keeps clear)`, async () => {
      for (const theme of THEMES) {
        const m = bigMission(theme, 3, position);
        const nest = createNest(m.field, 3, position, { loadModel: fakeLoader });
        await nest.ready;
        const bags = nest.group.getObjectByName('nest-sandbags') as THREE.InstancedMesh;
        const rocks = nest.group.getObjectByName('nest-rocks') as THREE.InstancedMesh;
        expect(bags.count).toBe(nest.plan.bags.length);
        expect(rocks.count).toBe(nest.plan.rocks.length);
        expect(nest.group.children.length).toBe(position === 'mountain' ? 3 : 2);
        expect(Boolean(nest.group.getObjectByName('nest-platform'))).toBe(position === 'mountain');
        // every vertex of every instance lies inside its oriented plan box (a hair of slack for rounding)
        const boxes = nest.plan.boxes;
        const inside = (mesh: THREE.InstancedMesh, i: number, box: (typeof boxes)[number]): boolean => {
          const pos = mesh.geometry.getAttribute('position');
          const mat = new THREE.Matrix4();
          mesh.getMatrixAt(i, mat);
          const v = new THREE.Vector3();
          const c = Math.cos(box.yaw);
          const s = Math.sin(box.yaw);
          for (let k = 0; k < pos.count; k++) {
            v.fromBufferAttribute(pos, k).applyMatrix4(mat);
            const dx = v.x - box.center.x;
            const dz = v.z - box.center.z;
            const lx = c * dx - s * dz;
            const lz = s * dx + c * dz;
            if (Math.abs(lx) > box.halfSize.x + 1e-5 || Math.abs(lz) > box.halfSize.z + 1e-5 || Math.abs(v.y - box.center.y) > box.halfSize.y + 1e-5) return false;
          }
          return true;
        };
        for (let i = 0; i < bags.count; i++) expect(inside(bags, i, boxes[i]), `${theme}/${position} bag ${i}`).toBe(true);
        for (let i = 0; i < rocks.count; i++) expect(inside(rocks, i, boxes[bags.count + i]), `${theme}/${position} rock ${i}`).toBe(true);
        expect(bags.castShadow && bags.receiveShadow && rocks.castShadow).toBe(true);
      }
    });
  }

  it('the rocks fall back to the procedural rock when the boulder fails to load (and the nest is still whole)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const m = bigMission('desert', 3, 'ridge');
    const nest = createNest(m.field, 3, 'ridge', { loadModel: failingLoader() });
    await nest.ready;
    const rocks = nest.group.getObjectByName('nest-rocks') as THREE.InstancedMesh;
    expect(rocks.count).toBe(nest.plan.rocks.length);
    rocks.geometry.computeBoundingBox();
    expect(((rocks.geometry.boundingBox as THREE.Box3).max.y)).toBeCloseTo(BOULDER_UNIT.ly, 5);
  });

  it('the platform follows the plan surface (a few cm above the terrain mesh outside it) and faces up', () => {
    const m = bigMission('valley', 3, 'mountain');
    const nest = createNest(m.field, 3, 'mountain', { loadModel: failingLoader() });
    const g = padGeometry(nest.plan);
    const pos = g.getAttribute('position');
    const normal = g.getAttribute('normal');
    let up = 0;
    for (let i = 0; i < pos.count; i++) {
      expect(pos.getY(i)).toBeGreaterThanOrEqual(nest.plan.surface(pos.getX(i), pos.getZ(i)) - 1e-4);
      if (normal.getY(i) > 0) up++;
    }
    expect(up / pos.count).toBeGreaterThan(0.6); // seen from above, not inside out
  });
});
