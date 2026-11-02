import * as THREE from 'three';
import { propBoxes } from '../mission/props';
import type { BoxPart, LocalBox, PropKind, PropPlacement } from '../mission/props';
import type { ThemeId } from '../mission/themes';

// Low-poly meshes for the scenery (houses, sheds, compound walls, parked trucks and jeeps) and for the
// vehicle targets. Every mesh that stands for a collider is a box built from `propBoxes(kind)`
// (src/mission/props.ts is THE dimension source), so a bullet stops exactly where the model ends.
// Anything extra is a thin decoration (doors, windows, grilles, ...) that sits flush on one of those
// boxes (at most 2 cm proud of it) or below the ground (the foundation skirt); decorations carry no
// `userData.boxIndex`. Geometry (one unit cube) and materials are shared between all instances.

/** How far a decoration stands proud of the face it sits on, m (<= 3 cm: visible geometry bullets would pass through). */
const DECAL_PROUD = 0.02;
/** Foundation under houses, sheds and walls: they stand on any slope without floating corners, m. */
const SKIRT_DEPTH = 0.6;

// ---------------------------------------------------------------------------------------------
// Palettes. Hex colours are sRGB, like the dummy's.

type Building = 'house' | 'wall' | 'shed';

interface BuildingPalette {
  wall: number;
  roof: number;
}

const BUILDING_PALETTES: Record<ThemeId, Record<Building, BuildingPalette>> = {
  // Desert: mud brick and tan, flat mud roofs.
  desert: {
    house: { wall: 0xb89a6c, roof: 0x937852 },
    wall: { wall: 0xa88b60, roof: 0xa88b60 },
    shed: { wall: 0xc2b184, roof: 0xa8956b },
  },
  // Arctic: dark timber under snow.
  arctic: {
    house: { wall: 0x4a3a2e, roof: 0xdde3ea },
    wall: { wall: 0x54443a, roof: 0x54443a },
    shed: { wall: 0x3f3329, roof: 0xd3dae2 },
  },
  // Valley: stone and white render under red tiles.
  valley: {
    house: { wall: 0xe0dac9, roof: 0x9c3e30 },
    wall: { wall: 0x8a8478, roof: 0x8a8478 },
    shed: { wall: 0x7c6246, roof: 0x8b3a2c },
  },
};

interface VehiclePalette {
  /** Bed, tub and bonnet. */
  paint: number;
  /** The truck's cab. */
  cab: number;
}

const VEHICLE_PALETTES: Record<ThemeId, VehiclePalette> = {
  desert: { paint: 0xb09a6a, cab: 0x9c8a5c }, // sand and khaki
  arctic: { paint: 0xc4cacf, cab: 0xa3abb1 }, // white and grey
  valley: { paint: 0x5e6439, cab: 0x4a5430 }, // olive and green
};

const TYRE = 0x1c1c1c;
const GLASS = 0x1d2830;
const GRILLE = 0x181818;
const LIGHT = 0xe8e2c4;
const DOORS: Record<ThemeId, number> = { desert: 0x4a3626, arctic: 0x2a2018, valley: 0x4b3224 };
const FLAP = 0x3a3326;
const INTERIOR = 0x24231d;

/** Instances of one kind differ a little in lightness (picked from the id, so it is deterministic). */
const SHADES: readonly number[] = [0.92, 1, 1.07];

function hashId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------------------------
// Shared geometry and materials

let unitBox: THREE.BoxGeometry | null = null;
const materials = new Map<string, THREE.MeshLambertMaterial>();

function sharedBox(): THREE.BoxGeometry {
  unitBox ??= new THREE.BoxGeometry(1, 1, 1);
  return unitBox;
}

function material(key: string, hex: number, shade = 1, emissive = 0): THREE.MeshLambertMaterial {
  const cacheKey = `${key}|${shade}`;
  let m = materials.get(cacheKey);
  if (!m) {
    const c = new THREE.Color(hex);
    c.setRGB(Math.min(1, c.r * shade), Math.min(1, c.g * shade), Math.min(1, c.b * shade));
    m = new THREE.MeshLambertMaterial({ color: c, flatShading: true });
    if (emissive !== 0) m.emissive.setHex(emissive);
    materials.set(cacheKey, m);
  }
  return m;
}

/** The material of a collider box, by prop kind, theme and part. */
function boxMaterial(kind: PropKind, part: BoxPart, theme: ThemeId, shade: number): THREE.MeshLambertMaterial {
  const key = `${theme}|${kind}|${part}`;
  if (kind === 'truck' || kind === 'jeep') {
    const p = VEHICLE_PALETTES[theme];
    switch (part) {
      case 'wheel':
        return material('tyre', TYRE, 1);
      case 'glass':
        return material('glass', GLASS, 1);
      case 'cab':
        return material(key, p.cab, shade);
      default:
        return material(key, p.paint, shade); // hull (bed, tub) and engine (bonnet)
    }
  }
  const p = BUILDING_PALETTES[theme][kind];
  return material(key, part === 'roof' ? p.roof : p.wall, shade);
}

// ---------------------------------------------------------------------------------------------
// Decorations

type Face = '+x' | '-x' | '+z' | '+y';
type DecalKind = 'glass' | 'door' | 'grille' | 'light' | 'flap' | 'interior';

interface Decal {
  name: string;
  /** The collider box it sits on: the first box with this part (houses and sheds: the wall box, vehicles: the named part). */
  on: BoxPart;
  face: Face;
  /** Fractions across the face: u along its width, v along its height (y), or along z for the top face. */
  u0: number;
  u1: number;
  v0: number;
  v1: number;
  kind: DecalKind;
}

const d = (name: string, on: BoxPart, face: Face, u0: number, u1: number, v0: number, v1: number, kind: DecalKind): Decal => ({
  name,
  on,
  face,
  u0,
  u1,
  v0,
  v1,
  kind,
});

const DECALS: Record<PropKind, readonly Decal[]> = {
  house: [
    d('door', 'wall', '+z', 0.43, 0.57, 0, 0.72, 'door'),
    d('front window left', 'wall', '+z', 0.14, 0.27, 0.42, 0.72, 'glass'),
    d('front window right', 'wall', '+z', 0.73, 0.86, 0.42, 0.72, 'glass'),
    d('side window +x', 'wall', '+x', 0.38, 0.62, 0.42, 0.72, 'glass'),
    d('side window -x', 'wall', '-x', 0.38, 0.62, 0.42, 0.72, 'glass'),
  ],
  wall: [],
  shed: [d('flap', 'wall', '+z', 0.3, 0.7, 0, 0.75, 'flap')],
  truck: [
    d('windshield', 'cab', '+z', 0.1, 0.9, 0.58, 0.92, 'glass'), // above the engine block (its top is at y 1.8)
    d('cab window +x', 'cab', '+x', 0.15, 0.7, 0.6, 0.9, 'glass'),
    d('cab window -x', 'cab', '-x', 0.15, 0.7, 0.6, 0.9, 'glass'),
    d('grille', 'engine', '+z', 0.15, 0.85, 0.2, 0.62, 'grille'),
    d('headlight left', 'engine', '+z', 0.03, 0.13, 0.68, 0.9, 'light'),
    d('headlight right', 'engine', '+z', 0.87, 0.97, 0.68, 0.9, 'light'),
  ],
  jeep: [
    d('grille', 'engine', '+z', 0.2, 0.8, 0.22, 0.7, 'grille'),
    d('headlight left', 'engine', '+z', 0.04, 0.16, 0.72, 0.95, 'light'),
    d('headlight right', 'engine', '+z', 0.84, 0.96, 0.72, 0.95, 'light'),
    d('interior', 'hull', '+y', 0.12, 0.88, 0.1, 0.88, 'interior'),
  ],
};

function decalMaterial(kind: DecalKind, theme: ThemeId): THREE.MeshLambertMaterial {
  switch (kind) {
    case 'glass':
      return material('glass', GLASS, 1);
    case 'door':
      return material(`door|${theme}`, DOORS[theme], 1);
    case 'grille':
      return material('grille', GRILLE, 1);
    case 'light':
      return material('light', LIGHT, 1, 0x3a3624);
    case 'flap':
      return material('flap', FLAP, 1);
    case 'interior':
      return material('interior', INTERIOR, 1);
  }
}

/** Centre and half-size (prop frame) of a decoration lying on a face of `b`, centred on the face plane. */
function decalBox(b: LocalBox, face: Face, u0: number, u1: number, v0: number, v1: number): { center: THREE.Vector3; half: THREE.Vector3 } {
  const t = DECAL_PROUD;
  const lerp = (lo: number, hi: number, f: number): number => lo + (hi - lo) * f;
  const { center: c, halfSize: h } = b;
  if (face === '+y') {
    const x0 = lerp(c.x - h.x, c.x + h.x, u0);
    const x1 = lerp(c.x - h.x, c.x + h.x, u1);
    const z0 = lerp(c.z - h.z, c.z + h.z, v0);
    const z1 = lerp(c.z - h.z, c.z + h.z, v1);
    return { center: new THREE.Vector3((x0 + x1) / 2, c.y + h.y, (z0 + z1) / 2), half: new THREE.Vector3(Math.abs(x1 - x0) / 2, t, Math.abs(z1 - z0) / 2) };
  }
  const y0 = lerp(c.y - h.y, c.y + h.y, v0);
  const y1 = lerp(c.y - h.y, c.y + h.y, v1);
  if (face === '+z') {
    const x0 = lerp(c.x - h.x, c.x + h.x, u0);
    const x1 = lerp(c.x - h.x, c.x + h.x, u1);
    return { center: new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, c.z + h.z), half: new THREE.Vector3(Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, t) };
  }
  // Side faces: u runs along z.
  const z0 = lerp(c.z - h.z, c.z + h.z, u0);
  const z1 = lerp(c.z - h.z, c.z + h.z, u1);
  const x = face === '+x' ? c.x + h.x : c.x - h.x;
  return { center: new THREE.Vector3(x, (y0 + y1) / 2, (z0 + z1) / 2), half: new THREE.Vector3(t, Math.abs(y1 - y0) / 2, Math.abs(z1 - z0) / 2) };
}

// ---------------------------------------------------------------------------------------------

/** `cast`: the box casts a shadow (the body boxes do; thin decorations and the foundation only take them). */
function addBox(
  group: THREE.Group,
  center: THREE.Vector3,
  half: THREE.Vector3,
  mat: THREE.Material,
  name: string,
  cast = false,
  receive = true,
): THREE.Mesh {
  const mesh = new THREE.Mesh(sharedBox(), mat);
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
  mesh.position.copy(center);
  mesh.scale.set(half.x * 2, half.y * 2, half.z * 2);
  mesh.name = name;
  mesh.matrixAutoUpdate = false; // static scenery
  mesh.updateMatrix();
  group.add(mesh);
  return mesh;
}

/**
 * The mesh of a prop: a group at the footprint centre (ground height `groundY`) turned by the placement
 * yaw, holding one box mesh per collider box (tagged with `userData.boxIndex` and `userData.part`) plus
 * the decorations. Vehicles include their engine block (the last box). The body boxes cast and receive
 * sun shadows (not the tyres, which only receive); decorations only receive.
 */
export function createPropMesh(p: PropPlacement, groundY: number, theme: ThemeId): THREE.Group {
  const group = new THREE.Group();
  group.name = `prop:${p.id}`;
  group.userData.kind = p.kind;
  group.position.set(p.x, groundY, p.z);
  group.rotation.y = p.yaw;

  const shade = SHADES[hashId(p.id) % SHADES.length];
  const boxes = propBoxes(p.kind);
  boxes.forEach((b, i) => {
    const mesh = addBox(
      group,
      new THREE.Vector3(b.center.x, b.center.y, b.center.z),
      new THREE.Vector3(b.halfSize.x, b.halfSize.y, b.halfSize.z),
      boxMaterial(p.kind, b.part, theme, shade),
      `${p.kind} ${b.part}`,
      b.part !== 'wheel', // tyres are small and sit in the hull's own shadow: one shadow-pass draw less each
    );
    mesh.userData.boxIndex = i;
    mesh.userData.part = b.part;
  });

  for (const decal of DECALS[p.kind]) {
    const on = boxes.find((b) => b.part === decal.on);
    if (!on) continue;
    const { center, half } = decalBox(on, decal.face, decal.u0, decal.u1, decal.v0, decal.v1);
    addBox(group, center, half, decalMaterial(decal.kind, theme), decal.name);
  }

  if (p.kind === 'house' || p.kind === 'shed' || p.kind === 'wall') {
    const wall = boxes[0];
    addBox(
      group,
      new THREE.Vector3(wall.center.x, -SKIRT_DEPTH / 2, wall.center.z),
      new THREE.Vector3(wall.halfSize.x, SKIRT_DEPTH / 2, wall.halfSize.z),
      boxMaterial(p.kind, 'wall', theme, shade),
      'foundation',
      false,
      false, // below the ground
    );
  }
  return group;
}
