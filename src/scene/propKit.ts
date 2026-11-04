import type { BoxLook, LocalBox } from '../mission/props';
import type { PartClass } from './materials';

// The kit the prop meshes are described with (scene/props.ts for the village props, scene/baseProps.ts for the
// military hardware): `Parts` lists the boxes and prisms of a prop in its local frame, collider boxes first-class
// (each drawn in its `look`, see props.ts `BoxLook`) and decorations lying on them.

/** How far a decoration stands proud of the face it lies on, m (< 3 cm: visible geometry bullets would pass through). */
export const DECOR_PROUD = 0.028;

/** Trim of the buildings: frames, sills, doors, shutters, corner quoins, roof edges. */
export interface Style {
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

export const DARK = 0x1b1c1d;
export const RUBBER = 0x1c1c1c;
export const CHROME = 0x7d8084;
export const LAMP = 0xe8e2c4;
export const TAIL = 0x9b1c16;
export const INTERIOR = 0x24231d;
export const FLAP = 0x3a3326;
export const GLASS_COLOUR = 0x3a4d5c;

/** A hex colour scaled in lightness (sRGB channels, clamped). */
export function scaled(hex: number, k: number): number {
  const r = Math.min(255, Math.round(((hex >> 16) & 255) * k));
  const g = Math.min(255, Math.round(((hex >> 8) & 255) * k));
  const b = Math.min(255, Math.round((hex & 255) * k));
  return (r << 16) | (g << 8) | b;
}

export type Face = '+x' | '-x' | '+z' | '-z' | '+y';

export interface Vec {
  x: number;
  y: number;
  z: number;
}

/**
 * How a part is drawn: `box`; `cyl`, a prism along `axis` inscribed in the bounding box (its radii are the box's
 * half sizes across the axis); `tube`, a prism between `tube.from` and `tube.to`; `bags`, `arch`, `ladder`: the
 * collider looks of props.ts `BoxLook`.
 */
export type PartShape = 'box' | 'cyl' | 'tube' | 'bags' | 'arch' | 'ladder';

/** One box (or another shape inside the same bounding box) of a prop. */
export interface PropPart {
  name: string;
  cls: PartClass;
  shape: PartShape;
  axis: 'x' | 'y' | 'z';
  /** Bounding box, local frame (before `yaw`). */
  center: Vec;
  half: Vec;
  /** Rotation about +Y around `center`, rad (collider boxes that are turned in the prop frame). */
  yaw?: number;
  /** The `tube` shape's axis end points and radius. */
  tube?: { from: Vec; to: Vec; radius: number };
  /** Sides of a round shape (default: the baker's choice by name). */
  sides?: number;
  /** The colour this part has on average (sRGB hex). */
  color: number;
  /** Index into `propBoxes(kind)` when the part IS a collider box; decorations have none. */
  box?: number;
  /** The vehicle's engine block (a mesh of its own). */
  engine?: boolean;
}

/** The part shape and prism axis of a collider box's look. */
function shapeOfLook(look: BoxLook): { shape: PartShape; axis: 'x' | 'y' | 'z' } {
  switch (look) {
    case 'roundX':
      return { shape: 'cyl', axis: 'x' };
    case 'roundY':
      return { shape: 'cyl', axis: 'y' };
    case 'roundZ':
      return { shape: 'cyl', axis: 'z' };
    default:
      return { shape: look, axis: 'y' };
  }
}

export class Parts {
  readonly list: PropPart[] = [];

  constructor(private readonly boxes: readonly LocalBox[]) {}

  /**
   * Collider box `i` itself, drawn in its look (a wheel's box defaults to the round tyre inside it, an axle along x);
   * the bullets still meet the box. `engine`: a vehicle target's engine block (a mesh of its own); only the village
   * vehicles set it.
   */
  collider(i: number, cls: PartClass, color: number, engine = this.boxes[i].part === 'engine'): void {
    const b = this.boxes[i];
    const look: BoxLook = b.look ?? (b.part === 'wheel' ? 'roundX' : 'box');
    const { shape, axis } = shapeOfLook(look);
    this.list.push({
      name: b.part,
      cls,
      shape,
      axis,
      center: { ...b.center },
      half: { ...b.halfSize },
      ...(b.yaw ? { yaw: b.yaw } : {}),
      ...(b.tube ? { tube: { from: { ...b.tube.from }, to: { ...b.tube.to }, radius: b.tube.radius } } : {}),
      ...(b.sides ? { sides: b.sides } : {}),
      color,
      box: i,
      engine,
    });
  }

  /** A decoration tube from `a` to `b`, radius `r` (it must lie inside one collider box: keep it short). */
  tube(name: string, cls: PartClass, color: number, a: Vec, b: Vec, r: number, sides?: number): void {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz);
    const half = (d: number): number => Math.abs(d) / 2 + r * Math.sqrt(Math.max(0, 1 - (d / len) ** 2));
    this.list.push({
      name,
      cls,
      shape: 'tube',
      axis: 'y',
      center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 },
      half: { x: half(dx), y: half(dy), z: half(dz) },
      tube: { from: { ...a }, to: { ...b }, radius: r },
      ...(sides ? { sides } : {}),
      color,
    });
  }

  /** A round prism along `axis` (a decoration: a drum hoop, a pipe, a lamp lens). */
  cyl(name: string, cls: PartClass, color: number, axis: 'x' | 'y' | 'z', cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, sides?: number): void {
    this.list.push({ name, cls, shape: 'cyl', axis, center: { x: cx, y: cy, z: cz }, half: { x: hx, y: hy, z: hz }, color, ...(sides ? { sides } : {}) });
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
  disc(name: string, cls: PartClass, color: number, on: LocalBox, face: Face, a: number, b: number, r: number, proud = DECOR_PROUD, sides?: number): void {
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
    this.list.push({ name, cls, shape: 'cyl', axis, center, half, color, ...(sides ? { sides } : {}) });
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
