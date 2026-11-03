import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/ballistics/types';
import { segmentBox, segmentSphere } from '../../src/game/hit';
import { facingYaw } from '../../src/mission/layout';
import type { VehicleTargetPlacement } from '../../src/mission/layout';
import { propBoxes, toWorldBox, vehicleTargetBoxes, vehicleTargetColliders } from '../../src/mission/props';
import type { PropKind, PropPlacement } from '../../src/mission/props';
import { createRng } from '../../src/mission/random';
import type { ThemeId } from '../../src/mission/themes';
import { SmokeColumn } from '../../src/fx/smoke';
import { SPARK_LIFETIME, SparkSystem } from '../../src/fx/sparks';
import { createPropMesh, propParts } from '../../src/scene/props';
import { createSky } from '../../src/scene/sky';
import { FALL_DURATION, createTargetDummy, dummyHitSpheres } from '../../src/scene/target';
import { advance, bonesOf } from '../helpers/bones';
import { terrainHeight } from '../../src/scene/terrainHeight';
import { createVehicleTarget } from '../../src/scene/vehicleTarget';
import { shootAtPoint } from '../helpers/shoot';

const KINDS: PropKind[] = ['house', 'wall', 'shed', 'truck', 'jeep'];
const THEMES: ThemeId[] = ['desert', 'arctic', 'valley'];
const DEG = Math.PI / 180;

/** The 8 corners of a world-space oriented box. */
function boxCorners(b: ReturnType<typeof toWorldBox>): Vec3[] {
  const c = Math.cos(b.yaw);
  const s = Math.sin(b.yaw);
  const out: Vec3[] = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const lx = sx * b.halfSize.x;
        const lz = sz * b.halfSize.z;
        out.push({ x: b.center.x + c * lx + s * lz, y: b.center.y + sy * b.halfSize.y, z: b.center.z - s * lx + c * lz });
      }
    }
  }
  return out;
}

const dist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

function meshesOf(group: THREE.Group): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh);
  });
  return out;
}

/** World positions of every vertex of a mesh. */
function meshVertices(mesh: THREE.Mesh): Vec3[] {
  const pos = mesh.geometry.getAttribute('position');
  const out: Vec3[] = [];
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    out.push({ x: v.x, y: v.y, z: v.z });
  }
  return out;
}

/** True when the local-frame point lies in one of the boxes grown by `margin` m. */
function insideAnyBox(p: Vec3, boxes: ReadonlyArray<{ center: Vec3; halfSize: Vec3 }>, margin: number): boolean {
  return boxes.some(
    (b) =>
      Math.abs(p.x - b.center.x) <= b.halfSize.x + margin + 1e-6 &&
      Math.abs(p.y - b.center.y) <= b.halfSize.y + margin + 1e-6 &&
      Math.abs(p.z - b.center.z) <= b.halfSize.z + margin + 1e-6,
  );
}

describe('prop meshes are built from the collider boxes', () => {
  for (const theme of THEMES) {
    for (const kind of KINDS) {
      it(`${kind} (${theme}): every collider box is in exactly one mesh with its corners (1 mm); every other vertex stays within 3 cm of a collider or under the ground`, () => {
        const p: PropPlacement = { id: `p-${kind}`, kind, x: 37, z: -612, yaw: 0.7 };
        const groundY = 3.2;
        const group = createPropMesh(p, groundY, theme);
        group.updateMatrixWorld(true);
        const meshes = meshesOf(group);
        const boxes = propBoxes(kind);
        const expectedBoxes = boxes.map((b) => toWorldBox(b, p.x, p.z, p.yaw, groundY));

        boxes.forEach((_b, i) => {
          const holders = meshes.filter((m) => (m.userData.boxes as number[]).includes(i));
          expect(holders, `${kind} box ${i}`).toHaveLength(1);
          const have = meshVertices(holders[0]);
          for (const corner of boxCorners(expectedBoxes[i])) {
            expect(Math.min(...have.map((h) => dist(h, corner))), `${kind} box ${i} corner`).toBeLessThan(0.001);
          }
        });

        // Every vertex of every mesh (collider boxes and decorations alike): within 3 cm of a collider, or below the ground.
        const local = new THREE.Vector3();
        for (const m of meshes) {
          const pos = m.geometry.getAttribute('position');
          for (let i = 0; i < pos.count; i++) {
            local.fromBufferAttribute(pos, i); // the meshes sit at the group's origin: geometry coordinates are the prop frame
            const ok = local.y <= 1e-6 || insideAnyBox({ x: local.x, y: local.y, z: local.z }, boxes, 0.03);
            expect(ok, `${kind} mesh "${m.name}" vertex ${i} (${local.x.toFixed(3)}, ${local.y.toFixed(3)}, ${local.z.toFixed(3)}) sticks out of the colliders`).toBe(true);
          }
        }
      });

      it(`${kind} (${theme}): every decoration part lies within one collider box (+3 cm) or entirely below the ground; the collider parts are the boxes`, () => {
        const boxes = propBoxes(kind);
        const parts = propParts(kind, theme);
        expect(parts.filter((q) => q.box !== undefined).map((q) => q.box)).toEqual(boxes.map((_b, i) => i));
        for (const q of parts) {
          if (q.box !== undefined) {
            expect(q.center).toEqual(boxes[q.box].center);
            expect(q.half).toEqual(boxes[q.box].halfSize);
            continue;
          }
          const lo = { x: q.center.x - q.half.x, y: q.center.y - q.half.y, z: q.center.z - q.half.z };
          const hi = { x: q.center.x + q.half.x, y: q.center.y + q.half.y, z: q.center.z + q.half.z };
          if (hi.y <= 1e-9) continue; // the foundation skirt: entirely under the ground
          const fits = boxes.some((b) => insideAnyBox(lo, [b], 0.03) && insideAnyBox(hi, [b], 0.03));
          expect(fits, `${kind} (${theme}) decoration "${q.name}" is not inside a single collider box + 3 cm`).toBe(true);
          expect(q.half.x > 0 && q.half.y > 0 && q.half.z > 0, `${q.name} is flat`).toBe(true);
        }
      });
    }
  }

  // A prop costs one draw call per mesh plus one more per shadow caster. Before the realism pass a prop was a mesh per
  // box and per decoration (house 10, wall 3, shed 6, truck 16, jeep 14, shadows included); with far more detail it is now:
  const BUDGET: Record<PropKind, number> = { house: 7, wall: 2, shed: 7, truck: 7, jeep: 6 };
  for (const kind of KINDS) {
    it(`${kind}: at most ${BUDGET[kind]} draw calls (meshes + shadow casters)`, () => {
      for (const theme of THEMES) {
        const g = createPropMesh({ id: `d-${kind}`, kind, x: 0, z: -300, yaw: 0 }, 0, theme);
        const meshes = meshesOf(g);
        const calls = meshes.length + meshes.filter((m) => m.castShadow).length;
        expect(calls, `${kind} (${theme})`).toBeLessThanOrEqual(BUDGET[kind]);
        expect(meshes.length, `${kind} (${theme}) meshes`).toBeLessThanOrEqual(6);
      }
    });
  }

  it('the largest mission (12 buildings: all houses at worst, 7 trucks, 3 vehicle targets) stays far inside the 400 draw call budget', () => {
    const calls = (kind: PropKind): number => {
      const meshes = meshesOf(createPropMesh({ id: `l-${kind}`, kind, x: 0, z: -300, yaw: 0 }, 0, 'valley'));
      return meshes.length + meshes.filter((m) => m.castShadow).length;
    };
    const worst = 12 * Math.max(calls('house'), calls('shed'), calls('wall')) + 10 * Math.max(calls('truck'), calls('jeep'));
    expect(worst).toBeLessThan(200);
  });

  it('sits at the placement (position and yaw) and shares geometry and materials between instances', () => {
    const a = createPropMesh({ id: 'a', kind: 'house', x: 10, z: -300, yaw: 0.4 }, 1, 'desert');
    const b = createPropMesh({ id: 'b', kind: 'house', x: -20, z: -500, yaw: 1.1 }, 2, 'desert');
    expect(a.position.x).toBe(10);
    expect(a.position.y).toBe(1);
    expect(a.position.z).toBe(-300);
    expect(a.rotation.y).toBeCloseTo(0.4, 12);
    // Many houses: one geometry per class and lightness shade (3 shades), one material per class.
    const many = Array.from({ length: 12 }, (_, i) => createPropMesh({ id: `h${i}`, kind: 'house', x: i, z: -300, yaw: 0 }, 0, 'desert'));
    const all = [a, b, ...many].flatMap(meshesOf);
    expect(new Set(all.map((m) => m.geometry)).size).toBeLessThanOrEqual(5 * 3);
    expect(new Set(all.map((m) => m.material)).size).toBeLessThanOrEqual(5);
    const again = createPropMesh({ id: 'a', kind: 'house', x: 0, z: -300, yaw: 0 }, 0, 'desert');
    for (const m of meshesOf(again)) {
      const twin = meshesOf(a).find((x) => x.userData.part === m.userData.part) as THREE.Mesh;
      expect(m.geometry).toBe(twin.geometry);
      expect(m.material).toBe(twin.material);
    }
  });

  it('palettes differ per theme: house walls and roofs are coloured by theme', () => {
    const colour = (theme: ThemeId, part: string): number => {
      const g = createPropMesh({ id: 'h', kind: 'house', x: 0, z: -300, yaw: 0 }, 0, theme);
      const m = meshesOf(g).find((x) => x.userData.part === part) as THREE.Mesh;
      return (m.material as THREE.MeshStandardMaterial).color.getHex();
    };
    for (const part of ['wall', 'roof']) {
      expect(new Set(THEMES.map((t) => colour(t, part))).size).toBe(3);
    }
    // arctic roofs are white-ish (bright, low saturation), valley roofs red
    const arctic = new THREE.Color(colour('arctic', 'roof'));
    expect(arctic.r).toBeGreaterThan(0.5);
    const valley = new THREE.Color(colour('valley', 'roof'));
    expect(valley.r).toBeGreaterThan(valley.g * 1.8);
  });

  it('every geometry has the attributes the materials need: positions, normals, UVs and vertex colours (a missing colour attribute draws black)', () => {
    for (const theme of THEMES) {
      for (const kind of KINDS) {
        const g = createPropMesh({ id: `a-${kind}`, kind, x: 0, z: -300, yaw: 0 }, 0, theme);
        for (const m of meshesOf(g)) {
          for (const name of ['position', 'normal', 'uv', 'color']) expect(m.geometry.getAttribute(name), `${kind} ${m.name} ${name}`).toBeDefined();
          const count = m.geometry.getAttribute('position').count;
          expect(m.geometry.getAttribute('color').count).toBe(count);
          const n = m.geometry.getAttribute('normal');
          for (let i = 0; i < count; i++) expect(Math.hypot(n.getX(i), n.getY(i), n.getZ(i))).toBeCloseTo(1, 5);
        }
      }
    }
  });

  it('triangles face outwards (counter-clockwise from outside): the geometric normal agrees with the stored normal', () => {
    for (const kind of KINDS) {
      const g = createPropMesh({ id: `w-${kind}`, kind, x: 0, z: -300, yaw: 0 }, 0, 'desert');
      for (const m of meshesOf(g)) {
        const pos = m.geometry.getAttribute('position');
        const nor = m.geometry.getAttribute('normal');
        const idx = m.geometry.getIndex();
        expect(idx).not.toBeNull();
        const a = new THREE.Vector3();
        const b = new THREE.Vector3();
        const c = new THREE.Vector3();
        let bad = 0;
        const index = idx as THREE.BufferAttribute;
        for (let t = 0; t < index.count; t += 3) {
          a.fromBufferAttribute(pos, index.getX(t));
          b.fromBufferAttribute(pos, index.getX(t + 1));
          c.fromBufferAttribute(pos, index.getX(t + 2));
          const geo = b.clone().sub(a).cross(c.clone().sub(a));
          if (geo.lengthSq() < 1e-14) continue; // a degenerate sliver
          const n = new THREE.Vector3().fromBufferAttribute(nor, index.getX(t)).add(new THREE.Vector3().fromBufferAttribute(nor, index.getX(t + 1))).add(new THREE.Vector3().fromBufferAttribute(nor, index.getX(t + 2)));
          if (geo.dot(n) <= 0) bad++;
        }
        expect(bad, `${kind} ${m.name}: triangles facing inwards`).toBe(0);
      }
    }
  });
});

describe('vehicle targets', () => {
  const place = (kind: 'truck' | 'jeep', x: number, z: number, yaw: number): VehicleTargetPlacement => ({
    id: `v-${kind}`,
    kind,
    x,
    z,
    yaw,
    range: Math.hypot(x, z),
  });
  const localOf = (v: VehicleTargetPlacement, groundY: number, p: Vec3): Vec3 => {
    const c = Math.cos(v.yaw);
    const s = Math.sin(v.yaw);
    const dx = p.x - v.x;
    const dz = p.z - v.z;
    return { x: c * dx - s * dz, y: p.y - groundY, z: s * dx + c * dz };
  };

  for (const kind of ['truck', 'jeep'] as const) {
    describe(kind, () => {
      const v = place(kind, 12, -420, 0.9);
      const groundY = terrainHeight(v.x, v.z);
      const target = createVehicleTarget(v, groundY, 'desert');
      const { engine, body } = vehicleTargetBoxes(kind);

      it('has engine zones only, inside the engine box (+3 cm), with the broad-phase bounds around all of them', () => {
        const { zones, bounds } = target.hitTarget;
        expect(target.hitTarget.id).toBe(v.id);
        expect(zones.length).toBeGreaterThan(50);
        for (const z of zones) {
          expect(z.name).toBe('engine');
          const l = localOf(v, groundY, z.center);
          expect(Math.abs(l.x - engine.center.x) + z.radius).toBeLessThanOrEqual(engine.halfSize.x + 0.03 + 1e-9);
          expect(Math.abs(l.y - engine.center.y) + z.radius).toBeLessThanOrEqual(engine.halfSize.y + 0.03 + 1e-9);
          expect(Math.abs(l.z - engine.center.z) + z.radius).toBeLessThanOrEqual(engine.halfSize.z + 0.03 + 1e-9);
          if (bounds) expect(dist(z.center, bounds.center) + z.radius + 0.05 - 1e-9).toBeLessThanOrEqual(bounds.radius);
        }
        expect(bounds).toBeDefined();
        const { engineCenter } = vehicleTargetColliders(v, groundY);
        expect(dist(bounds?.center as Vec3, engineCenter)).toBeLessThan(0.01);
      });

      it('body obstacles are the metal body boxes and do not overlap the engine box', () => {
        expect(target.obstacles).toEqual(vehicleTargetColliders(v, groundY).body);
        expect(target.obstacles).toHaveLength(body.length);
        const engineWorld = toWorldBox(engine, v.x, v.z, v.yaw, groundY);
        for (const o of target.obstacles) {
          expect(o.material).toBe('metal');
          // Shrink the engine box a hair: boxes that only touch do not overlap.
          const shrunk = { ...engineWorld, halfSize: { x: engine.halfSize.x - 1e-4, y: engine.halfSize.y - 1e-4, z: engine.halfSize.z - 1e-4 } };
          for (const corner of boxCorners(shrunk)) {
            expect(segmentBox(corner, corner, o.box), `${o.id} contains an engine corner`).toBeNull();
          }
        }
      });

      it('covers the front, the two sides and the top of the engine block completely: every face point, every edge line and every corner is inside a zone', () => {
        const zones = target.hitTarget.zones;
        const e = engine;
        const miss: string[] = [];
        const n = 48;
        const inside = (lx: number, ly: number, lz: number): boolean => {
          const c = Math.cos(v.yaw);
          const s = Math.sin(v.yaw);
          const w = { x: v.x + c * lx + s * lz, y: groundY + ly, z: v.z - s * lx + c * lz };
          return zones.some((z) => dist(z.center, w) <= z.radius);
        };
        const { x: hx, y: hy, z: hz } = e.halfSize;
        const lo = { x: e.center.x - hx, y: e.center.y - hy, z: e.center.z - hz };
        const front = e.center.z + hz;
        const top = e.center.y + hy;
        // Whole faces, borders included (no inset).
        for (let i = 0; i <= n; i++) {
          for (let j = 0; j <= n; j++) {
            const x = lo.x + (i / n) * 2 * hx;
            const y = lo.y + (j / n) * 2 * hy;
            const z = lo.z + (j / n) * 2 * hz;
            if (!inside(x, y, front)) miss.push(`front ${x.toFixed(3)},${y.toFixed(3)}`);
            if (!inside(e.center.x + hx, y, z)) miss.push(`+x side ${y.toFixed(3)},${z.toFixed(3)}`);
            if (!inside(e.center.x - hx, y, z)) miss.push(`-x side ${y.toFixed(3)},${z.toFixed(3)}`);
            if (!inside(x, top, z)) miss.push(`top ${x.toFixed(3)},${z.toFixed(3)}`);
          }
        }
        // Every box edge that borders a covered face (all but the back-bottom one), every 2 mm along its length.
        const covered = (axis: 'x' | 'y' | 'z', sign: number): boolean => axis === 'x' || sign > 0; // +Z front, +Y top, both sides
        const axes = ['x', 'y', 'z'] as const;
        for (const w of axes) {
          const [u, t] = axes.filter((a) => a !== w);
          for (const su of [-1, 1]) {
            for (const st of [-1, 1]) {
              if (!covered(u, su) && !covered(t, st)) continue;
              const steps = Math.round((2 * e.halfSize[w]) / 0.002);
              for (let k = 0; k <= steps; k++) {
                const p = { x: 0, y: 0, z: 0 };
                p[u] = e.center[u] + su * e.halfSize[u];
                p[t] = e.center[t] + st * e.halfSize[t];
                p[w] = e.center[w] - e.halfSize[w] + (k / steps) * 2 * e.halfSize[w];
                if (!inside(p.x, p.y, p.z)) miss.push(`edge ${w} (${su},${st}) at ${p[w].toFixed(3)}`);
              }
            }
          }
        }
        // All eight corners.
        for (const sx of [-1, 1]) {
          for (const sy of [-1, 1]) {
            for (const sz of [-1, 1]) {
              if (!inside(e.center.x + sx * hx, e.center.y + sy * hy, e.center.z + sz * hz)) miss.push(`corner ${sx},${sy},${sz}`);
            }
          }
        }
        expect(miss).toEqual([]);
      });

      it('a segment entering the engine block through the front, a side or the top (edges and corners included) always touches a zone at the entry', () => {
        const rng = createRng(77);
        const { zones } = target.hitTarget;
        const worldBox = toWorldBox(engine, v.x, v.z, v.yaw, groundY);
        let checked = 0;
        let nearEdge = 0;
        const check = (from: Vec3, aim: Vec3, label: string): void => {
          const u0 = segmentBox(from, aim, worldBox);
          if (u0 === null || u0 === 0) return;
          const entry = { x: from.x + (aim.x - from.x) * u0, y: from.y + (aim.y - from.y) * u0, z: from.z + (aim.z - from.z) * u0 };
          const l = localOf(v, groundY, entry);
          const rx = l.x - engine.center.x;
          const ry = l.y - engine.center.y;
          const rz = l.z - engine.center.z;
          const eps = 1e-6;
          const onFront = Math.abs(rz - engine.halfSize.z) < eps;
          const onSide = Math.abs(Math.abs(rx) - engine.halfSize.x) < eps;
          const onTop = Math.abs(ry - engine.halfSize.y) < eps;
          // The entry point lies on a covered face: the front, a side or the top (the back and the bottom are not covered).
          if (!(onFront || onSide || onTop)) return;
          checked++;
          const margin = Math.min(engine.halfSize.x - Math.abs(rx), engine.halfSize.y - Math.abs(ry), engine.halfSize.z - Math.abs(rz));
          if (margin < 0.03) nearEdge++;
          let uMin: number | null = null;
          for (const z of zones) {
            const u = segmentSphere(from, aim, z.center, z.radius);
            if (u !== null && (uMin === null || u < uMin)) uMin = u;
          }
          expect(uMin, `${label} slipped through`).not.toBeNull();
          expect(uMin as number).toBeLessThanOrEqual(u0 + 1e-9);
        };
        const fromAbove = (aim: Vec3, az: number, el: number): Vec3 => ({
          x: aim.x + 6 * Math.cos(el) * Math.sin(az),
          y: aim.y + 6 * Math.sin(el),
          z: aim.z + 6 * Math.cos(el) * Math.cos(az),
        });
        for (let k = 0; k < 600; k++) {
          // From a random direction in the upper half-space, aimed at a random point inside the block.
          const az = rng() * 2 * Math.PI;
          const el = (rng() * 70 + 2) * DEG;
          const aim = {
            x: worldBox.center.x + (rng() * 2 - 1) * engine.halfSize.x * 0.8,
            y: worldBox.center.y + (rng() * 2 - 1) * engine.halfSize.y * 0.8,
            z: worldBox.center.z + (rng() * 2 - 1) * engine.halfSize.z * 0.8,
          };
          check(fromAbove(aim, az, el), aim, `ray ${k}`);
        }
        // Aimed just inside an edge or a corner (0 to 3 cm in, on two or three axes): entries land in the edge bands.
        for (let k = 0; k < 1500; k++) {
          const az = rng() * 2 * Math.PI;
          const el = (rng() * 70 + 2) * DEG;
          const local = { x: 0, y: 0, z: 0 };
          const bandAxes = 2 + (rng() < 0.3 ? 1 : 0);
          const order = (['x', 'y', 'z'] as const).slice().sort(() => rng() - 0.5);
          order.forEach((axis, i) => {
            const half = engine.halfSize[axis];
            local[axis] = i < bandAxes ? (rng() < 0.5 ? -1 : 1) * (half - rng() * 0.03) : (rng() * 2 - 1) * half * 0.9;
          });
          const aim = toWorldBox({ center: { x: engine.center.x + local.x, y: engine.center.y + local.y, z: engine.center.z + local.z }, halfSize: { x: 0, y: 0, z: 0 }, part: 'engine' }, v.x, v.z, v.yaw, groundY).center;
          check(fromAbove(aim, az, el), aim, `edge ray ${k}`);
        }
        expect(checked).toBeGreaterThan(900);
        expect(nearEdge).toBeGreaterThan(300); // the edge bands really were exercised
      });

      it('disable() is idempotent: the engine burns out and a smoke column appears', () => {
        const t = createVehicleTarget(place(kind, 0, -300, 0), terrainHeight(0, -300), 'desert');
        expect(t.disabled).toBe(false);
        const before = t.group.children.length;
        t.update(0.1); // no smoke yet
        expect(t.group.children.length).toBe(before);
        t.disable();
        expect(t.disabled).toBe(true);
        const after = t.group.children.length;
        expect(after).toBeGreaterThan(before); // the smoke column
        t.disable(); // idempotent
        expect(t.group.children.length).toBe(after);
        for (let i = 0; i < 60; i++) t.update(1 / 30);
        expect(t.disabled).toBe(true);
        // The zones stay (the caller decides to stop offering the target), the body stays solid.
        expect(t.hitTarget.zones.length).toBeGreaterThan(0);
        expect(t.obstacles.length).toBeGreaterThan(0);
        const engineMesh = t.group.children.find((c) => c.userData.part === 'engine') as THREE.Mesh;
        const fresh = createVehicleTarget(place(kind, 0, -300, 0), terrainHeight(0, -300), 'desert');
        const freshEngine = fresh.group.children.find((c) => c.userData.part === 'engine') as THREE.Mesh;
        expect(engineMesh.material).not.toBe(freshEngine.material); // burnt
      });
    });
  }

  describe('real shots (BulletSystem, .308, no wind)', () => {
    const groundAt = (x: number, z: number): number => terrainHeight(x, z);
    const worldOf = (v: VehicleTargetPlacement, g: number, lx: number, ly: number, lz: number): Vec3 => {
      const b = toWorldBox({ center: { x: lx, y: ly, z: lz }, halfSize: { x: 0, y: 0, z: 0 }, part: 'hull' }, v.x, v.z, v.yaw, g);
      return b.center;
    };

    for (const kind of ['truck', 'jeep'] as const) {
      for (const deg of [0, 30, -30, 60]) {
        it(`${kind}: a shot at the engine centre from ${deg} degrees off the front registers the engine`, () => {
          const x = 0;
          const z = -300;
          const v = place(kind, x, z, (deg * DEG));
          const g = groundAt(x, z);
          const t = createVehicleTarget(v, g, 'desert');
          const aim = vehicleTargetColliders(v, g).engineCenter;
          const events = shootAtPoint(aim, [t.hitTarget], t.obstacles);
          expect(events).toHaveLength(1);
          const e = events[0];
          expect(e.kind).toBe('target');
          if (e.kind === 'target') {
            expect(e.targetId).toBe(v.id);
            expect(e.zone).toBe('engine');
          }
        });
      }
    }

    // Regression: bullets used to slip through the 1-2.5 cm bands along the edges of the engine faces.
    describe('shots at the edge bands of the engine block register the engine', () => {
      const expectEngine = (v: VehicleTargetPlacement, local: Vec3, label: string): void => {
        const g = groundAt(v.x, v.z);
        const t = createVehicleTarget(v, g, 'desert');
        const events = shootAtPoint(worldOf(v, g, local.x, local.y, local.z), [t.hitTarget], t.obstacles);
        expect(events, label).toHaveLength(1);
        const e = events[0];
        expect(e.kind, label).toBe('target');
        if (e.kind === 'target') expect(e.zone, label).toBe('engine');
      };

      it('jeep at 44 degrees yaw: the front face 1 cm (and 0.2 to 2.5 cm) from the side edge', () => {
        const { engine } = vehicleTargetBoxes('jeep');
        const front = engine.center.z + engine.halfSize.z;
        for (const yawDeg of [44, -44]) {
          for (const side of [-1, 1]) {
            for (const inset of [0.002, 0.01, 0.012, 0.025]) {
              const v = place('jeep', 0, -300, yawDeg * DEG);
              expectEngine(v, { x: side * (engine.halfSize.x - inset), y: engine.center.y, z: front }, `yaw ${yawDeg} side ${side} inset ${inset}`);
            }
          }
        }
      });

      it('jeep: the front-top edge and the front corners', () => {
        const { engine } = vehicleTargetBoxes('jeep');
        const front = engine.center.z + engine.halfSize.z;
        const top = engine.center.y + engine.halfSize.y;
        const v = place('jeep', 0, -300, 0.2);
        expectEngine(v, { x: 0.1, y: top - 0.004, z: front }, 'front-top edge');
        expectEngine(v, { x: engine.halfSize.x - 0.005, y: top - 0.005, z: front }, 'front-top corner');
        expectEngine(v, { x: -(engine.halfSize.x - 0.005), y: top - 0.005, z: front }, 'front-top corner, other side');
      });

      it('truck: the back edge of a side face (next to the cab), shot obliquely from the front side', () => {
        const { engine } = vehicleTargetBoxes('truck');
        const back = engine.center.z - engine.halfSize.z;
        for (const [yawDeg, side] of [
          [-60, 1],
          [-45, 1],
          [60, -1],
          [45, -1],
        ] as const) {
          for (const inset of [0, 0.005, 0.01, 0.02]) {
            const v = place('truck', 0, -300, yawDeg * DEG);
            expectEngine(v, { x: side * engine.halfSize.x, y: engine.center.y, z: back + inset }, `yaw ${yawDeg} inset ${inset}`);
          }
        }
      });
    });

    it('truck: a shot at the cab (above the engine) is an obstacle hit on metal', () => {
      const v = place('truck', 0, -300, 0);
      const g = groundAt(0, -300);
      const t = createVehicleTarget(v, g, 'desert');
      const aim = worldOf(v, g, 0, 2.45, 1.2);
      const events = shootAtPoint(aim, [t.hitTarget], t.obstacles);
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('obstacle');
      if (events[0].kind === 'obstacle') expect(events[0].material).toBe('metal');
    });

    it('truck and jeep: a shot into the side of the body (bed, hull) is an obstacle hit on metal', () => {
      for (const kind of ['truck', 'jeep'] as const) {
        const v = place(kind, 5, -500, -Math.PI / 2 + 0.1); // the vehicle's +X side (its right) faces the shooter
        const g = groundAt(5, -500);
        const t = createVehicleTarget(v, g, 'desert');
        const hull = vehicleTargetBoxes(kind).body.find((b) => b.part === 'hull');
        expect(hull).toBeDefined();
        const aim = worldOf(v, g, hull?.center.x as number, hull?.center.y as number, hull?.center.z as number);
        const events = shootAtPoint(aim, [t.hitTarget], t.obstacles);
        expect(events).toHaveLength(1);
        expect(events[0].kind, kind).toBe('obstacle');
        if (events[0].kind === 'obstacle') expect(events[0].material).toBe('metal');
      }
    });
  });
});

describe('dispose', () => {
  const placement: VehicleTargetPlacement = { id: 'v-d', kind: 'truck', x: 0, z: -300, yaw: 0.3, range: 300 };
  const ground = terrainHeight(0, -300);

  /** Counts 'dispose' events of a material or texture. */
  const watch = (target: THREE.EventDispatcher<{ dispose: object }>, counter: { n: number }): void => {
    target.addEventListener('dispose', () => counter.n++);
  };
  const sharedMaterials = (group: THREE.Group): THREE.Material[] => {
    const out = new Set<THREE.Material>();
    group.traverse((o) => {
      if (!(o as THREE.Mesh).isMesh) return; // the smoke sprites are the vehicle's own, not shared
      out.add((o as THREE.Mesh).material as THREE.Material);
    });
    return [...out];
  };

  it('VehicleTarget.dispose() frees the smoke (sprite materials and texture) but not the shared geometry and materials', () => {
    const t = createVehicleTarget(placement, ground, 'desert');
    t.disable();
    const anchor = t.group.children.find((c) => c.name === 'smoke-anchor') as THREE.Group;
    expect(anchor).toBeDefined();
    const sprites = [...anchor.children[0].children] as THREE.Sprite[];
    expect(sprites.length).toBeGreaterThan(0);
    const spriteCount = { n: 0 };
    const textureCount = { n: 0 };
    for (const s of sprites) watch((s.material as THREE.SpriteMaterial) as unknown as THREE.EventDispatcher<{ dispose: object }>, spriteCount);
    watch(((sprites[0].material as THREE.SpriteMaterial).map as THREE.Texture) as unknown as THREE.EventDispatcher<{ dispose: object }>, textureCount);
    const sharedCount = { n: 0 };
    const geometryCount = { n: 0 };
    for (const m of sharedMaterials(t.group)) watch(m as unknown as THREE.EventDispatcher<{ dispose: object }>, sharedCount);
    t.group.traverse((o) => {
      const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
      if (g) watch(g as unknown as THREE.EventDispatcher<{ dispose: object }>, geometryCount);
    });

    t.dispose();
    expect(spriteCount.n).toBe(sprites.length);
    expect(textureCount.n).toBe(1);
    expect(sharedCount.n).toBe(0);
    expect(geometryCount.n).toBe(0);
    expect(t.group.children.some((c) => c.name === 'smoke-anchor')).toBe(false);
    // Still usable and harmless afterwards: no smoke comes back, nothing throws.
    t.update(0.1);
    t.disable();
    expect(t.disabled).toBe(true);
    expect(t.group.children.some((c) => c.name === 'smoke-anchor')).toBe(false);
    expect(t.hitTarget.zones.length).toBeGreaterThan(0);
  });

  it('can be called twice, and before disable(), without throwing or freeing anything twice', () => {
    const early = createVehicleTarget(placement, ground, 'arctic');
    expect(() => {
      early.dispose();
      early.dispose();
    }).not.toThrow();
    expect(() => early.update(0.1)).not.toThrow();

    const t = createVehicleTarget(placement, ground, 'valley');
    t.disable();
    const sprite = (t.group.children.find((c) => c.name === 'smoke-anchor') as THREE.Group).children[0].children[0] as THREE.Sprite;
    const count = { n: 0 };
    watch(sprite.material as unknown as THREE.EventDispatcher<{ dispose: object }>, count);
    t.dispose();
    t.dispose();
    expect(count.n).toBe(1);
  });

  it('SmokeColumn.dispose() is idempotent and stops the column', () => {
    const smoke = new SmokeColumn({ rng: createRng(1) });
    const sprites = smoke.group.children as THREE.Sprite[];
    expect(sprites.length).toBeGreaterThan(0);
    smoke.dispose();
    smoke.dispose();
    expect(() => smoke.update(0.1)).not.toThrow();
  });

  it('SparkSystem.dispose() frees the buffers, material and texture once and is safe to repeat; later spawns do nothing', () => {
    const sparks = new SparkSystem(createRng(2));
    const points = sparks.group.children[0] as THREE.Points;
    const material = points.material as THREE.PointsMaterial;
    const geometryCount = { n: 0 };
    const materialCount = { n: 0 };
    const textureCount = { n: 0 };
    watch(points.geometry as unknown as THREE.EventDispatcher<{ dispose: object }>, geometryCount);
    watch(material as unknown as THREE.EventDispatcher<{ dispose: object }>, materialCount);
    watch(material.map as unknown as THREE.EventDispatcher<{ dispose: object }>, textureCount);
    sparks.dispose();
    sparks.dispose();
    expect(geometryCount.n).toBe(1);
    expect(materialCount.n).toBe(1);
    expect(textureCount.n).toBe(1);
    expect(() => {
      sparks.spawn({ x: 0, y: 1, z: -50 });
      sparks.update(0.1);
    }).not.toThrow();

    const early = new SparkSystem();
    expect(() => {
      early.dispose();
      early.dispose();
    }).not.toThrow();
  });
});

describe('createTargetDummy(position, yaw)', () => {
  const RANGE = 800;
  const bearing = 10 * DEG;
  const x = RANGE * Math.sin(bearing);
  const z = -RANGE * Math.cos(bearing);
  const feet = { x, y: terrainHeight(x, z), z };
  const yaw = facingYaw(x, z);

  const worldPoint = (dummy: ReturnType<typeof createTargetDummy>, lx: number, ly: number): Vec3 => {
    dummy.group.updateMatrixWorld(true);
    const v = dummy.group.localToWorld(new THREE.Vector3(lx, ly, 0));
    return { x: v.x, y: v.y, z: v.z };
  };

  it('stands at the position, turned by the yaw about +Y (its front looks at the shooter)', () => {
    const dummy = createTargetDummy(feet, yaw);
    expect(dummy.group.position.x).toBe(feet.x);
    expect(dummy.group.position.y).toBe(feet.y);
    expect(dummy.group.position.z).toBe(feet.z);
    expect(dummy.group.rotation.y).toBeCloseTo(yaw, 12);
    dummy.group.updateMatrixWorld(true);
    const front = new THREE.Vector3(0, 0, 1).transformDirection(dummy.group.matrixWorld);
    expect(front.x * feet.x + front.z * feet.z).toBeLessThan(0); // pointing from the dummy back toward the origin
    expect(front.x).toBeCloseTo(-feet.x / RANGE, 3);
    expect(front.z).toBeCloseTo(-feet.z / RANGE, 3);
  });

  it('rotates every hit sphere with the yaw: each world centre is the mesh frame point', () => {
    const odd = 0.9;
    const dummy = createTargetDummy({ x: 30, y: 2, z: -700 }, odd);
    const local = dummyHitSpheres();
    expect(dummy.hitTarget.zones).toHaveLength(local.length);
    dummy.group.updateMatrixWorld(true);
    local.forEach((s, i) => {
      const w = dummy.group.localToWorld(new THREE.Vector3(s.x, s.y, 0));
      const zone = dummy.hitTarget.zones[i];
      expect(zone.name).toBe(s.name);
      expect(zone.radius).toBe(s.radius);
      expect(dist(zone.center, { x: w.x, y: w.y, z: w.z })).toBeLessThan(1e-9);
    });
  });

  it('has broad-phase bounds that enclose every zone with at least 5 cm to spare', () => {
    const dummy = createTargetDummy(feet, yaw);
    const b = dummy.hitTarget.bounds;
    expect(b).toBeDefined();
    for (const zone of dummy.hitTarget.zones) {
      expect(dist(zone.center, b?.center as Vec3) + zone.radius + 0.05 - 1e-9).toBeLessThanOrEqual(b?.radius as number);
    }
    expect(b?.radius as number).toBeLessThan(1.2);
  });

  it('a real shot at an arm centre registers limbs; one 0.1 m outside the arm registers nothing (bearing 10 degrees, facing the shooter)', () => {
    const dummy = createTargetDummy(feet, yaw);
    for (const side of [-1, 1]) {
      const armCentre = worldPoint(dummy, side * 0.27, 1.26);
      const hit = shootAtPoint(armCentre, [dummy.hitTarget]);
      expect(hit).toHaveLength(1);
      expect(hit[0].kind).toBe('target');
      if (hit[0].kind === 'target') expect(hit[0].zone).toBe('limbs');

      const outside = worldPoint(dummy, side * 0.42, 1.26);
      const miss = shootAtPoint(outside, [dummy.hitTarget]);
      expect(miss).toHaveLength(1);
      expect(miss[0].kind).not.toBe('target');
    }
  });

  it('a dummy turned side-on is not hit where its arms would be if the spheres ignored the yaw', () => {
    const dummy = createTargetDummy({ x: 0, y: terrainHeight(0, -RANGE), z: -RANGE }, Math.PI / 2);
    const where = { x: 0.27, y: terrainHeight(0, -RANGE) + 1.26, z: -RANGE }; // the unrotated right arm
    const events = shootAtPoint(where, [dummy.hitTarget]);
    expect(events).toHaveLength(1);
    expect(events[0].kind).not.toBe('target');
  });

  it('falls away from the shooter (its own back) whatever the yaw, and stands up again', () => {
    for (const odd of [0, 0.5, -1.2]) {
      const pos = { x: 0, y: 1, z: -400 };
      const dummy = createTargetDummy(pos, odd);
      dummy.knockDown();
      advance(dummy, FALL_DURATION);
      // The shoulders (the pivot of the head bone) end up behind the feet, in his own frame whatever the yaw.
      const neck = bonesOf(dummy.group)[2].position.clone();
      dummy.group.updateMatrixWorld(true);
      const world = dummy.group.localToWorld(neck.clone());
      const facing = { x: Math.sin(odd), z: Math.cos(odd) };
      const along = (world.x - pos.x) * facing.x + (world.z - pos.z) * facing.z;
      expect(along).toBeLessThan(-0.2);
      expect(along).toBeCloseTo(neck.z, 9);
      expect(neck.y).toBeLessThan(0.5); // down on the ground
      dummy.reset();
      expect(bonesOf(dummy.group)[2].position.y).toBeCloseTo(1.52, 9);
      expect(dummy.group.rotation.x).toBe(0);
      expect(dummy.group.rotation.y).toBeCloseTo(odd, 12);
    }
  });
});

describe('sparks', () => {
  it('a spawn makes a burst of bright points that is over in about 0.3 s, with a fixed-size buffer', () => {
    const sparks = new SparkSystem(createRng(5));
    const points = sparks.group.children[0] as THREE.Points;
    expect(points).toBeDefined();
    expect(SPARK_LIFETIME).toBeGreaterThanOrEqual(0.2);
    expect(SPARK_LIFETIME).toBeLessThanOrEqual(0.35);
    const count = points.geometry.getAttribute('position').count;
    const colors = points.geometry.getAttribute('color').array as Float32Array;
    const brightness = (): number => colors.reduce((a, b) => a + b, 0);
    expect(brightness()).toBe(0);
    sparks.spawn({ x: 1, y: 2, z: -300 });
    expect(brightness()).toBeGreaterThan(5);
    sparks.update(0.1);
    expect(brightness()).toBeGreaterThan(0);
    sparks.update(SPARK_LIFETIME);
    expect(brightness()).toBe(0);
    expect(points.geometry.getAttribute('position').count).toBe(count);
    // Many hits in a row never grow the buffer (ring buffer) and never throw.
    for (let i = 0; i < 100; i++) sparks.spawn({ x: 0, y: 1, z: -100 });
    expect(points.geometry.getAttribute('position').count).toBe(count);
    sparks.update(NaN);
    sparks.update(-1);
  });

  it('the sparks start at the hit point and fly outward', () => {
    const sparks = new SparkSystem(createRng(9));
    const points = sparks.group.children[0] as THREE.Points;
    const pos = points.geometry.getAttribute('position').array as Float32Array;
    sparks.spawn({ x: 5, y: 7, z: -50 });
    sparks.update(0.05);
    let moved = 0;
    for (let i = 0; i < pos.length; i += 3) {
      const d = Math.hypot(pos[i] - 5, pos[i + 1] - 7, pos[i + 2] + 50);
      if (d > 0.05 && d < 1) moved++;
    }
    expect(moved).toBeGreaterThanOrEqual(8);
  });
});

describe('smoke column', () => {
  it('is a few dozen sprites that fade in and rise, drifting with the wind', () => {
    const smoke = new SmokeColumn({ wind: { x: 6, y: 0, z: 0 }, rng: createRng(3) });
    const sprites = smoke.group.children as THREE.Sprite[];
    expect(sprites.length).toBeGreaterThanOrEqual(24);
    expect(sprites.length).toBeLessThanOrEqual(80);
    for (let i = 0; i < 120; i++) smoke.update(1 / 30); // 4 s
    const visible = sprites.filter((s) => s.visible);
    expect(visible.length).toBeGreaterThan(10);
    const meanY = visible.reduce((a, s) => a + s.position.y, 0) / visible.length;
    const meanX = visible.reduce((a, s) => a + s.position.x, 0) / visible.length;
    expect(meanY).toBeGreaterThan(3);
    expect(meanX).toBeGreaterThan(0.5); // blown toward +X
    for (const s of visible) {
      const m = s.material as THREE.SpriteMaterial;
      expect(m.opacity).toBeGreaterThanOrEqual(0);
      expect(m.opacity).toBeLessThanOrEqual(1);
      expect(Number.isFinite(s.position.x + s.position.y + s.position.z)).toBe(true);
    }
    // Long runs recycle the sprites: nothing grows, nothing goes non-finite.
    for (let i = 0; i < 3000; i++) smoke.update(1 / 30);
    expect(smoke.group.children).toHaveLength(sprites.length);
    for (const s of sprites) expect(Number.isFinite(s.position.y)).toBe(true);
    expect(Math.max(...sprites.map((s) => s.position.y))).toBeLessThan(60);
  });
});

describe('createSky(scene, theme)', () => {
  const contrastAt1500 = (density: number): number => Math.exp(-((1500 * density) ** 2));
  const sky = (theme: ThemeId): { fog: THREE.FogExp2; scene: THREE.Scene; setup: ReturnType<typeof createSky> } => {
    const scene = new THREE.Scene();
    const setup = createSky(scene, theme);
    return { fog: scene.fog as THREE.FogExp2, scene, setup };
  };

  it('keeps the desert look exactly as it was (sun, fog colour and density)', () => {
    const { fog, setup } = sky('desert');
    expect(fog.density).toBe(0.00035);
    expect(fog.color.getHex()).toBe(0xb9c3ca);
    expect(setup.sunDirection.y).toBeCloseTo(Math.sin(18 * DEG), 9);
  });

  it('arctic is colder, paler and a little denser; valley is clearer and lighter; every target stays visible at 1500 m', () => {
    const desert = sky('desert').fog;
    const arctic = sky('arctic').fog;
    const valley = sky('valley').fog;
    expect(arctic.density).toBeGreaterThan(desert.density);
    expect(arctic.density).toBeLessThanOrEqual(0.00046);
    expect(valley.density).toBeLessThan(desert.density);
    expect(arctic.color.getHex()).not.toBe(desert.color.getHex());
    expect(valley.color.b).toBeGreaterThan(valley.color.r); // bluer
    expect(arctic.color.b).toBeGreaterThanOrEqual(arctic.color.r); // colder
    const lum = (c: THREE.Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    expect(lum(arctic.color)).toBeGreaterThan(lum(desert.color)); // paler
    for (const f of [desert, arctic, valley]) expect(contrastAt1500(f.density)).toBeGreaterThan(0.55);

    const turbidity = (theme: ThemeId): number => sky(theme).setup.sky.material.uniforms['turbidity'].value as number;
    expect(turbidity('arctic')).toBeGreaterThan(turbidity('desert'));
    expect(turbidity('valley')).toBeLessThan(turbidity('desert'));
  });

  it('adds the sky, a sun and a hemisphere light, and the sun is above the horizon', () => {
    for (const theme of THEMES) {
      const { scene, setup } = sky(theme);
      expect(scene.children).toContain(setup.sky);
      expect(scene.children.some((c) => (c as THREE.DirectionalLight).isDirectionalLight)).toBe(true);
      expect(scene.children.some((c) => (c as THREE.HemisphereLight).isHemisphereLight)).toBe(true);
      expect(setup.sunDirection.y).toBeGreaterThan(0.1);
      expect(setup.sunDirection.length()).toBeCloseTo(1, 9);
    }
  });
});
