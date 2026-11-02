import * as THREE from 'three';
import { propBoxes } from '../mission/props';
import type { LocalBox, PropKind, PropPlacement } from '../mission/props';
import type { ThemeId } from '../mission/themes';
import { PART_CLASSES, boxProjectUV, classTint, propMaterial } from './materials';
import type { PartClass } from './materials';

// Meshes for the scenery (houses, sheds, compound walls, parked trucks and jeeps) and for the vehicle
// targets. Every mesh that stands for a collider is a box of `propBoxes(kind)` (src/mission/props.ts is THE
// dimension source), so a bullet stops exactly where the model ends. Everything else is a thin decoration that
// lies on one of those boxes: window and door frames, sills, quoins, plinths, roof rims and seams, rooftop
// plates, bumpers, lamps, mirror plates, mudguards. A decoration stands less than 3 cm (DECOR_PROUD) proud of
// the collider box it lies on, or is entirely below the ground (the foundation skirt). Nothing rises higher:
// a tank or an antenna on a roof would be geometry no bullet can hit, and rooftop snipers lie on those roofs.
//
// All parts of a prop (boxes and prisms, in the prop frame) are listed by `propParts` (pure, cached) and baked
// into one geometry per material class (scene/materials.ts), with world-scale UVs and vertex colours for the
// per-part tones, so a house costs five draw calls and a truck five (the engine block stays a mesh of its own:
// the vehicle target swaps its material when it is disabled). Geometry and materials are shared between all
// instances of a kind, theme and shade.

/** How far a decoration stands proud of the face it lies on, m (< 3 cm: visible geometry bullets would pass through). */
export const DECOR_PROUD = 0.028;
/** Foundation under houses, sheds and walls: they stand on any slope without floating corners, m. */
const SKIRT_DEPTH = 0.6;

// ---------------------------------------------------------------------------------------------
// Palettes. Hex colours are sRGB.

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
  /** Cargo tarp. */
  tarp: number;
}

const VEHICLE_PALETTES: Record<ThemeId, VehiclePalette> = {
  desert: { paint: 0xb09a6a, cab: 0x9c8a5c, tarp: 0x857a58 }, // sand and khaki
  arctic: { paint: 0xc4cacf, cab: 0xa3abb1, tarp: 0xb9beb8 }, // white and grey
  valley: { paint: 0x5e6439, cab: 0x4a5430, tarp: 0x434b2f }, // olive and green
};

/** Trim of the buildings: frames, sills, doors, shutters, corner quoins, roof edges. */
interface Style {
  frame: number;
  sill: number;
  door: number;
  shutter: number | null;
  /** Corner quoins (a wall-class colour: a plaster or timber tone). */
  quoin: number;
  /** Fascia board along the roof slab's edge, or null (bare mud edge). */
  fascia: number | null;
  /** Rim along the roof's top edge. */
  rim: number;
}

const STYLES: Record<ThemeId, Style> = {
  desert: { frame: 0x3b2d21, sill: 0xd9c9a4, door: 0x4a3626, shutter: null, quoin: 0xd6c498, fascia: null, rim: 0xb59a6e },
  arctic: { frame: 0xcfc9bd, sill: 0xcfc9bd, door: 0x5a2b23, shutter: null, quoin: 0x2b2119, fascia: 0x2b2119, rim: 0xeef2f6 },
  valley: { frame: 0xf0ece0, sill: 0xf4f0e6, door: 0x4b3224, shutter: 0x3e5a3a, quoin: 0x9a9482, fascia: 0xf0ece0, rim: 0xb04838 },
};

const DARK = 0x1b1c1d;
const RUBBER = 0x1c1c1c;
const CHROME = 0x7d8084;
const LAMP = 0xe8e2c4;
const TAIL = 0x9b1c16;
const INTERIOR = 0x24231d;
const FLAP = 0x3a3326;
const GLASS_COLOUR = 0x3a4d5c;

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

/** A hex colour scaled in lightness (sRGB channels, clamped). */
function scaled(hex: number, k: number): number {
  const r = Math.min(255, Math.round(((hex >> 16) & 255) * k));
  const g = Math.min(255, Math.round(((hex >> 8) & 255) * k));
  const b = Math.min(255, Math.round((hex & 255) * k));
  return (r << 16) | (g << 8) | b;
}

// ---------------------------------------------------------------------------------------------
// Parts: boxes and prisms of a prop, in its local frame

type Face = '+x' | '-x' | '+z' | '-z' | '+y';

interface Vec {
  x: number;
  y: number;
  z: number;
}

/** One box (or, `shape: 'cyl'`, a 12-sided prism along `axis` inside the same bounding box) of a prop. */
export interface PropPart {
  name: string;
  cls: PartClass;
  shape: 'box' | 'cyl';
  axis: 'x' | 'y' | 'z';
  /** Bounding box, local frame. */
  center: Vec;
  half: Vec;
  /** The colour this part has on average (sRGB hex). */
  color: number;
  /** Index into `propBoxes(kind)` when the part IS a collider box; decorations have none. */
  box?: number;
  /** The vehicle's engine block (a mesh of its own). */
  engine?: boolean;
}

class Parts {
  readonly list: PropPart[] = [];

  constructor(private readonly boxes: readonly LocalBox[]) {}

  /** Collider box `i` itself. */
  collider(i: number, cls: PartClass, color: number): void {
    const b = this.boxes[i];
    this.list.push({
      name: b.part,
      cls,
      shape: 'box',
      axis: 'y',
      center: { ...b.center },
      half: { ...b.halfSize },
      color,
      box: i,
      engine: b.part === 'engine',
    });
  }

  /** A box from its corners (local frame). */
  box(name: string, cls: PartClass, color: number, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): void {
    this.list.push({
      name,
      cls,
      shape: 'box',
      axis: 'y',
      center: { x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: (z0 + z1) / 2 },
      half: { x: Math.abs(x1 - x0) / 2, y: Math.abs(y1 - y0) / 2, z: Math.abs(z1 - z0) / 2 },
      color,
    });
  }

  /**
   * A thin plate on a face of collider box `on`, `proud` m out from it. Along the face: ±z faces run in x (a)
   * and y (b); ±x faces in z (a) and y (b); the top face in x (a) and z (b). Absolute local coordinates.
   */
  plate(name: string, cls: PartClass, color: number, on: LocalBox, face: Face, a0: number, a1: number, b0: number, b1: number, proud = DECOR_PROUD): void {
    const c = on.center;
    const h = on.halfSize;
    switch (face) {
      case '+z':
        this.box(name, cls, color, a0, a1, b0, b1, c.z + h.z, c.z + h.z + proud);
        break;
      case '-z':
        this.box(name, cls, color, a0, a1, b0, b1, c.z - h.z - proud, c.z - h.z);
        break;
      case '+x':
        this.box(name, cls, color, c.x + h.x, c.x + h.x + proud, b0, b1, a0, a1);
        break;
      case '-x':
        this.box(name, cls, color, c.x - h.x - proud, c.x - h.x, b0, b1, a0, a1);
        break;
      case '+y':
        this.box(name, cls, color, a0, a1, c.y + h.y, c.y + h.y + proud, b0, b1);
        break;
    }
  }

  /** A round disc (12-sided prism) of radius `r` on a face of `on`, centred at (a, b) along the face (as in `plate`). */
  disc(name: string, cls: PartClass, color: number, on: LocalBox, face: Face, a: number, b: number, r: number, proud = DECOR_PROUD): void {
    const c = on.center;
    const h = on.halfSize;
    const d = proud / 2;
    let center: Vec;
    let half: Vec;
    let axis: 'x' | 'y' | 'z';
    switch (face) {
      case '+z':
      case '-z':
        center = { x: a, y: b, z: face === '+z' ? c.z + h.z + d : c.z - h.z - d };
        half = { x: r, y: r, z: d };
        axis = 'z';
        break;
      case '+x':
      case '-x':
        center = { x: face === '+x' ? c.x + h.x + d : c.x - h.x - d, y: b, z: a };
        half = { x: d, y: r, z: r };
        axis = 'x';
        break;
      case '+y':
        center = { x: a, y: c.y + h.y + d, z: b };
        half = { x: r, y: d, z: r };
        axis = 'y';
        break;
    }
    this.list.push({ name, cls, shape: 'cyl', axis, center, half, color });
  }

  /**
   * A window: a glass pane, a frame of four bars around it, a sill under it and a lintel over it, optional
   * mullions and shutters. `c`: centre along the face (x for ±z faces, z for ±x faces), `y0`: height of the pane's lower edge.
   */
  window(on: LocalBox, face: Face, c: number, y0: number, w: number, h: number, st: Style, opts: { mullions?: boolean; shutters?: boolean } = {}): void {
    const bar = 0.1;
    const a0 = c - w / 2;
    const a1 = c + w / 2;
    const y1 = y0 + h;
    this.plate('window glass', 'glass', GLASS_COLOUR, on, face, a0, a1, y0, y1, 0.012);
    this.plate('window frame left', 'trim', st.frame, on, face, a0 - bar, a0, y0 - bar, y1 + bar);
    this.plate('window frame right', 'trim', st.frame, on, face, a1, a1 + bar, y0 - bar, y1 + bar);
    this.plate('window frame top', 'trim', st.frame, on, face, a0, a1, y1, y1 + bar);
    this.plate('window frame bottom', 'trim', st.frame, on, face, a0, a1, y0 - bar, y0);
    this.plate('window sill', 'trim', st.sill, on, face, a0 - bar - 0.07, a1 + bar + 0.07, y0 - bar - 0.06, y0 - bar);
    this.plate('window lintel', 'trim', st.sill, on, face, a0 - bar - 0.05, a1 + bar + 0.05, y1 + bar, y1 + bar + 0.08, 0.024);
    if (opts.mullions) {
      this.plate('window mullion', 'trim', st.frame, on, face, c - 0.025, c + 0.025, y0, y1, 0.02);
      this.plate('window transom', 'trim', st.frame, on, face, a0, a1, y0 + h * 0.5 - 0.025, y0 + h * 0.5 + 0.025, 0.02);
    }
    if (opts.shutters && st.shutter !== null) {
      const sw = w / 2;
      this.plate('shutter left', 'trim', st.shutter, on, face, a0 - bar - sw, a0 - bar, y0 - bar, y1 + bar, 0.022);
      this.plate('shutter right', 'trim', st.shutter, on, face, a1 + bar, a1 + bar + sw, y0 - bar, y1 + bar, 0.022);
    }
  }

  /** A door: leaf with panels, frame, lintel, threshold and handle. `c`: centre along the face. */
  door(on: LocalBox, face: Face, c: number, w: number, h: number, st: Style): void {
    const bar = 0.1;
    const a0 = c - w / 2;
    const a1 = c + w / 2;
    this.plate('door leaf', 'trim', st.door, on, face, a0, a1, 0, h, 0.018);
    const panel = scaled(st.door, 0.78);
    for (const [pa0, pa1] of [
      [a0 + 0.1, c - 0.04],
      [c + 0.04, a1 - 0.1],
    ]) {
      this.plate('door panel upper', 'trim', panel, on, face, pa0, pa1, h * 0.56, h - 0.12, 0.026);
      this.plate('door panel lower', 'trim', panel, on, face, pa0, pa1, 0.12, h * 0.5, 0.026);
    }
    this.plate('door frame left', 'trim', st.frame, on, face, a0 - bar, a0, 0, h + bar);
    this.plate('door frame right', 'trim', st.frame, on, face, a1, a1 + bar, 0, h + bar);
    this.plate('door frame top', 'trim', st.frame, on, face, a0, a1, h, h + bar);
    this.plate('door lintel', 'trim', st.sill, on, face, a0 - bar - 0.06, a1 + bar + 0.06, h + bar, h + bar + 0.09, 0.024);
    this.plate('door threshold', 'trim', st.sill, on, face, a0 - bar, a1 + bar, 0, 0.05);
    this.plate('door handle', 'plain', 0xb0a070, on, face, a1 - 0.2, a1 - 0.1, h * 0.46, h * 0.46 + 0.07);
  }
}

// ---------------------------------------------------------------------------------------------
// Buildings

/** The wall box of a building and its roof slab (if any), with their trim. */
function buildingParts(kind: Building, theme: ThemeId): Parts {
  const boxes = propBoxes(kind);
  const P = new Parts(boxes);
  const pal = BUILDING_PALETTES[theme][kind];
  const st = STYLES[theme];
  const W = boxes[0];
  const roofIndex = boxes.findIndex((b) => b.part === 'roof');
  const wx = W.halfSize.x;
  const wz = W.halfSize.z;
  const wTop = W.center.y + W.halfSize.y;

  P.collider(0, 'wall', pal.wall);
  if (roofIndex >= 0) P.collider(roofIndex, 'roof', pal.roof);

  // Foundation (below the ground: no collider, never seen on level ground, closes the gap on a slope).
  P.box('foundation', 'wall', pal.wall, W.center.x - wx, W.center.x + wx, -SKIRT_DEPTH, 0, W.center.z - wz, W.center.z + wz);

  if (kind === 'wall') {
    compoundWall(P, W, theme, pal);
    return P;
  }

  const stone = scaled(pal.wall, 0.62);
  // Plinth: a dark band round the foot, down into the skirt, with the front door gap left open.
  const plinthH = 0.5;
  const doorGap = kind === 'house' ? 0.7 : 0.8;
  P.plate('plinth front left', 'wall', stone, W, '+z', -wx, -doorGap, 0, plinthH, 0.02);
  P.plate('plinth front right', 'wall', stone, W, '+z', doorGap, wx, 0, plinthH, 0.02);
  P.plate('plinth back', 'wall', stone, W, '-z', -wx, wx, 0, plinthH, 0.02);
  P.plate('plinth +x', 'wall', stone, W, '+x', -wz, wz, 0, plinthH, 0.02);
  P.plate('plinth -x', 'wall', stone, W, '-x', -wz, wz, 0, plinthH, 0.02);

  // Corner quoins: a lighter (or timber) column at each corner, wrapping it.
  const q = kind === 'house' ? 0.28 : 0.22;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x0 = sx > 0 ? wx - q : -wx - DECOR_PROUD;
      const x1 = sx > 0 ? wx + DECOR_PROUD : -wx + q;
      const z0 = sz > 0 ? wz - q : -wz - DECOR_PROUD;
      const z1 = sz > 0 ? wz + DECOR_PROUD : -wz + q;
      P.box('corner quoin', 'wall', st.quoin, x0, x1, 0, wTop, z0, z1);
    }
  }

  if (kind === 'house') {
    P.door(W, '+z', 0, 1.0, 2.15, st);
    for (const sx of [-1, 1]) P.window(W, '+z', sx * 2.1, 1.0, 1.0, 1.2, st, { mullions: true, shutters: true });
    for (const sx of [-1, 1]) P.window(W, '-z', sx * 2.0, 1.0, 1.0, 1.2, st, { mullions: true, shutters: true });
    for (const face of ['+x', '-x'] as const) {
      for (const sz of [-1, 1]) P.window(W, face, sz * 1.25, 1.0, 0.9, 1.2, st, { mullions: true, shutters: true });
    }
  } else {
    // Shed / tent: a plank door, one small window per side.
    P.door(W, '+z', 0, 1.1, 1.7, { ...st, door: FLAP });
    for (const face of ['+x', '-x'] as const) P.window(W, face, 0, 0.95, 0.8, 0.6, st);
  }

  if (roofIndex >= 0) roofParts(P, boxes[roofIndex], kind === 'house' ? 'house' : 'shed', theme, st, pal);
  return P;
}

/** Roof slab details: fascia along the slab edge, a rim round the top, seams, and flat rooftop plates. */
function roofParts(P: Parts, R: LocalBox, kind: 'house' | 'shed', theme: ThemeId, st: Style, pal: BuildingPalette): void {
  const rx = R.halfSize.x;
  const rz = R.halfSize.z;
  const y0 = R.center.y - R.halfSize.y;
  const cx = R.center.x;
  const cz = R.center.z;
  const fasciaH = R.halfSize.y * 1.5;

  if (st.fascia !== null) {
    P.plate('fascia front', 'trim', st.fascia, R, '+z', cx - rx, cx + rx, y0, y0 + fasciaH, 0.02);
    P.plate('fascia back', 'trim', st.fascia, R, '-z', cx - rx, cx + rx, y0, y0 + fasciaH, 0.02);
    P.plate('fascia +x', 'trim', st.fascia, R, '+x', cz - rz, cz + rz, y0, y0 + fasciaH, 0.02);
    P.plate('fascia -x', 'trim', st.fascia, R, '-x', cz - rz, cz + rz, y0, y0 + fasciaH, 0.02);
  }

  // Rim round the top edge (parapet / eaves board / snow lip): 2.5 cm high.
  const rim = 0.18;
  const rimH = 0.025;
  P.plate('roof rim front', 'roof', st.rim, R, '+y', cx - rx, cx + rx, cz + rz - rim, cz + rz, rimH);
  P.plate('roof rim back', 'roof', st.rim, R, '+y', cx - rx, cx + rx, cz - rz, cz - rz + rim, rimH);
  P.plate('roof rim +x', 'roof', st.rim, R, '+y', cx + rx - rim, cx + rx, cz - rz + rim, cz + rz - rim, rimH);
  P.plate('roof rim -x', 'roof', st.rim, R, '+y', cx - rx, cx - rx + rim, cz - rz + rim, cz + rz - rim, rimH);

  const seam = scaled(pal.roof, 0.72);
  if (kind === 'shed') {
    // Corrugated sheet: seams across the roof.
    for (let x = cx - rx + 0.35; x < cx + rx - 0.2; x += 0.4) {
      P.plate('roof seam', 'roof', seam, R, '+y', x - 0.03, x + 0.03, cz - rz + rim, cz + rz - rim, 0.02);
    }
    return;
  }
  if (theme === 'valley') {
    // Red sheet roof: standing seams.
    for (let x = cx - rx + 0.5; x < cx + rx - 0.3; x += 0.5) {
      P.plate('roof seam', 'roof', seam, R, '+y', x - 0.025, x + 0.025, cz - rz + rim, cz + rz - rim, 0.02);
    }
  }
  // Flat rooftop plates (2-2.8 cm): hatch, air-conditioner with its fan, a tank's footprint, a chimney pad.
  const hatch = theme === 'arctic' ? 0x3a3733 : 0x2a2723;
  P.plate('roof hatch', 'plain', hatch, R, '+y', -2.6, -1.7, -2.3, -1.4, 0.02);
  P.plate('roof hatch lid', 'plain', scaled(hatch, 1.5), R, '+y', -2.5, -1.8, -2.2, -1.5, DECOR_PROUD);
  if (theme !== 'arctic') {
    P.plate('roof air conditioner', 'plain', 0xa9adb0, R, '+y', 1.7, 2.9, -2.4, -1.7, 0.02);
    P.disc('roof air conditioner fan', 'plain', 0x303234, R, '+y', 2.3, -2.05, 0.26, DECOR_PROUD);
    P.disc('roof tank footprint', 'plain', 0x7d8b92, R, '+y', -2.3, 1.2, 0.75, 0.02);
    P.disc('roof tank lid', 'plain', 0x95a3aa, R, '+y', -2.3, 1.2, 0.5, DECOR_PROUD);
  } else {
    P.plate('roof chimney pad', 'plain', 0x4a4540, R, '+y', 1.8, 2.6, -1.5, -0.7, DECOR_PROUD);
  }
}

/** The compound wall: coping, pilasters, a plinth, joint lines. */
function compoundWall(P: Parts, W: LocalBox, theme: ThemeId, pal: BuildingPalette): void {
  const wx = W.halfSize.x;
  const wz = W.halfSize.z;
  const top = W.center.y + W.halfSize.y;
  const lightWall = scaled(pal.wall, 1.16);
  const coping = theme === 'arctic' ? 0xe5ebf0 : lightWall; // arctic: snow on the cap
  P.box('coping', 'wall', coping, -wx - DECOR_PROUD, wx + DECOR_PROUD, top, top + DECOR_PROUD, -wz - DECOR_PROUD, wz + DECOR_PROUD);
  // Pilasters at both ends (wrapping the end faces) and in the middle.
  P.box('pilaster end -x', 'wall', lightWall, -wx - DECOR_PROUD, -wx + 0.4, 0, top + DECOR_PROUD, -wz - DECOR_PROUD, wz + DECOR_PROUD);
  P.box('pilaster end +x', 'wall', lightWall, wx - 0.4, wx + DECOR_PROUD, 0, top + DECOR_PROUD, -wz - DECOR_PROUD, wz + DECOR_PROUD);
  P.box('pilaster middle', 'wall', lightWall, -0.22, 0.22, 0, top + DECOR_PROUD, -wz - DECOR_PROUD, wz + DECOR_PROUD);
  // Plinth and joint lines on both faces.
  const stone = scaled(pal.wall, 0.62);
  const joint = scaled(pal.wall, 0.8);
  for (const face of ['+z', '-z'] as const) {
    P.plate('wall plinth', 'wall', stone, W, face, -wx + 0.4, wx - 0.4, 0, 0.3, 0.02);
    P.plate('wall joint', 'wall', joint, W, face, -wx + 0.4, wx - 0.4, 0.78, 0.81, 0.012);
  }
}

// ---------------------------------------------------------------------------------------------
// Vehicles

/** A wheel: a dark ring, the hub and its cap on the outer face, and a mudguard slab lying on the tyre's top. */
function wheelParts(P: Parts, wheel: LocalBox, paint: number, ringR: number, hubR: number): void {
  const outer: Face = wheel.center.x > 0 ? '+x' : '-x';
  const z = wheel.center.z;
  const y = wheel.center.y;
  P.disc('wheel ring', 'plain', 0x101010, wheel, outer, z, y, ringR, 0.01);
  P.disc('wheel hub', 'plain', 0x797c80, wheel, outer, z, y, hubR, 0.02);
  P.disc('wheel cap', 'plain', 0xa0a3a6, wheel, outer, z, y, hubR * 0.4, DECOR_PROUD);
  const top = wheel.center.y + wheel.halfSize.y;
  const x0 = wheel.center.x - wheel.halfSize.x - (outer === '-x' ? DECOR_PROUD : 0);
  const x1 = wheel.center.x + wheel.halfSize.x + (outer === '+x' ? DECOR_PROUD : 0);
  const hz = wheel.halfSize.z + DECOR_PROUD;
  P.box('mudguard', 'paint', scaled(paint, 0.85), x0, x1, top, top + DECOR_PROUD, z - hz, z + hz);
}

/** A window of a vehicle: glass with a thin dark frame. */
function vehicleWindow(P: Parts, on: LocalBox, face: Face, a0: number, a1: number, b0: number, b1: number, bar: number): void {
  P.plate('glass', 'glass', GLASS_COLOUR, on, face, a0, a1, b0, b1, 0.012);
  P.plate('window frame left', 'plain', DARK, on, face, a0 - bar, a0, b0 - bar, b1 + bar);
  P.plate('window frame right', 'plain', DARK, on, face, a1, a1 + bar, b0 - bar, b1 + bar);
  P.plate('window frame top', 'plain', DARK, on, face, a0, a1, b1, b1 + bar);
  P.plate('window frame bottom', 'plain', DARK, on, face, a0, a1, b0 - bar, b0);
}

function truckParts(theme: ThemeId): Parts {
  const boxes = propBoxes('truck');
  const P = new Parts(boxes);
  const pal = VEHICLE_PALETTES[theme];
  const find = (part: LocalBox['part']): LocalBox => boxes[boxes.findIndex((b) => b.part === part)];
  const hull = find('hull');
  const cab = find('cab');
  const engine = find('engine');
  boxes.forEach((b, i) => {
    if (b.part === 'hull' || b.part === 'engine') P.collider(i, 'paint', pal.paint);
    else if (b.part === 'cab') P.collider(i, 'paint', pal.cab);
    else P.collider(i, 'plain', RUBBER);
  });
  const hx = hull.halfSize.x;
  const hz0 = hull.center.z - hull.halfSize.z;
  const hz1 = hull.center.z + hull.halfSize.z;
  const hTop = hull.center.y + hull.halfSize.y;
  const hBot = hull.center.y - hull.halfSize.y;

  // Cargo bed: a tarp over it with ribs, stakes and rails along the sides, tailgate lines, tail lamps and bumper.
  P.plate('tarp', 'trim', pal.tarp, hull, '+y', -hx + 0.12, hx - 0.12, hz0 + 0.15, hz1 - 0.2, 0.02);
  for (let z = hz0 + 0.6; z < hz1 - 0.3; z += 0.7) {
    P.plate('tarp rib', 'plain', scaled(pal.tarp, 0.6), hull, '+y', -hx + 0.12, hx - 0.12, z - 0.03, z + 0.03, DECOR_PROUD);
  }
  for (const face of ['+x', '-x'] as const) {
    for (let z = hz0 + 0.3; z < hz1 - 0.1; z += 0.8) {
      P.plate('stake', 'paint', scaled(pal.paint, 0.72), hull, face, z - 0.04, z + 0.04, hBot, hTop, 0.024);
    }
    P.plate('bed rail', 'plain', DARK, hull, face, hz0, hz1, hTop - 0.06, hTop, 0.02);
  }
  P.plate('tailgate bottom', 'plain', DARK, hull, '-z', -hx, hx, hBot, hBot + 0.06, 0.02);
  P.plate('tailgate left', 'plain', DARK, hull, '-z', -hx, -hx + 0.06, hBot, hTop, 0.02);
  P.plate('tailgate right', 'plain', DARK, hull, '-z', hx - 0.06, hx, hBot, hTop, 0.02);
  P.plate('tailgate latch', 'plain', CHROME, hull, '-z', -0.1, 0.1, hTop - 0.16, hTop - 0.08);
  for (const s of [-1, 1]) P.plate('tail lamp', 'plain', TAIL, hull, '-z', s * 0.62 - 0.14, s * 0.62 + 0.14, 0.8, 0.98);
  P.plate('rear bumper', 'plain', scaled(CHROME, 0.7), hull, '-z', -hx, hx, hBot, hBot + 0.13);

  // Cab: windscreen, side windows with doors, mirrors, rear window, visor.
  const cz0 = cab.center.z - cab.halfSize.z;
  const cz1 = cab.center.z + cab.halfSize.z;
  const cTop = cab.center.y + cab.halfSize.y;
  const cx = cab.halfSize.x;
  vehicleWindow(P, cab, '+z', -0.95, 0.95, 1.95, 2.75, 0.07);
  P.plate('sun visor', 'paint', scaled(pal.cab, 0.7), cab, '+z', -cx, cx, cTop - 0.14, cTop);
  vehicleWindow(P, cab, '-z', -0.6, 0.6, 1.9, 2.6, 0.06);
  for (const face of ['+x', '-x'] as const) {
    vehicleWindow(P, cab, face, 0.55, 1.6, 1.95, 2.75, 0.06);
    P.plate('door seam front', 'plain', DARK, cab, face, 1.76, 1.79, 0.9, 2.9, 0.016);
    P.plate('door seam rear', 'plain', DARK, cab, face, 0.42, 0.45, 0.9, 2.9, 0.016);
    P.plate('door seam bottom', 'plain', DARK, cab, face, 0.42, 1.79, 0.9, 0.93, 0.016);
    P.plate('door handle', 'plain', CHROME, cab, face, 0.52, 0.74, 1.5, 1.56);
    P.plate('mirror', 'plain', DARK, cab, face, cz1 - 0.3, cz1 - 0.06, 2.0, 2.5);
    P.plate('step', 'plain', DARK, cab, face, cz0 + 0.5, cz1 - 0.5, 0.6, 0.72, 0.02);
  }
  P.plate('roof lamp bar', 'plain', DARK, cab, '+y', -0.6, 0.6, cz1 - 0.5, cz1 - 0.2, 0.02);

  // Engine block: bumper, grille with slats, headlamps, louvres and a hood ridge.
  const ex = engine.halfSize.x;
  const ez0 = engine.center.z - engine.halfSize.z;
  const ez1 = engine.center.z + engine.halfSize.z;
  const eBot = engine.center.y - engine.halfSize.y;
  P.plate('front bumper', 'plain', CHROME, engine, '+z', -ex - 0.03, ex + 0.03, eBot, eBot + 0.18);
  P.plate('grille', 'plain', 0x151617, engine, '+z', -0.62, 0.62, 0.95, 1.62, 0.012);
  for (let y = 1.05; y < 1.6; y += 0.17) P.plate('grille slat', 'plain', CHROME, engine, '+z', -0.62, 0.62, y, y + 0.04, 0.024);
  for (const s of [-1, 1]) {
    P.disc('headlamp bezel', 'plain', DARK, engine, '+z', s * 0.77, 1.55, 0.125, 0.02);
    P.disc('headlamp', 'plain', LAMP, engine, '+z', s * 0.77, 1.55, 0.095, DECOR_PROUD);
  }
  for (const face of ['+x', '-x'] as const) {
    for (let y = 1.25; y < 1.5; y += 0.1) P.plate('louvre', 'plain', DARK, engine, face, ez0 + 0.3, ez0 + 1.05, y, y + 0.04, 0.02);
    P.plate('wheel arch', 'plain', 0x151515, engine, face, ez0, ez0 + 0.75, 0.93, 1.12);
  }
  P.plate('hood ridge', 'plain', DARK, engine, '+y', -0.05, 0.05, ez0 + 0.1, ez1 - 0.1, 0.02);

  // Wheels: rings, hubs, caps, mudguards; dark arches over the rear wheels.
  for (const b of boxes) {
    if (b.part !== 'wheel') continue;
    wheelParts(P, b, pal.paint, 0.34, 0.24);
    if (b.center.z < 0) {
      P.plate('wheel arch', 'plain', 0x151515, hull, b.center.x > 0 ? '+x' : '-x', b.center.z - 0.5, b.center.z + 0.5, 0.93, 1.1);
    }
  }
  return P;
}

function jeepParts(theme: ThemeId): Parts {
  const boxes = propBoxes('jeep');
  const P = new Parts(boxes);
  const pal = VEHICLE_PALETTES[theme];
  const find = (part: LocalBox['part']): LocalBox => boxes[boxes.findIndex((b) => b.part === part)];
  const hull = find('hull');
  const glass = find('glass');
  const engine = find('engine');
  boxes.forEach((b, i) => {
    if (b.part === 'hull' || b.part === 'engine') P.collider(i, 'paint', pal.paint);
    else if (b.part === 'glass') P.collider(i, 'glass', GLASS_COLOUR);
    else P.collider(i, 'plain', RUBBER);
  });
  const hx = hull.halfSize.x;
  const hz0 = hull.center.z - hull.halfSize.z;
  const hz1 = hull.center.z + hull.halfSize.z;
  const hTop = hull.center.y + hull.halfSize.y;
  const hBot = hull.center.y - hull.halfSize.y;

  // Open tub: seats, dashboard, steering wheel, floor.
  const seat = scaled(INTERIOR, 1.3);
  P.plate('floor', 'plain', INTERIOR, hull, '+y', -hx + 0.05, hx - 0.05, hz0 + 0.05, hz1 - 0.35, 0.01);
  for (const s of [-1, 1]) P.plate('seat', 'plain', seat, hull, '+y', s * 0.4 - 0.3, s * 0.4 + 0.3, hz1 - 1.35, hz1 - 0.7, DECOR_PROUD);
  P.plate('rear bench', 'plain', seat, hull, '+y', -hx + 0.1, hx - 0.1, hz0 + 0.4, hz0 + 1.0, DECOR_PROUD);
  P.plate('dashboard', 'plain', scaled(INTERIOR, 0.9), hull, '+y', -hx + 0.05, hx - 0.05, hz1 - 0.3, hz1, DECOR_PROUD);
  P.disc('steering wheel', 'plain', 0x151515, hull, '+y', -0.4, hz1 - 0.5, 0.17, DECOR_PROUD);
  for (const face of ['+x', '-x'] as const) {
    P.plate('door seam front', 'plain', DARK, hull, face, 0.5, 0.53, 0.5, hTop, 0.016);
    P.plate('door seam rear', 'plain', DARK, hull, face, -0.95, -0.92, 0.5, hTop, 0.016);
    P.plate('door seam bottom', 'plain', DARK, hull, face, -0.95, 0.53, 0.5, 0.53, 0.016);
    P.plate('door handle', 'plain', CHROME, hull, face, -0.8, -0.62, 0.98, 1.03);
    P.plate('side rail', 'plain', DARK, hull, face, hz0, hz1, hTop - 0.05, hTop, 0.02);
  }
  // Tailgate: a spare wheel, tail lamps, bumper.
  P.disc('spare tyre', 'plain', RUBBER, hull, '-z', 0, 0.82, 0.33, DECOR_PROUD);
  P.disc('spare hub', 'plain', 0x797c80, hull, '-z', 0, 0.82, 0.15, DECOR_PROUD);
  for (const s of [-1, 1]) P.plate('tail lamp', 'plain', TAIL, hull, '-z', s * 0.66 - 0.12, s * 0.66 + 0.12, 0.92, 1.05);
  P.plate('rear bumper', 'plain', scaled(CHROME, 0.7), hull, '-z', -hx - 0.03, hx + 0.03, hBot, hBot + 0.12);

  // Windscreen: a frame round the glass box.
  const gx = glass.halfSize.x;
  const gTop = glass.center.y + glass.halfSize.y;
  P.plate('screen frame top', 'plain', DARK, glass, '+z', -gx, gx, gTop - 0.07, gTop);
  P.plate('screen frame left', 'plain', DARK, glass, '+z', -gx, -gx + 0.07, hTop, gTop);
  P.plate('screen frame right', 'plain', DARK, glass, '+z', gx - 0.07, gx, hTop, gTop);

  // Bonnet: bumper, grille with slats, headlamps, louvres, a hood ridge.
  const ex = engine.halfSize.x;
  const ez0 = engine.center.z - engine.halfSize.z;
  const ez1 = engine.center.z + engine.halfSize.z;
  const eBot = engine.center.y - engine.halfSize.y;
  P.plate('front bumper', 'plain', CHROME, engine, '+z', -ex - 0.03, ex + 0.03, eBot, eBot + 0.13);
  P.plate('grille', 'plain', 0x151617, engine, '+z', -0.4, 0.4, 0.72, 1.0, 0.012);
  for (let x = -0.36; x < 0.4; x += 0.12) P.plate('grille slat', 'plain', CHROME, engine, '+z', x - 0.015, x + 0.015, 0.72, 1.0, 0.024);
  for (const s of [-1, 1]) {
    P.disc('headlamp bezel', 'plain', DARK, engine, '+z', s * 0.52, 0.95, 0.115, 0.02);
    P.disc('headlamp', 'plain', LAMP, engine, '+z', s * 0.52, 0.95, 0.085, DECOR_PROUD);
  }
  for (const face of ['+x', '-x'] as const) {
    for (let y = 0.8; y < 1.05; y += 0.09) P.plate('louvre', 'plain', DARK, engine, face, ez0 + 0.3, ez0 + 0.95, y, y + 0.035, 0.02);
  }
  P.plate('hood ridge', 'plain', scaled(pal.paint, 0.7), engine, '+y', -0.04, 0.04, ez0 + 0.1, ez1 - 0.1, 0.02);

  for (const b of boxes) {
    if (b.part === 'wheel') wheelParts(P, b, pal.paint, 0.24, 0.17);
  }
  return P;
}

const partsCache = new Map<string, readonly PropPart[]>();

/**
 * Every part of a prop in its local frame: the collider boxes (with their `box` index) and the decorations.
 * Pure and cached; the meshes are baked from it, and the tests check it against the colliders.
 */
export function propParts(kind: PropKind, theme: ThemeId): readonly PropPart[] {
  const key = `${kind}|${theme}`;
  let parts = partsCache.get(key);
  if (!parts) {
    switch (kind) {
      case 'truck':
        parts = truckParts(theme).list;
        break;
      case 'jeep':
        parts = jeepParts(theme).list;
        break;
      default:
        parts = buildingParts(kind, theme).list;
    }
    partsCache.set(key, parts);
  }
  return parts;
}

// ---------------------------------------------------------------------------------------------
// Baking: one geometry per material class

type MeshKey = PartClass | 'engine';

interface Accumulator {
  pos: number[];
  nor: number[];
  uv: number[];
  col: number[];
  idx: number[];
}

const newAcc = (): Accumulator => ({ pos: [], nor: [], uv: [], col: [], idx: [] });

// Box faces: outward normal n, in-plane axes a x b = n (counter-clockwise seen from outside).
const FACES: ReadonlyArray<{ n: Vec; a: Vec; b: Vec }> = [
  { n: { x: 1, y: 0, z: 0 }, a: { x: 0, y: 1, z: 0 }, b: { x: 0, y: 0, z: 1 } },
  { n: { x: -1, y: 0, z: 0 }, a: { x: 0, y: 0, z: 1 }, b: { x: 0, y: 1, z: 0 } },
  { n: { x: 0, y: 1, z: 0 }, a: { x: 0, y: 0, z: 1 }, b: { x: 1, y: 0, z: 0 } },
  { n: { x: 0, y: -1, z: 0 }, a: { x: 1, y: 0, z: 0 }, b: { x: 0, y: 0, z: 1 } },
  { n: { x: 0, y: 0, z: 1 }, a: { x: 1, y: 0, z: 0 }, b: { x: 0, y: 1, z: 0 } },
  { n: { x: 0, y: 0, z: -1 }, a: { x: 0, y: 1, z: 0 }, b: { x: 1, y: 0, z: 0 } },
];

const CORNERS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];

const uvScratch = { u: 0, v: 0 };

function pushVertex(acc: Accumulator, x: number, y: number, z: number, nx: number, ny: number, nz: number, c: THREE.Color): number {
  const i = acc.pos.length / 3;
  acc.pos.push(x, y, z);
  acc.nor.push(nx, ny, nz);
  boxProjectUV(x, y, z, nx, ny, nz, undefined, uvScratch);
  acc.uv.push(uvScratch.u, uvScratch.v);
  acc.col.push(c.r, c.g, c.b);
  return i;
}

function addBox(acc: Accumulator, part: PropPart, c: THREE.Color): void {
  const { center: m, half: h } = part;
  for (const f of FACES) {
    const hn = Math.abs(f.n.x * h.x + f.n.y * h.y + f.n.z * h.z);
    const ha = Math.abs(f.a.x * h.x + f.a.y * h.y + f.a.z * h.z);
    const hb = Math.abs(f.b.x * h.x + f.b.y * h.y + f.b.z * h.z);
    const base = acc.pos.length / 3;
    for (const [sa, sb] of CORNERS) {
      pushVertex(
        acc,
        m.x + f.n.x * hn + f.a.x * ha * sa + f.b.x * hb * sb,
        m.y + f.n.y * hn + f.a.y * ha * sa + f.b.y * hb * sb,
        m.z + f.n.z * hn + f.a.z * ha * sa + f.b.z * hb * sb,
        f.n.x,
        f.n.y,
        f.n.z,
        c,
      );
    }
    acc.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

const CYL_SEGMENTS = 12;

/** A 12-sided prism along `part.axis` filling the part's bounding box (the radii are the box's half sizes across the axis). */
function addCyl(acc: Accumulator, part: PropPart, c: THREE.Color): void {
  const { center: m, half: h, axis } = part;
  // Axis frame: t along the axis, p and q across it (p x q = t).
  const t: Vec = axis === 'x' ? { x: 1, y: 0, z: 0 } : axis === 'y' ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 };
  const p: Vec = axis === 'x' ? { x: 0, y: 1, z: 0 } : axis === 'y' ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  const q: Vec = axis === 'x' ? { x: 0, y: 0, z: 1 } : axis === 'y' ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const ht = axis === 'x' ? h.x : axis === 'y' ? h.y : h.z;
  const hp = axis === 'x' ? h.y : axis === 'y' ? h.z : h.x;
  const hq = axis === 'x' ? h.z : axis === 'y' ? h.x : h.y;
  const at = (s: number, ang: number): Vec => ({
    x: m.x + t.x * ht * s + p.x * Math.cos(ang) * hp + q.x * Math.sin(ang) * hq,
    y: m.y + t.y * ht * s + p.y * Math.cos(ang) * hp + q.y * Math.sin(ang) * hq,
    z: m.z + t.z * ht * s + p.z * Math.cos(ang) * hp + q.z * Math.sin(ang) * hq,
  });
  // Sides: smooth radial normals.
  const side = acc.pos.length / 3;
  for (let i = 0; i <= CYL_SEGMENTS; i++) {
    const ang = (i / CYL_SEGMENTS) * Math.PI * 2;
    const nx = p.x * Math.cos(ang) + q.x * Math.sin(ang);
    const ny = p.y * Math.cos(ang) + q.y * Math.sin(ang);
    const nz = p.z * Math.cos(ang) + q.z * Math.sin(ang);
    for (const s of [-1, 1]) {
      const v = at(s, ang);
      pushVertex(acc, v.x, v.y, v.z, nx, ny, nz, c);
    }
  }
  for (let i = 0; i < CYL_SEGMENTS; i++) {
    const a = side + i * 2; // (angle i, -t), (angle i, +t), (angle i + 1, -t), (angle i + 1, +t)
    acc.idx.push(a, a + 3, a + 1, a, a + 2, a + 3);
  }
  // Caps.
  for (const s of [-1, 1]) {
    const centre = pushVertex(acc, m.x + t.x * ht * s, m.y + t.y * ht * s, m.z + t.z * ht * s, t.x * s, t.y * s, t.z * s, c);
    const ring = acc.pos.length / 3;
    for (let i = 0; i < CYL_SEGMENTS; i++) {
      const v = at(s, (i / CYL_SEGMENTS) * Math.PI * 2);
      pushVertex(acc, v.x, v.y, v.z, t.x * s, t.y * s, t.z * s, c);
    }
    for (let i = 0; i < CYL_SEGMENTS; i++) {
      const a = ring + i;
      const b = ring + ((i + 1) % CYL_SEGMENTS);
      if (s > 0) acc.idx.push(centre, a, b);
      else acc.idx.push(centre, b, a);
    }
  }
}

/** The vertex colour of a part: its colour relative to the class tint (tinted classes) or absolute, times the instance shade. */
function toneOf(theme: ThemeId, part: PropPart, shade: number): THREE.Color {
  const c = new THREE.Color(part.color);
  const tint = classTint(theme, part.cls);
  if (tint) {
    c.r /= Math.max(tint.r, 1e-4);
    c.g /= Math.max(tint.g, 1e-4);
    c.b /= Math.max(tint.b, 1e-4);
  }
  return part.cls === 'glass' ? c : c.multiplyScalar(shade);
}

interface Baked {
  geometry: THREE.BufferGeometry;
  /** Collider boxes this geometry holds. */
  boxes: number[];
}

const bakedCache = new Map<string, Map<MeshKey, Baked>>();

function bake(kind: PropKind, theme: ThemeId, shadeIndex: number): Map<MeshKey, Baked> {
  const key = `${kind}|${theme}|${shadeIndex}`;
  let baked = bakedCache.get(key);
  if (!baked) {
    const accs = new Map<MeshKey, Accumulator>();
    const boxes = new Map<MeshKey, number[]>();
    for (const part of propParts(kind, theme)) {
      const k: MeshKey = part.engine ? 'engine' : part.cls;
      let acc = accs.get(k);
      if (!acc) {
        acc = newAcc();
        accs.set(k, acc);
        boxes.set(k, []);
      }
      const c = toneOf(theme, part, SHADES[shadeIndex]);
      if (part.shape === 'box') addBox(acc, part, c);
      else addCyl(acc, part, c);
      if (part.box !== undefined) boxes.get(k)?.push(part.box);
    }
    baked = new Map();
    for (const [k, acc] of accs) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(acc.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(acc.nor, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(acc.uv, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(acc.col, 3));
      g.setIndex(acc.idx);
      g.computeBoundingSphere();
      g.computeBoundingBox();
      baked.set(k, { geometry: g, boxes: boxes.get(k) ?? [] });
    }
    bakedCache.set(key, baked);
  }
  return baked;
}

/** Meshes that cast sun shadows: the bodies (not the thin decorations, the glass or the tyres). */
const CASTS: ReadonlySet<MeshKey> = new Set<MeshKey>(['wall', 'roof', 'paint', 'engine']);

/**
 * The mesh of a prop: a group at the footprint centre (ground height `groundY`) turned by the placement yaw,
 * holding one mesh per material class that has parts (houses and sheds: wall, roof, trim, plain, glass;
 * vehicles: paint, trim (tarp), plain, glass), plus the vehicles' engine block as a mesh of its own
 * (`userData.part === 'engine'`, `userData.boxIndex`). Each mesh names its class in `userData.part` and the
 * collider boxes it holds in `userData.boxes`. The wall, roof, paint and engine meshes cast and receive sun
 * shadows; trim, plain parts (tyres, lamps) and glass only receive.
 */
export function createPropMesh(p: PropPlacement, groundY: number, theme: ThemeId): THREE.Group {
  const group = new THREE.Group();
  group.name = `prop:${p.id}`;
  group.userData.kind = p.kind;
  group.position.set(p.x, groundY, p.z);
  group.rotation.y = p.yaw;

  const baked = bake(p.kind, theme, hashId(p.id) % SHADES.length);
  const order: MeshKey[] = [...PART_CLASSES, 'engine'];
  for (const key of order) {
    const b = baked.get(key);
    if (!b) continue;
    const mesh = new THREE.Mesh(b.geometry, propMaterial(theme, key === 'engine' ? 'paint' : key));
    mesh.name = `${p.kind} ${key}`;
    mesh.castShadow = CASTS.has(key);
    mesh.receiveShadow = true;
    mesh.userData.part = key;
    mesh.userData.boxes = b.boxes;
    if (key === 'engine') mesh.userData.boxIndex = b.boxes[0];
    mesh.matrixAutoUpdate = false; // static scenery
    mesh.updateMatrix();
    group.add(mesh);
  }
  return group;
}
