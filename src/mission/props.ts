import type { Vec3 } from '../ballistics/types';
import type { Box, Material, Obstacle } from '../game/hit';
import type { VehicleTargetPlacement } from './layout';

// Pure prop dimensions (no three.js). This file is THE dimension source: the meshes in scene/props.ts
// and scene/vehicleTarget.ts are built from `propBoxes`, and the bullet colliders are built from the
// same boxes, so a mesh and its collider cannot drift apart.
//
// Local frame of a prop: ground at y = 0, origin at the centre of the footprint, local +Z is the
// "front" (the door side of a house, the bonnet of a vehicle), local +X is the long side of a wall.
// A placement turns the prop by `yaw` about +Y, like three.js `rotation.y`: local +X maps to world
// (cos yaw, 0, -sin yaw) and local +Z to world (sin yaw, 0, cos yaw). `yaw = 0` therefore faces +Z,
// toward a shooter standing at the origin of a prop at negative Z (the dummy uses the same convention).

export type PropKind = 'house' | 'wall' | 'shed' | 'truck' | 'jeep';

export interface PropPlacement {
  id: string;
  kind: PropKind;
  /** World position of the footprint centre, m. */
  x: number;
  z: number;
  /** Rotation about +Y, rad. */
  yaw: number;
}

/** What a box is, so a mesh builder can tint and shape it (walls vs roofs vs glass vs tyres). */
export type BoxPart = 'wall' | 'roof' | 'hull' | 'cab' | 'glass' | 'wheel' | 'engine';

/** An axis-aligned box in the prop's local frame (yaw 0, ground at y = 0). */
export interface LocalBox {
  center: Vec3;
  halfSize: Vec3;
  part: BoxPart;
}

const box = (part: BoxPart, cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): LocalBox => ({
  center: { x: cx, y: cy, z: cz },
  halfSize: { x: hx, y: hy, z: hz },
  part,
});

// ---------------------------------------------------------------------------------------------
// Buildings
//   house  7.6 x 6.1 m, 3.4 m with the roof slab: 7 x 5.5 x 3 m body plus a roof slab with eaves
//   wall   6 x 0.4 x 1.2 m compound wall segment (low cover)
//   shed   3.8 x 3.3 x 2.2 m shed / tent: 3.5 x 3 x 2 m body plus a roof slab
// ---------------------------------------------------------------------------------------------

const HOUSE: readonly LocalBox[] = [box('wall', 0, 1.5, 0, 3.5, 1.5, 2.75), box('roof', 0, 3.2, 0, 3.8, 0.2, 3.05)];
const WALL: readonly LocalBox[] = [box('wall', 0, 0.6, 0, 3, 0.6, 0.2)];
const SHED: readonly LocalBox[] = [box('wall', 0, 1.0, 0, 1.75, 1.0, 1.5), box('roof', 0, 2.1, 0, 1.9, 0.1, 1.65)];

// ---------------------------------------------------------------------------------------------
// Vehicles. The lower hull / bed is a separate box with its top at 1.15-1.25 m, so a soldier
// crouching behind it is covered below the waist only (the cover rule: lower torso hidden, head and
// chest in view); the tall cab / windshield covers only part of the length. The engine block is its
// own box at the front: it is NOT part of the body, so a bullet can reach it from the front or side
// (BulletSystem takes the earliest contact; an engine inside a body box could never be hit).
//   truck  7 x 2.5 x 3 m   (bed, cab, engine block, four wheels)
//   jeep   4.2 x 1.9 x 1.8 m (hull, windshield, engine block, four wheels)
// ---------------------------------------------------------------------------------------------

const TRUCK_BODY: readonly LocalBox[] = [
  box('hull', 0, 0.925, -1.6, 1.1, 0.325, 1.9), // bed: z -3.5..0.3, y 0.6..1.25
  box('cab', 0, 1.8, 1.2, 1.1, 1.2, 0.9), // cab: z 0.3..2.1, y 0.6..3.0
  box('wheel', -1.1, 0.45, -2.3, 0.15, 0.45, 0.45),
  box('wheel', 1.1, 0.45, -2.3, 0.15, 0.45, 0.45),
  box('wheel', -1.1, 0.45, 2.4, 0.15, 0.45, 0.45),
  box('wheel', 1.1, 0.45, 2.4, 0.15, 0.45, 0.45),
];
const TRUCK_ENGINE: LocalBox = box('engine', 0, 1.25, 2.8, 0.9, 0.55, 0.7); // z 2.1..3.5, y 0.7..1.8

const JEEP_BODY: readonly LocalBox[] = [
  box('hull', 0, 0.775, -0.7, 0.85, 0.375, 1.4), // tub: z -2.1..0.7, y 0.4..1.15
  box('glass', 0, 1.475, 0.75, 0.8, 0.325, 0.05), // windshield: z 0.7..0.8, y 1.15..1.8
  box('wheel', -0.83, 0.33, -1.2, 0.12, 0.33, 0.33),
  box('wheel', 0.83, 0.33, -1.2, 0.12, 0.33, 0.33),
  box('wheel', -0.83, 0.33, 1.4, 0.12, 0.33, 0.33),
  box('wheel', 0.83, 0.33, 1.4, 0.12, 0.33, 0.33),
];
const JEEP_ENGINE: LocalBox = box('engine', 0, 0.85, 1.45, 0.65, 0.3, 0.65); // z 0.8..2.1, y 0.55..1.15

const VEHICLES: Record<'truck' | 'jeep', { body: readonly LocalBox[]; engine: LocalBox }> = {
  truck: { body: TRUCK_BODY, engine: TRUCK_ENGINE },
  jeep: { body: JEEP_BODY, engine: JEEP_ENGINE },
};

const BOXES: Record<PropKind, readonly LocalBox[]> = {
  house: HOUSE,
  wall: WALL,
  shed: SHED,
  truck: [...TRUCK_BODY, TRUCK_ENGINE],
  jeep: [...JEEP_BODY, JEEP_ENGINE],
};

const MATERIAL: Record<PropKind, Material> = {
  house: 'wall',
  wall: 'wall',
  shed: 'wall',
  truck: 'metal',
  jeep: 'metal',
};

/** THE dimension source: every box of a prop in its local frame (vehicles: body boxes, then the engine block last). */
export function propBoxes(kind: PropKind): readonly LocalBox[] {
  return BOXES[kind];
}

/** Body boxes of a vehicle target (the engine block is excluded) and its engine block. */
export function vehicleTargetBoxes(kind: 'truck' | 'jeep'): { body: readonly LocalBox[]; engine: LocalBox } {
  return VEHICLES[kind];
}

const radii = new Map<PropKind, number>();

/** Radius of the circle around the footprint centre that encloses every box, m. */
export function propFootprintRadius(kind: PropKind): number {
  let r = radii.get(kind);
  if (r === undefined) {
    r = 0;
    for (const b of BOXES[kind]) {
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          r = Math.max(r, Math.hypot(b.center.x + sx * b.halfSize.x, b.center.z + sz * b.halfSize.z));
        }
      }
    }
    radii.set(kind, r);
  }
  return r;
}

/** A local box placed in the world: footprint centre (x, z), ground height `groundY`, rotation `yaw` about +Y. */
export function toWorldBox(b: LocalBox, x: number, z: number, yaw: number, groundY: number): Box {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return {
    center: {
      x: x + c * b.center.x + s * b.center.z,
      y: groundY + b.center.y,
      z: z - s * b.center.x + c * b.center.z,
    },
    halfSize: { x: b.halfSize.x, y: b.halfSize.y, z: b.halfSize.z },
    yaw,
  };
}

/** World colliders of a prop, one per local box: houses, sheds and walls are 'wall', vehicles 'metal'. */
export function propColliders(p: PropPlacement, groundY: number): Obstacle[] {
  const material = MATERIAL[p.kind];
  return BOXES[p.kind].map((b, i) => ({
    id: `${p.id}:${i}`,
    material,
    box: toWorldBox(b, p.x, p.z, p.yaw, groundY),
  }));
}

/** World body colliders of a vehicle target (engine excluded) and the world centre of its engine block. */
export function vehicleTargetColliders(
  v: VehicleTargetPlacement,
  groundY: number,
): { body: Obstacle[]; engineCenter: Vec3 } {
  const { body, engine } = VEHICLES[v.kind];
  return {
    body: body.map((b, i) => ({
      id: `${v.id}:${i}`,
      material: 'metal' as const,
      box: toWorldBox(b, v.x, v.z, v.yaw, groundY),
    })),
    engineCenter: toWorldBox(engine, v.x, v.z, v.yaw, groundY).center,
  };
}

/** The engine block of a vehicle target as a world box (for line-of-sight tests; the bullets use engine hit zones). */
export function vehicleEngineObstacle(v: VehicleTargetPlacement, groundY: number): Obstacle {
  return {
    id: `${v.id}:engine`,
    material: 'metal',
    box: toWorldBox(VEHICLES[v.kind].engine, v.x, v.z, v.yaw, groundY),
  };
}
