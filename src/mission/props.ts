import type { Vec3 } from '../ballistics/types';
import type { Box, Material, Obstacle } from '../game/hit';
import type { VehicleTargetPlacement } from './layout';
import { BASE_BOXES, BASE_MATERIAL, isBaseKind } from './baseProps';
import type { BaseKind } from './baseProps';

export type { BaseKind } from './baseProps';

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

/**
 * Every kind of static scenery: the village props of the layout (`PropKind`) and the military-base hardware
 * (`BaseKind`, src/mission/baseProps.ts). `PropKind` stays the narrow union the layout's tables are keyed by;
 * the dimension, collider and mesh functions take either.
 */
export type SceneryKind = PropKind | BaseKind;

/** A placed prop of any kind (a `PropPlacement` is one). */
export interface SceneryPlacement {
  id: string;
  kind: SceneryKind;
  /** World position of the footprint centre, m. */
  x: number;
  z: number;
  /** Rotation about +Y, rad. */
  yaw: number;
}

/** What a box is, so a mesh builder can tint and shape it (walls vs roofs vs glass vs tyres). */
export type BoxPart =
  | 'wall'
  | 'roof'
  | 'hull'
  | 'cab'
  | 'glass'
  | 'wheel'
  | 'engine'
  // Military hardware (baseProps.ts):
  | 'track'
  | 'turret'
  | 'gun'
  | 'hatch'
  | 'antenna'
  | 'frame'
  | 'panel'
  | 'post'
  | 'deck'
  | 'canopy'
  | 'bags'
  | 'crate'
  | 'fabric'
  | 'blade'
  | 'tank'
  | 'lamp'
  | 'net';

/**
 * How the mesh draws a collider box (default `box`; a `wheel` box defaults to `roundX`). Whatever the look, the drawn
 * shape fills the box: it touches all six faces, so a bullet meets the box within a few cm of the drawn surface.
 *   roundX|Y|Z  a prism inscribed in the box, axis along local x / y / z (tyres, drums, masts, barrels)
 *   tube        a prism from `tube.from` to `tube.to` (a tilted barrel segment; the box is its bounding box)
 *   bags        staggered rows of rounded sandbags filling the box (lengthwise along its longer horizontal side)
 *   arch        a half-elliptic vault along z standing on the box's floor (a tent roof)
 *   ladder      two rails at the box's x ends and rungs between them
 */
export type BoxLook = 'box' | 'roundX' | 'roundY' | 'roundZ' | 'tube' | 'bags' | 'arch' | 'ladder';

/** A box in the prop's local frame (ground at y = 0), axis-aligned unless `yaw` turns it about its own centre. */
export interface LocalBox {
  center: Vec3;
  halfSize: Vec3;
  part: BoxPart;
  /** Rotation of the box about +Y around its own centre, rad (same convention as a placement's yaw). Default 0. */
  yaw?: number;
  /** How the mesh draws it (see `BoxLook`). */
  look?: BoxLook;
  /** The `tube` look: axis end points (local frame, m) and radius, m. The box is the tube's bounding box. */
  tube?: { from: Vec3; to: Vec3; radius: number };
  /** Sides of a round look's prism (default: the mesh builder's choice). */
  sides?: number;
  /** Collider material of this box when it differs from the kind's (a machine gun behind sandbags). */
  material?: Material;
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
// Hull, cab and engine meet face to face (no slit between them: a lateral line at any height they
// share hits a box from the rear of the hull to the front of the engine).
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
const JEEP_ENGINE: LocalBox = box('engine', 0, 0.85, 1.4, 0.65, 0.3, 0.7); // z 0.7..2.1, y 0.55..1.15 (starts where the tub ends: no slit)

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
export function propBoxes(kind: SceneryKind): readonly LocalBox[] {
  return isBaseKind(kind) ? BASE_BOXES[kind] : BOXES[kind];
}

/** The collider material of box `b` of a prop of `kind`. */
function materialOf(kind: SceneryKind, b: LocalBox): Material {
  return b.material ?? (isBaseKind(kind) ? BASE_MATERIAL[kind] : MATERIAL[kind]);
}

/** The four (x, z) corners of a box's footprint in the prop frame (its own yaw applied). */
export function boxFootprintCorners(b: LocalBox): Array<{ x: number; z: number }> {
  const c = Math.cos(b.yaw ?? 0);
  const s = Math.sin(b.yaw ?? 0);
  const out: Array<{ x: number; z: number }> = [];
  for (const [sx, sz] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ]) {
    const lx = sx * b.halfSize.x;
    const lz = sz * b.halfSize.z;
    out.push({ x: b.center.x + c * lx + s * lz, z: b.center.z - s * lx + c * lz });
  }
  return out;
}

/** Body boxes of a vehicle target (the engine block is excluded) and its engine block. */
export function vehicleTargetBoxes(kind: 'truck' | 'jeep'): { body: readonly LocalBox[]; engine: LocalBox } {
  return VEHICLES[kind];
}

const radii = new Map<SceneryKind, number>();

/** Radius of the circle around the footprint centre that encloses every box, m. */
export function propFootprintRadius(kind: SceneryKind): number {
  let r = radii.get(kind);
  if (r === undefined) {
    r = 0;
    for (const b of propBoxes(kind)) {
      for (const p of boxFootprintCorners(b)) r = Math.max(r, Math.hypot(p.x, p.z));
    }
    radii.set(kind, r);
  }
  return r;
}

/** The footprint of a prop as a rectangle in its own frame: centre (`cx`, `cz`) and half sizes, m (the bounding rectangle of every box). */
export interface FootprintRect {
  cx: number;
  cz: number;
  hx: number;
  hz: number;
}

const rects = new Map<SceneryKind, FootprintRect>();

/** The bounding rectangle (prop frame) of every box of a prop, for oriented-rectangle overlap tests (long walls are poorly served by a circle). */
export function propFootprintRect(kind: SceneryKind): FootprintRect {
  let r = rects.get(kind);
  if (!r) {
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (const b of propBoxes(kind)) {
      for (const p of boxFootprintCorners(b)) {
        x0 = Math.min(x0, p.x);
        x1 = Math.max(x1, p.x);
        z0 = Math.min(z0, p.z);
        z1 = Math.max(z1, p.z);
      }
    }
    r = { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, hx: (x1 - x0) / 2, hz: (z1 - z0) / 2 };
    rects.set(kind, r);
  }
  return r;
}

/** A roof must leave at least this much room (m, each side of the centre) for a body to lie on it. */
const MIN_ROOF_ROOM = 0.5;

/**
 * Where something can lie on top of a building, in the building's local frame: the roof's top face height
 * `top` above the ground, and the rectangle (centre `cx`, `cz`, half sizes `halfX`, `halfZ`) its reference point may
 * be in so that a body reaching `reach` m from that point (any direction) stays on the roof. Null when the
 * kind has no roof, or the roof is too small for such a body (a shed's roof is 3.8 m wide).
 */
export interface RoofSpot {
  top: number;
  cx: number;
  cz: number;
  halfX: number;
  halfZ: number;
}

export function rooftopSpot(kind: SceneryKind, reach: number): RoofSpot | null {
  const roof = propBoxes(kind).find((b) => b.part === 'roof');
  if (!roof) return null;
  const halfX = roof.halfSize.x - reach;
  const halfZ = roof.halfSize.z - reach;
  // A body that fits with only centimetres to spare is no place to lie: it needs room to pick a spot in.
  if (halfX < MIN_ROOF_ROOM || halfZ < MIN_ROOF_ROOM) return null;
  return { top: roof.center.y + roof.halfSize.y, cx: roof.center.x, cz: roof.center.z, halfX, halfZ };
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
    yaw: yaw + (b.yaw ?? 0),
  };
}

/**
 * World colliders of a prop, one per local box: houses, sheds and walls are 'wall', vehicles 'metal'; military
 * hardware is 'metal' except sandbags, barriers, crates and canvas ('wall'), box by box where a kind mixes them.
 */
export function propColliders(p: SceneryPlacement, groundY: number): Obstacle[] {
  return propBoxes(p.kind).map((b, i) => ({
    id: `${p.id}:${i}`,
    material: materialOf(p.kind, b),
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
