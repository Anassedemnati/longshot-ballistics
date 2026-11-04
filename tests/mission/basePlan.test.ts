import { describe, expect, it } from 'vitest';
import { segmentBox } from '../../src/game/hit';
import { BASE_KINDS, TOWER_DECK } from '../../src/mission/baseProps';
import { BASE_RADIUS, planBase } from '../../src/mission/basePlan';
import type { BasePlan, BaseSize } from '../../src/mission/basePlan';
import { boxFootprintCorners, propBoxes, propColliders, propFootprintRect, rooftopSpot } from '../../src/mission/props';
import { createRng } from '../../src/mission/random';

const SIZES: BaseSize[] = ['outpost', 'base'];
const SEEDS = [1, 2, 3, 7, 42, 1234, 99991];
const CENTRE = { x: 40, z: -520 };

const plan = (size: BaseSize, seed: number, yaw = 0.35, field?: { height(x: number, z: number): number }): BasePlan => planBase(CENTRE, yaw, size, createRng(seed), field);

/** World footprint corners of a placed prop's footprint rectangle. */
function worldRect(p: BasePlan['props'][number]): Array<{ x: number; z: number }> {
  const f = propFootprintRect(p.kind);
  const c = Math.cos(p.yaw);
  const s = Math.sin(p.yaw);
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([a, b]) => {
    const lx = f.cx + a * f.hx;
    const lz = f.cz + b * f.hz;
    return { x: p.x + c * lx + s * lz, z: p.z - s * lx + c * lz };
  });
}

/** Separating-axis overlap depth of two convex quads (world xz), m. */
function quadOverlap(a: Array<{ x: number; z: number }>, b: Array<{ x: number; z: number }>): number {
  let depth = Infinity;
  for (const quad of [a, b]) {
    for (let i = 0; i < 2; i++) {
      const e = { x: quad[i + 1].x - quad[i].x, z: quad[i + 1].z - quad[i].z };
      const l = Math.hypot(e.x, e.z);
      const n = { x: -e.z / l, z: e.x / l };
      const pa = a.map((p) => p.x * n.x + p.z * n.z);
      const pb = b.map((p) => p.x * n.x + p.z * n.z);
      depth = Math.min(depth, Math.min(Math.max(...pa), Math.max(...pb)) - Math.max(Math.min(...pa), Math.min(...pb)));
    }
  }
  return depth;
}

/** Pairs a plan places on top of each other on purpose: a tank under its camouflage net, the helicopter on its pad. */
const STACKED = new Set(['camoNet|tank', 'tank|camoNet', 'helipad|helicopter', 'helicopter|helipad']);

describe('planBase', () => {
  it('is deterministic: the same seed gives the same plan, another seed a different one', () => {
    for (const size of SIZES) {
      expect(plan(size, 5)).toEqual(plan(size, 5));
      expect(plan(size, 5)).not.toEqual(plan(size, 6));
    }
  });

  for (const size of SIZES) {
    it(`${size}: no two props overlap (oriented footprints), except a tank under its net and the helicopter on its pad`, () => {
      for (const seed of SEEDS) {
        const b = plan(size, seed);
        const rects = b.props.map(worldRect);
        for (let i = 0; i < b.props.length; i++) {
          for (let j = i + 1; j < b.props.length; j++) {
            if (STACKED.has(`${b.props[i].kind}|${b.props[j].kind}`)) continue;
            expect(quadOverlap(rects[i], rects[j]), `seed ${seed}: ${b.props[i].id} and ${b.props[j].id}`).toBeLessThan(0.03);
          }
        }
      }
    });

    it(`${size}: every collider corner lies within ${BASE_RADIUS[size]} m of the centre`, () => {
      for (const seed of SEEDS) {
        const b = plan(size, seed);
        expect(b.radius).toBe(BASE_RADIUS[size]);
        for (const p of b.props) {
          for (const o of propColliders(p, 0)) {
            const c = Math.cos(o.box.yaw);
            const s = Math.sin(o.box.yaw);
            for (const [a, d] of [
              [-1, -1],
              [1, -1],
              [1, 1],
              [-1, 1],
            ]) {
              const lx = a * o.box.halfSize.x;
              const lz = d * o.box.halfSize.z;
              const r = Math.hypot(o.box.center.x + c * lx + s * lz - CENTRE.x, o.box.center.z - s * lx + c * lz - CENTRE.z);
              expect(r, `seed ${seed}: ${o.id}`).toBeLessThanOrEqual(BASE_RADIUS[size] + 1e-6);
            }
          }
        }
      }
    });

    it(`${size}: towers, machine-gun nests, the gate and its guards`, () => {
      for (const seed of SEEDS) {
        const b = plan(size, seed);
        const count = (kind: string): number => b.props.filter((p) => p.kind === kind).length;
        const towers = count('watchTower');
        const nests = count('mgNest');
        expect(towers).toBeGreaterThanOrEqual(size === 'outpost' ? 2 : 4);
        expect(nests).toBeGreaterThanOrEqual(2);
        expect(count('gate')).toBe(1);
        expect(count('booth')).toBe(1);
        const posts = (post: string): number => b.guards.filter((g) => g.post === post).length;
        expect(posts('tower')).toBe(towers);
        expect(posts('mg')).toBe(nests);
        expect(posts('gate')).toBe(2);
        expect(posts('patrol')).toBeGreaterThanOrEqual(size === 'outpost' ? 1 : 2);
        for (const g of b.guards.filter((q) => q.post === 'tower')) expect(g.y).toBeCloseTo(TOWER_DECK, 9);
        expect(new Set(b.guards.map((g) => g.id)).size).toBe(b.guards.length);
        expect(new Set(b.props.map((p) => p.id)).size).toBe(b.props.length);
      }
    });

    it(`${size}: patrol routes stay clear of every prop footprint and inside the radius`, () => {
      for (const seed of SEEDS) {
        const b = plan(size, seed);
        const rects = b.props.map(worldRect);
        for (const g of b.guards.filter((q) => q.post === 'patrol')) {
          const route = g.route ?? [];
          expect(route.length).toBeGreaterThanOrEqual(2);
          expect(route[0].x).toBeCloseTo(g.x, 9);
          for (let i = 0; i < route.length; i++) {
            const a = route[i];
            const c = route[(i + 1) % route.length];
            for (let k = 0; k <= 20; k++) {
              const p = { x: a.x + ((c.x - a.x) * k) / 20, z: a.z + ((c.z - a.z) * k) / 20 };
              expect(Math.hypot(p.x - CENTRE.x, p.z - CENTRE.z)).toBeLessThan(BASE_RADIUS[size]);
              const dot = [
                { x: p.x - 0.2, z: p.z - 0.2 },
                { x: p.x + 0.2, z: p.z - 0.2 },
                { x: p.x + 0.2, z: p.z + 0.2 },
                { x: p.x - 0.2, z: p.z + 0.2 },
              ];
              rects.forEach((r, j) => expect(quadOverlap(dot, r), `seed ${seed}: patrol through ${b.props[j].id}`).toBeLessThan(0));
            }
          }
        }
      }
    });

    it(`${size}: tower and machine-gun guards see 300 m out over their parapet or sandbags (no base collider in the way)`, () => {
      for (const seed of SEEDS) {
        const b = plan(size, seed);
        const obstacles = b.props.flatMap((p) => propColliders(p, 0));
        for (const g of b.guards.filter((q) => q.post === 'tower' || q.post === 'mg')) {
          const eye = { x: g.x, y: (g.y ?? 0) + 1.6, z: g.z };
          const far = { x: g.x + Math.sin(g.yaw) * 300, y: eye.y, z: g.z + Math.cos(g.yaw) * 300 };
          // Start 0.5 m out: the guard stands on the deck / inside the ring, not in a collider.
          const from = { x: g.x + Math.sin(g.yaw) * 0.5, y: eye.y, z: g.z + Math.cos(g.yaw) * 0.5 };
          for (const o of obstacles) expect(segmentBox(from, far, o.box), `seed ${seed}: ${g.id} (${g.post}) blocked by ${o.id}`).toBeNull();
        }
      }
    });
  }

  it('a full base holds every kind of military prop', () => {
    for (const seed of SEEDS) {
      const kinds = new Set(plan('base', seed).props.map((p) => p.kind));
      for (const k of BASE_KINDS) expect(kinds.has(k), `seed ${seed}: ${k}`).toBe(true);
    }
  });

  it('leaves the lane from the gate open (yard spots) and turns with facingYaw', () => {
    const a = plan('base', 3, 0);
    const b = plan('base', 3, Math.PI / 2);
    expect(a.yard.length).toBeGreaterThan(4);
    // Same seed, a quarter turn: every prop turns a quarter round the centre.
    a.props.forEach((p, i) => {
      const q = b.props[i];
      expect(q.kind).toBe(p.kind);
      const dx = p.x - CENTRE.x;
      const dz = p.z - CENTRE.z;
      expect(q.x - CENTRE.x).toBeCloseTo(dz, 6);
      expect(q.z - CENTRE.z).toBeCloseTo(-dx, 6);
      expect(q.yaw).toBeCloseTo(p.yaw + Math.PI / 2, 9);
    });
  });

  it('on a slope interior props skip footprints the ground falls away under; the perimeter still stands', () => {
    const slope = { height: (x: number, z: number): number => 0.12 * (x - CENTRE.x) + 0.02 * (z - CENTRE.z) };
    const flat = plan('base', 9);
    const steep = plan('base', 9, 0.35, slope);
    expect(steep.props.filter((p) => p.kind === 'watchTower')).toHaveLength(4);
    expect(steep.props.length).toBeLessThan(flat.props.length);
    for (const p of steep.props) {
      if (['hesco', 'sandbags', 'watchTower', 'mgNest', 'gate', 'booth', 'jersey'].includes(p.kind)) continue;
      const hs = worldRect(p).map((c) => slope.height(c.x, c.z));
      expect(Math.max(...hs) - Math.min(...hs), p.id).toBeLessThanOrEqual(0.6 + 1e-9);
    }
  });

  it('the tower deck is a spot a guard can stand on (rooftopSpot finds it at deck height)', () => {
    const spot = rooftopSpot('watchTower', 0.35);
    expect(spot).not.toBeNull();
    expect(spot?.top).toBeCloseTo(TOWER_DECK, 9);
    // The canopy leaves a standing man's head room; the parapet hides him below the chest only.
    const boxes = propBoxes('watchTower');
    const canopy = boxes.find((b) => b.part === 'canopy');
    const parapet = boxes.filter((b) => b.part === 'wall');
    expect((canopy?.center.y ?? 0) - (canopy?.halfSize.y ?? 0) - TOWER_DECK).toBeGreaterThan(2.0);
    for (const w of parapet) expect(w.center.y + w.halfSize.y - TOWER_DECK).toBeLessThanOrEqual(1.1);
    expect(boxFootprintCorners(boxes[0])).toHaveLength(4);
  });
});
