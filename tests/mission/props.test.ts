import { describe, expect, it } from 'vitest';
import { segmentBox } from '../../src/game/hit';
import type { Box } from '../../src/game/hit';
import type { VehicleTargetPlacement } from '../../src/mission/layout';
import {
  propBoxes,
  propColliders,
  propFootprintRadius,
  toWorldBox,
  vehicleEngineObstacle,
  vehicleTargetBoxes,
  vehicleTargetColliders,
} from '../../src/mission/props';
import type { LocalBox, PropKind } from '../../src/mission/props';

const KINDS: PropKind[] = ['house', 'wall', 'shed', 'truck', 'jeep'];

/** Extent of the union of the boxes along each axis, m. */
function extent(boxes: readonly LocalBox[]): { x: number; y: number; z: number } {
  const span = (axis: 'x' | 'y' | 'z'): number => {
    const lo = Math.min(...boxes.map((b) => b.center[axis] - b.halfSize[axis]));
    const hi = Math.max(...boxes.map((b) => b.center[axis] + b.halfSize[axis]));
    return hi - lo;
  };
  return { x: span('x'), y: span('y'), z: span('z') };
}

/** Volume of the intersection of two local boxes (0 when they only touch). */
function overlapVolume(a: LocalBox, b: LocalBox): number {
  let v = 1;
  for (const axis of ['x', 'y', 'z'] as const) {
    const lo = Math.max(a.center[axis] - a.halfSize[axis], b.center[axis] - b.halfSize[axis]);
    const hi = Math.min(a.center[axis] + a.halfSize[axis], b.center[axis] + b.halfSize[axis]);
    v *= Math.max(0, hi - lo);
  }
  return v;
}

describe('prop dimensions (the single source for meshes and colliders)', () => {
  it('every prop has boxes standing on the ground (nothing below y = 0, nothing degenerate)', () => {
    for (const kind of KINDS) {
      const boxes = propBoxes(kind);
      expect(boxes.length).toBeGreaterThan(0);
      for (const b of boxes) {
        expect(b.center.y - b.halfSize.y).toBeGreaterThanOrEqual(-1e-9);
        expect(Math.min(b.halfSize.x, b.halfSize.y, b.halfSize.z)).toBeGreaterThan(0);
      }
    }
  });

  it('has the realistic overall sizes', () => {
    const house = extent(propBoxes('house'));
    expect(house.x).toBeGreaterThanOrEqual(6);
    expect(house.x).toBeLessThanOrEqual(8);
    expect(house.z).toBeGreaterThanOrEqual(5);
    expect(house.z).toBeLessThanOrEqual(6.2);
    expect(house.y).toBeGreaterThanOrEqual(3);

    const wall = extent(propBoxes('wall'));
    expect(wall.x).toBeCloseTo(6, 6);
    expect(wall.z).toBeCloseTo(0.4, 6);
    expect(wall.y).toBeCloseTo(1.2, 6);

    const shed = extent(propBoxes('shed'));
    expect(shed.x).toBeGreaterThanOrEqual(3);
    expect(shed.x).toBeLessThanOrEqual(4);
    expect(shed.z).toBeGreaterThanOrEqual(3);
    expect(shed.z).toBeLessThanOrEqual(4);
    expect(shed.y).toBeCloseTo(2.2, 6);

    const truck = extent(propBoxes('truck'));
    expect(truck.z).toBeCloseTo(7, 6);
    expect(truck.x).toBeCloseTo(2.5, 6);
    expect(truck.y).toBeCloseTo(3, 6);

    const jeep = extent(propBoxes('jeep'));
    expect(jeep.z).toBeCloseTo(4.2, 6);
    expect(jeep.x).toBeCloseTo(1.9, 6);
    expect(jeep.y).toBeCloseTo(1.8, 6);
  });

  it('the footprint radius encloses every corner of every box', () => {
    for (const kind of KINDS) {
      const r = propFootprintRadius(kind);
      for (const b of propBoxes(kind)) {
        for (const sx of [-1, 1]) {
          for (const sz of [-1, 1]) {
            expect(Math.hypot(b.center.x + sx * b.halfSize.x, b.center.z + sz * b.halfSize.z)).toBeLessThanOrEqual(r + 1e-9);
          }
        }
      }
    }
  });

  it('walls are 1.2 m; every vehicle has a low hull box (top 1.1-1.3 m) that can serve as low cover', () => {
    expect(propBoxes('wall')[0].center.y + propBoxes('wall')[0].halfSize.y).toBeCloseTo(1.2, 9);
    for (const kind of ['truck', 'jeep'] as const) {
      const lowest = propBoxes(kind).filter((b) => b.center.y + b.halfSize.y >= 1.1 && b.center.y + b.halfSize.y <= 1.3);
      expect(lowest.length).toBeGreaterThan(0);
    }
  });
});

describe('prop colliders', () => {
  it('turn local boxes into world boxes (yaw about +Y, local +Z maps to world (sin yaw, cos yaw))', () => {
    const wall = propBoxes('wall')[0];
    // Quarter turn: the wall's local +X (its length) now runs along world -Z.
    const [c] = propColliders({ id: 'w', kind: 'wall', x: 10, z: -300, yaw: Math.PI / 2 }, 2);
    expect(c.box.yaw).toBeCloseTo(Math.PI / 2, 9);
    expect(c.box.center.y).toBeCloseTo(2 + wall.center.y, 9);
    expect(c.box.center.x).toBeCloseTo(10, 9);
    expect(c.box.center.z).toBeCloseTo(-300, 9);
    expect(c.box.halfSize).toEqual(wall.halfSize);
    // A segment along world Z through the wall's far end (2.9 m from the centre) hits it; 3.1 m misses.
    const hitSeg = segmentBox({ x: 10, y: 2.6, z: -290 }, { x: 10, y: 2.6, z: -310 }, c.box);
    expect(hitSeg).not.toBeNull();
    const missSeg = segmentBox({ x: 10, y: 2.6, z: -303.1 }, { x: 10, y: 2.6, z: -310 }, c.box);
    expect(missSeg).toBeNull();
  });

  it('houses, sheds and walls are "wall" material; vehicles are "metal"; ids are unique', () => {
    const material = (kind: PropKind): string[] =>
      propColliders({ id: 'p', kind, x: 0, z: -200, yaw: 0.3 }, 0).map((o) => o.material);
    for (const kind of ['house', 'shed', 'wall'] as const) expect(new Set(material(kind))).toEqual(new Set(['wall']));
    for (const kind of ['truck', 'jeep'] as const) expect(new Set(material(kind))).toEqual(new Set(['metal']));
    for (const kind of KINDS) {
      const colliders = propColliders({ id: 'p', kind, x: 0, z: -200, yaw: 0 }, 0);
      expect(colliders).toHaveLength(propBoxes(kind).length);
      expect(new Set(colliders.map((o) => o.id)).size).toBe(colliders.length);
    }
  });
});

describe('vehicle targets', () => {
  it('body boxes plus the engine block are exactly the prop boxes, and the engine overlaps no body box', () => {
    for (const kind of ['truck', 'jeep'] as const) {
      const { body, engine } = vehicleTargetBoxes(kind);
      expect([...body, engine]).toEqual([...propBoxes(kind)]);
      expect(body.length).toBeGreaterThan(0);
      for (const b of body) expect(overlapVolume(b, engine)).toBeLessThan(1e-9);
    }
  });

  it('hull, cab and engine meet: a lateral (+/-X) line at any height they share, at every z from the rear to the engine front, hits a box', () => {
    for (const kind of ['truck', 'jeep'] as const) {
      const { body, engine } = vehicleTargetBoxes(kind);
      const boxes = [...body, engine].map((b) => toWorldBox(b, 0, 0, 0, 0));
      const hull = body.filter((b) => b.part === 'hull');
      const rear = Math.min(...hull.map((b) => b.center.z - b.halfSize.z));
      const front = engine.center.z + engine.halfSize.z;
      // Heights where the hull (bed or tub) and the engine block both exist (a lateral line there must never find a slit).
      const lo = Math.max(engine.center.y - engine.halfSize.y, ...hull.map((b) => b.center.y - b.halfSize.y));
      const hi = Math.min(engine.center.y + engine.halfSize.y, ...hull.map((b) => b.center.y + b.halfSize.y));
      expect(hi - lo).toBeGreaterThan(0.3);
      const gaps: string[] = [];
      for (let k = 0; k <= 4; k++) {
        const y = lo + 0.01 + ((hi - lo - 0.02) * k) / 4;
        const steps = Math.round((front - rear) / 0.02);
        for (let i = 0; i <= steps; i++) {
          const z = Math.min(front - 1e-9, rear + 1e-9 + i * 0.02); // 1e-9: the end faces themselves sit on a float knife edge
          for (const dir of [-1, 1]) {
            const a = { x: -dir * 5, y, z };
            const b = { x: dir * 5, y, z };
            if (!boxes.some((box) => segmentBox(a, b, box) !== null)) gaps.push(`${kind} y=${y.toFixed(2)} z=${z.toFixed(2)}`);
          }
        }
      }
      expect(gaps, `${kind} has see-through slits`).toEqual([]);
    }
  });

  it('the engine block sits at the front (local +Z) and is big enough to hit', () => {
    for (const kind of ['truck', 'jeep'] as const) {
      const { body, engine } = vehicleTargetBoxes(kind);
      const front = Math.max(...body.map((b) => b.center.z + b.halfSize.z));
      expect(engine.center.z + engine.halfSize.z).toBeGreaterThanOrEqual(front - 1e-9);
      expect(Math.min(engine.halfSize.x, engine.halfSize.y, engine.halfSize.z)).toBeGreaterThanOrEqual(0.3);
    }
  });

  it('world body colliders exclude the engine; engineCenter is the world centre of the engine box', () => {
    const v: VehicleTargetPlacement = { id: 'v', kind: 'truck', x: 40, z: -700, yaw: 0.8, range: 701 };
    const groundY = 0.3;
    const { body, engineCenter } = vehicleTargetColliders(v, groundY);
    const { engine } = vehicleTargetBoxes('truck');
    expect(body).toHaveLength(vehicleTargetBoxes('truck').body.length);
    const c = Math.cos(v.yaw);
    const s = Math.sin(v.yaw);
    expect(engineCenter.x).toBeCloseTo(40 + c * engine.center.x + s * engine.center.z, 9);
    expect(engineCenter.y).toBeCloseTo(groundY + engine.center.y, 9);
    expect(engineCenter.z).toBeCloseTo(-700 - s * engine.center.x + c * engine.center.z, 9);
    for (const o of body) expect(o.material).toBe('metal');
    // The engine centre is inside the engine obstacle and outside every body obstacle.
    const eo = vehicleEngineObstacle(v, groundY);
    expect(segmentBox(engineCenter, engineCenter, eo.box)).toBe(0);
    for (const o of body) expect(segmentBox(engineCenter, engineCenter, o.box)).toBeNull();
  });

  it('a vehicle facing the shooter can be shot in the engine: the line to the engine centre misses the body', () => {
    for (const kind of ['truck', 'jeep'] as const) {
      const v: VehicleTargetPlacement = { id: 'v', kind, x: 0, z: -400, yaw: 0, range: 400 };
      const { body, engineCenter } = vehicleTargetColliders(v, 0);
      const eye = { x: 0, y: 12.4, z: 0 };
      for (const o of body) {
        const box: Box = o.box;
        expect(segmentBox(eye, engineCenter, box)).toBeNull();
      }
    }
  });
});
