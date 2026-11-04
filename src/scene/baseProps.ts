import { BASE_BOXES } from '../mission/baseProps';
import type { BaseKind } from '../mission/baseProps';
import type { LocalBox } from '../mission/props';
import type { ThemeId } from '../mission/themes';
import type { PartClass } from './materials';
import { CHROME, DARK, DECOR_PROUD, GLASS_COLOUR, LAMP, Parts, RUBBER, TAIL, scaled } from './propKit';
import type { Face, PropPart } from './propKit';

// Meshes of the military-base hardware (dimensions: src/mission/baseProps.ts). Same rules as the village props
// (scene/props.ts): every collider box is drawn, in its look (round wheels and drums, tilted barrel segments,
// sandbags, a vault, a ladder), and everything else is a decoration lying on one collider box, at most
// DECOR_PROUD (2.8 cm) proud of it, or under the ground (skirts that keep barriers and towers from floating on a
// slope). The parts are baked per material class like any prop; a whole base is merged into one mesh per class
// by scene/baseMesh.ts.
//
// Colours are absolute sRGB per theme (vertex colours: a tinted class is divided by its tint, so `paint` parts
// still get the metal texture's scratches, `trim` the plank grain for timber and canvas).

interface MilPalette {
  /** Vehicle and gun paint, and the two camouflage colours over it. */
  paint: number;
  camo: number;
  camo2: number;
  canvas: number;
  bag: number;
  hesco: number;
  wood: number;
  crate: number;
  concrete: number;
  net: number;
  netCamo: number;
  pad: number;
  mark: number;
  /** Corrugated sheet on the tower roofs. */
  sheet: number;
}

const PALETTES: Record<ThemeId, MilPalette> = {
  // Desert: tan and sand with brown disruptive patches.
  desert: {
    paint: 0xb49c6c,
    camo: 0x8a7048,
    camo2: 0xcdb88a,
    canvas: 0xa89470,
    bag: 0xbfa77a,
    hesco: 0xb8a47c,
    wood: 0x8a7350,
    crate: 0x6e6a44,
    concrete: 0xb3a68c,
    net: 0xa08a5c,
    netCamo: 0x7d6a45,
    pad: 0x9c9384,
    mark: 0xe8e2d0,
    sheet: 0x8f8a7c,
  },
  // Arctic: white with grey camouflage, grey-white kit.
  arctic: {
    paint: 0xd8dcdd,
    camo: 0x8e9599,
    camo2: 0x5f666b,
    canvas: 0xc9ccc4,
    bag: 0xc7c9c2,
    hesco: 0xb7b9b0,
    wood: 0x5a4a3a,
    crate: 0x56604a,
    concrete: 0xa6a9a8,
    net: 0xd5d9d8,
    netCamo: 0x9aa1a3,
    pad: 0x8f9294,
    mark: 0xf0f2f2,
    sheet: 0xe2e6ea,
  },
  // Valley: olive drab with dark green and brown.
  valley: {
    paint: 0x56603a,
    camo: 0x3a4228,
    camo2: 0x6b5a3c,
    canvas: 0x5b6040,
    bag: 0x8c7d5c,
    hesco: 0x8a7f62,
    wood: 0x6a5638,
    crate: 0x4c5330,
    concrete: 0x9a978d,
    net: 0x4e5a32,
    netCamo: 0x6b5d3c,
    pad: 0x7f7d76,
    mark: 0xe6e4dc,
    sheet: 0x6a6d68,
  },
};

const GUNMETAL = 0x2c2e2d;
const STEEL = 0x6d7072;
const HAZARD = 0xc9a227;
const RED = 0xa8261e;
const WHITE = 0xe8e8e2;
/** Skirts under barriers, towers and tents: they reach this far below the ground (m), so a slope shows no gap. */
const SKIRT = 0.6;

/** A small deterministic generator for decoration jitter (camouflage patches): the same kind always looks the same. */
function lcg(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** The face rectangle of box `b` as `plate` takes it: [a0, a1, b0, b1] (see Parts.plate). */
function faceRange(b: LocalBox, face: Face): [number, number, number, number] {
  const c = b.center;
  const h = b.halfSize;
  switch (face) {
    case '+z':
    case '-z':
      return [c.x - h.x, c.x + h.x, c.y - h.y, c.y + h.y];
    case '+x':
    case '-x':
      return [c.z - h.z, c.z + h.z, c.y - h.y, c.y + h.y];
    case '+y':
      return [c.x - h.x, c.x + h.x, c.z - h.z, c.z + h.z];
  }
}

/** Disruptive camouflage: `n` patches per face in the given colours, sized 20-45 % of the face, clipped to it. */
function camo(P: Parts, b: LocalBox, faces: readonly Face[], colours: readonly number[], n: number, seed: number, proud = 0.014): void {
  const rnd = lcg(seed);
  for (const face of faces) {
    const [a0, a1, b0, b1] = faceRange(b, face);
    for (let i = 0; i < n; i++) {
      const wa = (a1 - a0) * (0.2 + 0.25 * rnd());
      const wb = (b1 - b0) * (0.25 + 0.3 * rnd());
      const ca = a0 + (a1 - a0) * rnd();
      const cb = b0 + (b1 - b0) * rnd();
      const pa0 = Math.max(a0, ca - wa / 2);
      const pa1 = Math.min(a1, ca + wa / 2);
      const pb0 = Math.max(b0, cb - wb / 2);
      const pb1 = Math.min(b1, cb + wb / 2);
      if (pa1 - pa0 < 0.05 || pb1 - pb0 < 0.05) continue;
      P.plate('camouflage', 'paint', colours[i % colours.length], b, face, pa0, pa1, pb0, pb1, Math.min(DECOR_PROUD, proud + (i % 2) * 0.004));
    }
  }
}

/** A wheel's hub: a dark ring, the hub disc and a cap on its outer face. */
function hub(P: Parts, wheel: LocalBox, paint: number, ringK = 0.72, hubK = 0.45): void {
  const outer: Face = wheel.center.x > 0 ? '+x' : '-x';
  const r = wheel.halfSize.y;
  P.disc('wheel ring', 'plain', 0x111111, wheel, outer, wheel.center.z, wheel.center.y, r * ringK, 0.008);
  P.disc('wheel hub', 'paint', scaled(paint, 0.8), wheel, outer, wheel.center.z, wheel.center.y, r * hubK, 0.018);
  P.disc('wheel cap', 'plain', GUNMETAL, wheel, outer, wheel.center.z, wheel.center.y, r * 0.16, DECOR_PROUD);
}

/** A glazed window with a dark frame. */
function glazed(P: Parts, on: LocalBox, face: Face, a0: number, a1: number, b0: number, b1: number, bar = 0.05): void {
  P.plate('glass', 'glass', GLASS_COLOUR, on, face, a0, a1, b0, b1, 0.012);
  P.plate('window frame', 'plain', DARK, on, face, a0 - bar, a0, b0 - bar, b1 + bar);
  P.plate('window frame', 'plain', DARK, on, face, a1, a1 + bar, b0 - bar, b1 + bar);
  P.plate('window frame', 'plain', DARK, on, face, a0, a1, b1, b1 + bar);
  P.plate('window frame', 'plain', DARK, on, face, a0, a1, b0 - bar, b0);
}

/** Foundation under a box, entirely below the ground (no collider: it only shows where the ground falls away). */
function skirt(P: Parts, b: LocalBox, cls: PartClass, colour: number): void {
  const c = b.center;
  const h = b.halfSize;
  P.box('skirt', cls, colour, c.x - h.x, c.x + h.x, -SKIRT, 0, c.z - h.z, c.z + h.z);
}

/** Register every collider box of the kind, in order, with the class and colour `paint(box, index)` gives it. */
function colliders(P: Parts, boxes: readonly LocalBox[], paint: (b: LocalBox, i: number) => [PartClass, number]): void {
  boxes.forEach((b, i) => {
    const [cls, colour] = paint(b, i);
    P.collider(i, cls, colour, false);
  });
}

// ---------------------------------------------------------------------------------------------
// Armour and guns

function tank(theme: ThemeId): Parts {
  const boxes = BASE_BOXES.tank;
  const P = new Parts(boxes);
  const pal = PALETTES[theme];
  const [hull, trackL, trackR, turret, bustle, mantlet, barrel] = boxes;
  const cupola = boxes[8];
  colliders(P, boxes, (b) => {
    if (b.part === 'track') return ['plain', 0x2b2a27];
    if (b.part === 'antenna') return ['plain', DARK];
    if (b.part === 'gun' && b !== mantlet) return ['paint', scaled(pal.paint, 0.92)];
    return ['paint', pal.paint];
  });
  const camoCols = [pal.camo, pal.camo2];

  // Running gear on each track's outer face: six road wheels, a drive sprocket at the rear, an idler at the front,
  // return rollers, and a side skirt over the wheel tops.
  for (const tr of [trackL, trackR]) {
    const face: Face = tr.center.x > 0 ? '+x' : '-x';
    for (let i = 0; i < 6; i++) {
      const z = -2.65 + i * 1.05;
      P.disc('road wheel', 'paint', scaled(pal.paint, 0.78), tr, face, z, 0.38, 0.33, 0.016, 24);
      P.disc('road wheel hub', 'plain', GUNMETAL, tr, face, z, 0.38, 0.12, 0.022, 12);
    }
    P.disc('drive sprocket', 'plain', GUNMETAL, tr, face, -3.2, 0.62, 0.3, 0.016, 16);
    P.disc('idler', 'paint', scaled(pal.paint, 0.7), tr, face, 3.12, 0.6, 0.27, 0.016, 20);
    P.plate('side skirt', 'paint', pal.paint, tr, face, -3.6, 3.5, 0.66, 1.05, 0.024);
    P.plate('skirt edge', 'plain', DARK, tr, face, -3.6, 3.5, 0.62, 0.66, 0.024);
    for (let z = -3.0; z < 3.4; z += 1.2) P.plate('skirt panel seam', 'plain', scaled(pal.paint, 0.6), tr, face, z, z + 0.03, 0.66, 1.05, DECOR_PROUD);
    camo(P, tr, [face], camoCols, 3, tr.center.x > 0 ? 11 : 12, DECOR_PROUD);
    P.plate('fender', 'paint', scaled(pal.paint, 0.9), tr, '+y', tr.center.x - 0.27, tr.center.x + 0.27, -3.6, 3.5, 0.02);
    for (let i = 0; i < 3; i++) {
      const z = -2.6 + i * 1.9;
      P.plate('stowage bin', 'paint', scaled(pal.paint, 0.82), tr, '+y', tr.center.x - 0.22, tr.center.x + 0.22, z, z + 0.9, DECOR_PROUD);
    }
    P.plate('track front', 'plain', 0x1d1c1a, tr, '+z', tr.center.x - 0.27, tr.center.x + 0.27, 0.1, 0.9, 0.02);
    P.plate('track rear', 'plain', 0x1d1c1a, tr, '-z', tr.center.x - 0.27, tr.center.x + 0.27, 0.1, 0.9, 0.02);
  }

  // Hull: glacis band, headlights, tow hooks, driver's hatch and vision blocks, engine deck louvres, rear grille.
  P.plate('glacis', 'paint', scaled(pal.paint, 1.06), hull, '+z', -1.25, 1.25, 1.05, 1.6, 0.012);
  for (const s of [-1, 1]) {
    P.disc('headlight guard', 'plain', DARK, hull, '+z', s * 0.95, 1.38, 0.1, 0.018);
    P.disc('headlight', 'plain', LAMP, hull, '+z', s * 0.95, 1.38, 0.065, DECOR_PROUD);
    P.plate('tow hook', 'plain', GUNMETAL, hull, '+z', s * 0.6 - 0.08, s * 0.6 + 0.08, 0.62, 0.82, DECOR_PROUD);
  }
  P.disc('driver hatch', 'paint', scaled(pal.paint, 0.85), hull, '+y', 0, 2.75, 0.3, 0.02, 16);
  P.plate('vision blocks', 'plain', 0x1a2228, hull, '+y', -0.3, 0.3, 3.1, 3.2, DECOR_PROUD);
  for (let z = -3.35; z < -1.9; z += 0.16) P.plate('engine louvre', 'plain', 0x24231f, hull, '+y', -0.95, 0.95, z, z + 0.08, 0.016);
  P.plate('engine deck', 'paint', scaled(pal.paint, 0.9), hull, '+y', -1.15, 1.15, -3.45, -1.85, 0.01);
  P.plate('rear grille', 'plain', 0x1f1e1b, hull, '-z', -0.9, 0.9, 0.8, 1.45, 0.016);
  for (const s of [-1, 1]) P.plate('tail light', 'plain', TAIL, hull, '-z', s * 1.05 - 0.07, s * 1.05 + 0.07, 1.35, 1.48, DECOR_PROUD);
  camo(P, hull, ['+y', '+z'], camoCols, 3, 13);

  // Turret: smoke dischargers, stowage boxes, sight heads, loader's hatch, a basket on the bustle.
  for (const s of [-1, 1]) {
    for (let i = 0; i < 3; i++) P.disc('smoke discharger', 'plain', GUNMETAL, turret, '+z', s * (1.0 + i * 0.16), 2.12, 0.055, DECOR_PROUD, 10);
    const face: Face = s > 0 ? '+x' : '-x';
    P.plate('turret stowage', 'paint', scaled(pal.paint, 0.84), turret, face, -1.5, 0.4, 1.72, 2.12, 0.026);
    P.plate('stowage strap', 'plain', DARK, turret, face, -0.9, -0.85, 1.72, 2.12, DECOR_PROUD);
    P.plate('stowage strap', 'plain', DARK, turret, face, -0.1, -0.05, 1.72, 2.12, DECOR_PROUD);
  }
  P.plate('gunner sight', 'plain', GUNMETAL, turret, '+y', 0.65, 1.15, 0.75, 1.2, DECOR_PROUD);
  P.plate('sight glass', 'plain', 0x1a2a33, turret, '+z', 0.7, 1.1, 2.2, 2.33, DECOR_PROUD);
  P.disc('loader hatch', 'paint', scaled(pal.paint, 0.86), turret, '+y', 0.6, -0.7, 0.3, 0.02, 16);
  P.disc('hatch hinge', 'plain', DARK, turret, '+y', 0.6, -0.7, 0.08, DECOR_PROUD);
  P.plate('turret roof seam', 'plain', scaled(pal.paint, 0.65), turret, '+y', -1.55, 1.55, 0.35, 0.38, 0.012);
  camo(P, turret, ['+x', '-x', '+y', '+z'], camoCols, 3, 14);
  P.plate('bustle rack', 'plain', DARK, bustle, '-z', -1.25, 1.25, 1.95, 2.0, DECOR_PROUD);
  P.plate('bustle rack', 'plain', DARK, bustle, '-z', -1.25, 1.25, 2.2, 2.25, DECOR_PROUD);
  for (let x = -1.0; x <= 1.0; x += 0.5) P.plate('rack bar', 'plain', DARK, bustle, '-z', x - 0.02, x + 0.02, 1.7, 2.3, DECOR_PROUD);
  camo(P, bustle, ['+x', '-x', '+y'], camoCols, 2, 15);

  // Gun: mantlet bolts, a muzzle ring and the thermal sleeve bands.
  P.plate('mantlet edge', 'plain', scaled(pal.paint, 0.6), mantlet, '+z', -0.42, 0.42, 1.72, 1.77, DECOR_PROUD);
  P.plate('mantlet edge', 'plain', scaled(pal.paint, 0.6), mantlet, '+z', -0.42, 0.42, 2.17, 2.22, DECOR_PROUD);
  const bz = barrel.center.z + barrel.halfSize.z;
  P.cyl('muzzle', 'paint', scaled(pal.paint, 0.7), 'z', 0, barrel.center.y, bz - 0.12, 0.105, 0.105, 0.12, 16);
  for (const z of [2.6, 5.2]) P.cyl('sleeve band', 'plain', DARK, 'z', 0, barrel.center.y, z, 0.1, 0.1, 0.03, 16);
  // Commander's cupola: a hatch lid and vision blocks round it.
  const cTop = cupola.center.y + cupola.halfSize.y;
  P.cyl('cupola hatch', 'paint', scaled(pal.paint, 0.85), 'y', cupola.center.x, cTop + 0.012, cupola.center.z, 0.27, 0.012, 0.27, 16);
  for (const [dx, dz] of [
    [0, 1],
    [1, 0],
    [-1, 0],
    [0.7, 0.7],
    [-0.7, 0.7],
  ]) {
    P.box('vision block', 'plain', 0x1a2228, cupola.center.x + dx * 0.33 - 0.05, cupola.center.x + dx * 0.33 + 0.05, cupola.center.y + 0.02, cupola.center.y + 0.1, cupola.center.z + dz * 0.33 - 0.05, cupola.center.z + dz * 0.33 + 0.05);
  }
  return P;
}

function artillery(theme: ThemeId): Parts {
  const boxes = BASE_BOXES.artillery;
  const P = new Parts(boxes);
  const pal = PALETTES[theme];
  colliders(P, boxes, (b) => {
    if (b.part === 'wheel') return ['plain', RUBBER];
    if (b.part === 'gun') return ['paint', b.tube && b.tube.radius > 0.12 && b.tube.radius < 0.14 ? scaled(pal.paint, 0.55) : scaled(pal.paint, b.tube && b.tube.radius > 0.1 ? 0.85 : 0.95)];
    if (b.part === 'frame' && b.halfSize.y > 0.2 && b.halfSize.x > 0.25 && b.yaw) return ['plain', GUNMETAL]; // spades
    return ['paint', pal.paint];
  });
  for (const b of boxes) if (b.part === 'wheel') hub(P, b, pal.paint, 0.66, 0.42);
  const shield = boxes.find((b) => b.part === 'panel') as LocalBox;
  const carriage = boxes[3];
  const breech = boxes[5];
  // Gun shield: a lip along the top, a sight port, rivet rows, camouflage.
  P.plate('shield lip', 'paint', scaled(pal.paint, 0.8), shield, '+z', -1.15, 1.15, 1.79, 1.85, DECOR_PROUD);
  P.plate('sight port', 'plain', 0x15181a, shield, '+z', -0.75, -0.45, 1.45, 1.62, DECOR_PROUD);
  P.plate('shield seam', 'plain', scaled(pal.paint, 0.6), shield, '+z', -1.15, 1.15, 1.1, 1.13, 0.012);
  camo(P, shield, ['+z', '-z'], [pal.camo, pal.camo2], 3, 21);
  // Carriage and breech: a handwheel each side, the breech block, a panoramic sight.
  for (const s of [-1, 1]) P.disc('handwheel', 'plain', GUNMETAL, carriage, s > 0 ? '+x' : '-x', 0.2, 0.85, 0.14, DECOR_PROUD, 12);
  P.plate('breech block', 'plain', GUNMETAL, breech, '-z', -0.18, 0.18, 1.12, 1.48, DECOR_PROUD);
  P.plate('sight mount', 'plain', GUNMETAL, breech, '-x', -0.4, 0.0, 1.35, 1.52, DECOR_PROUD);
  P.plate('cradle top', 'paint', scaled(pal.paint, 0.8), breech, '+y', -0.15, 0.15, -0.6, 0.4, 0.016);
  camo(P, carriage, ['+x', '-x'], [pal.camo], 2, 22);
  return P;
}

function aaGun(theme: ThemeId): Parts {
  const boxes = BASE_BOXES.aaGun;
  const P = new Parts(boxes);
  const pal = PALETTES[theme];
  colliders(P, boxes, (b) => {
    if (b.part === 'wheel') return ['plain', RUBBER];
    if (b.part === 'bags') return ['plain', pal.bag];
    if (b.part === 'crate') return ['paint', scaled(pal.paint, 0.75)];
    if (b.tube) return ['plain', b.tube.radius > 0.045 ? 0x1d1e1d : 0x353836];
    if (b.look === 'roundY') return ['paint', scaled(pal.paint, 0.7)];
    return ['paint', pal.paint];
  });
  for (const b of boxes) if (b.part === 'wheel') hub(P, b, pal.paint, 0.6, 0.4);
  const platform = boxes[0];
  const mount = boxes[4];
  const housing = boxes[5];
  // Seats, handwheels and the sight on the mount; levelling jacks at the platform corners; magazine latches.
  for (const s of [-1, 1]) {
    P.plate('seat', 'plain', 0x2a2a26, mount, '+y', s * 0.42 - 0.15, s * 0.42 + 0.15, -0.55, -0.25, DECOR_PROUD);
    P.disc('elevation handwheel', 'plain', GUNMETAL, mount, s > 0 ? '+x' : '-x', -0.1, 1.05, 0.15, DECOR_PROUD, 12);
    for (const sz of [-1, 1]) P.disc('jack pad', 'plain', GUNMETAL, platform, '+y', s * 0.8, sz * 1.15, 0.1, DECOR_PROUD, 10);
  }
  P.plate('sight', 'plain', GUNMETAL, housing, '+y', -0.12, 0.12, 0.5, 0.75, DECOR_PROUD);
  P.plate('housing seam', 'plain', scaled(pal.paint, 0.6), housing, '+z', -0.4, 0.4, 1.2, 1.23, 0.012);
  for (const b of boxes) {
    if (b.part !== 'crate') continue;
    const face: Face = b.center.x > 0 ? '+x' : '-x';
    P.plate('magazine latch', 'plain', DARK, b, face, -0.2, 0.2, 1.05, 1.09, DECOR_PROUD);
  }
  camo(P, mount, ['+x', '-x', '+z'], [pal.camo, pal.camo2], 2, 31);
  for (const b of boxes) if (b.part === 'bags') skirt(P, b, 'plain', scaled(pal.bag, 0.7));
  return P;
}

// ---------------------------------------------------------------------------------------------
// Trucks

function truckChassis(P: Parts, boxes: readonly LocalBox[], pal: MilPalette): void {
  const engine = boxes[1];
  const cab = boxes[2];
  // Bonnet: grille with slats, headlights in guards, bumper, fender steps, a louvred top.
  P.plate('grille', 'plain', 0x151617, engine, '+z', -0.6, 0.6, 1.15, 1.9, 0.012);
  for (let x = -0.54; x <= 0.55; x += 0.12) P.plate('grille slat', 'paint', scaled(pal.paint, 0.75), engine, '+z', x - 0.025, x + 0.025, 1.15, 1.9, 0.022);
  for (const s of [-1, 1]) {
    P.disc('headlight guard', 'plain', DARK, engine, '+z', s * 0.72, 1.75, 0.12, 0.018);
    P.disc('headlight', 'plain', LAMP, engine, '+z', s * 0.72, 1.75, 0.08, DECOR_PROUD);
    const face: Face = s > 0 ? '+x' : '-x';
    for (let y = 1.55; y < 1.95; y += 0.1) P.plate('louvre', 'plain', DARK, engine, face, 3.6, 4.3, y, y + 0.04, 0.02);
    P.plate('fender', 'paint', scaled(pal.paint, 0.8), engine, face, 3.2, 4.6, 1.0, 1.14, DECOR_PROUD);
  }
  P.plate('bumper', 'plain', GUNMETAL, engine, '+z', -0.85, 0.85, 1.0, 1.14, DECOR_PROUD);
  P.plate('hood seam', 'plain', scaled(pal.paint, 0.6), engine, '+y', -0.03, 0.03, 3.3, 4.5, 0.016);
  camo(P, engine, ['+y', '+x', '-x'], [pal.camo, pal.camo2], 2, 41);
  // Cab: split windscreen above the bonnet, side windows, doors, mirrors, a roof hatch.
  glazed(P, cab, '+z', -1.05, -0.06, 2.15, 2.68);
  glazed(P, cab, '+z', 0.06, 1.05, 2.15, 2.68);
  for (const face of ['+x', '-x'] as const) {
    glazed(P, cab, face, 2.25, 3.05, 1.95, 2.6, 0.04);
    P.plate('door seam', 'plain', DARK, cab, face, 2.1, 2.13, 1.05, 2.75, 0.016);
    P.plate('door seam', 'plain', DARK, cab, face, 3.12, 3.15, 1.05, 2.75, 0.016);
    P.plate('door handle', 'plain', CHROME, cab, face, 2.25, 2.45, 1.75, 1.8, DECOR_PROUD);
    P.plate('mirror', 'plain', DARK, cab, face, 3.0, 3.18, 2.2, 2.65, DECOR_PROUD);
    P.plate('step', 'plain', DARK, cab, face, 2.2, 3.0, 1.0, 1.08, 0.02);
  }
  P.disc('roof hatch', 'paint', scaled(pal.paint, 0.85), cab, '+y', 0.4, 2.4, 0.32, 0.018, 16);
  P.disc('hatch ring', 'plain', DARK, cab, '+y', 0.4, 2.4, 0.36, 0.01, 16);
  camo(P, cab, ['+x', '-x', '+y'], [pal.camo, pal.camo2], 2, 42);
  for (const b of boxes) if (b.part === 'wheel') hub(P, b, pal.paint);
}

function cargoTruck(theme: ThemeId): Parts {
  const boxes = BASE_BOXES.cargoTruck;
  const P = new Parts(boxes);
  const pal = PALETTES[theme];
  colliders(P, boxes, (b) => {
    if (b.part === 'wheel') return ['plain', RUBBER];
    if (b.part === 'frame') return ['plain', 0x262624];
    if (b.part === 'fabric') return ['trim', pal.canvas];
    return ['paint', pal.paint];
  });
  truckChassis(P, boxes, pal);
  const bed = boxes[9];
  const tilt = boxes[10];
  // Bed: drop-side boards, stakes, mudguards over the rear wheels, tailgate with lamps.
  for (const face of ['+x', '-x'] as const) {
    P.plate('board line', 'plain', scaled(pal.paint, 0.6), bed, face, -4.0, 1.5, 1.42, 1.45, 0.012);
    for (let z = -3.7; z < 1.4; z += 1.0) P.plate('stake', 'paint', scaled(pal.paint, 0.8), bed, face, z - 0.04, z + 0.04, 1.1, 1.75, 0.022);
    P.plate('mudguard', 'plain', 0x1c1c1a, bed, face, -3.45, -0.8, 1.1, 1.2, DECOR_PROUD);
    // Canvas: tie-down rope along the bottom, the bows showing through, a side window flap.
    P.plate('tie-down rope', 'plain', 0x2b2820, tilt, face, -4.0, 1.5, 1.79, 1.83, 0.016);
    for (let z = -3.4; z < 1.4; z += 1.2) P.plate('bow', 'trim', scaled(pal.canvas, 0.82), tilt, face, z - 0.05, z + 0.05, 1.75, 2.75, 0.014);
    for (let z = -3.6; z < 1.3; z += 0.45) P.plate('rope loop', 'plain', 0x2b2820, tilt, face, z - 0.015, z + 0.015, 1.75, 1.95, 0.02);
  }
  P.plate('tailgate', 'paint', scaled(pal.paint, 0.9), bed, '-z', -1.28, 1.28, 1.1, 1.75, 0.012);
  for (const s of [-1, 1]) P.plate('tail lamp', 'plain', TAIL, bed, '-z', s * 1.0 - 0.1, s * 1.0 + 0.1, 1.2, 1.32, DECOR_PROUD);
  P.plate('rear flap', 'trim', scaled(pal.canvas, 0.85), tilt, '-z', -1.2, 1.2, 1.9, 2.75, 0.014);
  P.plate('rolled flap', 'trim', scaled(pal.canvas, 0.7), tilt, '-z', -1.2, 1.2, 2.55, 2.72, DECOR_PROUD);
  P.plate('front panel', 'trim', scaled(pal.canvas, 0.9), tilt, '+z', -1.28, 1.28, 1.75, 2.75, 0.012);
  return P;
}

function fuelTruck(theme: ThemeId): Parts {
  const boxes = BASE_BOXES.fuelTruck;
  const P = new Parts(boxes);
  const pal = PALETTES[theme];
  colliders(P, boxes, (b) => {
    if (b.part === 'wheel') return ['plain', RUBBER];
    if (b.part === 'frame') return ['plain', 0x262624];
    if (b.part === 'tank') return ['paint', scaled(pal.paint, 1.04)];
    return ['paint', pal.paint];
  });
  truckChassis(P, boxes, pal);
  const tank = boxes[10];
  const locker = boxes[11];
  const r = tank.halfSize.y;
  // Tank: hoops, a walkway and manhole lids on top, a rear ladder and the hazard plate.
  for (const z of [-3.2, -1.25, 0.7]) P.cyl('tank hoop', 'paint', scaled(pal.paint, 0.8), 'z', 0, tank.center.y, z, r + 0.02, r + 0.02, 0.05, 24);
  const top = tank.center.y + r;
  P.box('walkway', 'plain', 0x3a3a36, -0.12, 0.12, top, top + 0.02, -3.6, 1.1);
  for (const z of [-2.3, -0.2]) P.cyl('manhole', 'plain', GUNMETAL, 'y', 0, top + 0.012, z, 0.22, 0.012, 0.22, 16);
  const back = tank.center.z - tank.halfSize.z;
  for (const s of [-1, 1]) P.box('ladder rail', 'plain', DARK, s * 0.25 - 0.02, s * 0.25 + 0.02, 1.3, 2.6, back - 0.025, back);
  for (let y = 1.4; y < 2.6; y += 0.25) P.box('ladder rung', 'plain', DARK, -0.25, 0.25, y, y + 0.03, back - 0.02, back);
  P.box('hazard plate', 'plain', RED, 0.35, 0.65, 1.75, 2.05, back - 0.02, back);
  P.box('hazard plate', 'plain', WHITE, 0.4, 0.6, 1.8, 2.0, back - 0.026, back - 0.02);
  P.plate('locker door', 'paint', scaled(pal.paint, 0.85), locker, '+x', -3.3, -2.1, 1.05, 1.55, 0.012);
  P.plate('locker handle', 'plain', CHROME, locker, '+x', -2.3, -2.2, 1.3, 1.35, DECOR_PROUD);
  return P;
}

// ---------------------------------------------------------------------------------------------
// Helicopter and pad

function helicopter(theme: ThemeId): Parts {
  const boxes = BASE_BOXES.helicopter;
  const P = new Parts(boxes);
  const pal = PALETTES[theme];
  const heliPaint = theme === 'arctic' ? 0xc9ced0 : scaled(pal.paint, 0.92);
  colliders(P, boxes, (b) => {
    if (b.part === 'glass') return ['glass', GLASS_COLOUR];
    if (b.part === 'blade') return ['plain', 0x2b2d2e];
    if (b.part === 'frame') return ['plain', b.look === 'roundZ' && b.halfSize.x > 0.1 ? scaled(pal.paint, 0.55) : 0x2a2b2a];
    return ['paint', heliPaint];
  });
  const [cabin, nose, glass, cowling] = boxes;
  const boomA = boxes[10];
  const boomB = boxes[11];
  const fin = boxes[12];
  // Cabin: sliding door outline with two windows, a cockpit door and window, step plates, a rescue hoist mount.
  for (const face of ['+x', '-x'] as const) {
    P.plate('door seam', 'plain', DARK, cabin, face, -1.3, -1.27, 0.75, 2.4, 0.016);
    P.plate('door seam', 'plain', DARK, cabin, face, 0.6, 0.63, 0.75, 2.4, 0.016);
    P.plate('door seam', 'plain', DARK, cabin, face, -1.3, 0.63, 2.37, 2.4, 0.016);
    P.plate('door rail', 'plain', GUNMETAL, cabin, face, -1.75, 0.65, 2.42, 2.47, DECOR_PROUD);
    glazed(P, cabin, face, -1.1, -0.45, 1.75, 2.2, 0.04);
    glazed(P, cabin, face, -0.25, 0.4, 1.75, 2.2, 0.04);
    glazed(P, cabin, face, 1.0, 1.95, 1.65, 2.3, 0.04);
    P.plate('step', 'plain', DARK, cabin, face, 0.8, 1.3, 0.7, 0.76, DECOR_PROUD);
    P.plate('chin window', 'glass', GLASS_COLOUR, nose, face, 2.6, 3.4, 1.05, 1.45, 0.012);
    P.plate('exhaust', 'plain', 0x1c1c1b, cowling, face, -1.4, -0.8, 2.75, 3.05, DECOR_PROUD);
    P.plate('cowling seam', 'plain', scaled(heliPaint, 0.65), cowling, face, -0.2, -0.17, 2.6, 3.25, 0.014);
  }
  P.disc('sensor turret', 'plain', 0x22262a, nose, '+z', 0, 1.1, 0.2, DECOR_PROUD, 16);
  P.plate('nose seam', 'plain', scaled(heliPaint, 0.65), nose, '+y', -0.9, 0.9, 3.0, 3.03, 0.014);
  // Cockpit glazing frame: a centre post, a bow and side posts.
  P.plate('canopy frame', 'plain', DARK, glass, '+z', -0.03, 0.03, 1.6, 2.45, 0.016);
  P.plate('canopy frame', 'plain', DARK, glass, '+z', -0.88, 0.88, 2.39, 2.45, 0.016);
  for (const face of ['+x', '-x'] as const) P.plate('canopy frame', 'plain', DARK, glass, face, 2.85, 2.9, 1.6, 2.45, 0.016);
  P.plate('canopy roof', 'paint', heliPaint, glass, '+y', -0.88, 0.88, 2.2, 2.75, 0.012);
  for (const s of [-1, 1]) P.disc('engine intake', 'plain', 0x151617, cowling, '+z', s * 0.4, 2.95, 0.2, DECOR_PROUD, 14);
  P.plate('cowling top', 'paint', scaled(heliPaint, 0.88), cowling, '+y', -0.5, 0.5, -1.4, 1.2, 0.014);
  // Tail: a stripe at the boom joint, a tail-rotor gearbox fairing, an anti-collision light.
  for (const face of ['+x', '-x'] as const) P.plate('boom band', 'plain', scaled(heliPaint, 0.6), boomB, face, -5.3, -5.1, 2.0, 2.6, 0.014);
  P.plate('fin cap', 'plain', DARK, fin, '+y', -0.1, 0.1, -9.8, -8.8, DECOR_PROUD);
  P.plate('beacon', 'plain', RED, fin, '+y', -0.06, 0.06, -9.2, -9.05, DECOR_PROUD);
  camo(P, cabin, ['+x', '-x', '+y'], [pal.camo, pal.camo2], 2, 51);
  camo(P, boomA, ['+x', '-x', '+y'], [pal.camo], 2, 52);
  camo(P, boomB, ['+x', '-x'], [pal.camo2], 1, 53);
  // Rotor blades: a light tip on each.
  for (const b of boxes) {
    if (b.part !== 'blade' || b.halfSize.y > 0.05) continue; // main rotor blades only
    const alongX = b.halfSize.x > b.halfSize.z;
    const tipX = b.center.x + Math.sign(b.center.x) * (b.halfSize.x - 0.3);
    const tipZ = b.center.z + Math.sign(b.center.z) * (b.halfSize.z - 0.3);
    if (alongX) P.plate('blade tip', 'plain', 0xb8b098, b, '+y', tipX - 0.3, tipX + 0.3, -0.28, 0.28, 0.012);
    else P.plate('blade tip', 'plain', 0xb8b098, b, '+y', -0.28, 0.28, tipZ - 0.3, tipZ + 0.3, 0.012);
  }
  return P;
}

function helipad(theme: ThemeId): Parts {
  const boxes = BASE_BOXES.helipad;
  const P = new Parts(boxes);
  const pal = PALETTES[theme];
  const pad = boxes[0];
  P.collider(0, 'plain', pal.pad, false);
  skirt(P, pad, 'plain', scaled(pal.pad, 0.8));
  // The circle (a ring: a marked disc with a pad-coloured disc over its middle), the H, corner marks and edge lights.
  P.disc('circle', 'plain', pal.mark, pad, '+y', 0, 0, 5.4, 0.008, 48);
  P.disc('circle inside', 'plain', pal.pad, pad, '+y', 0, 0, 5.0, 0.014, 48);
  P.plate('H left', 'plain', pal.mark, pad, '+y', -1.6, -1.05, -2.2, 2.2, 0.02);
  P.plate('H right', 'plain', pal.mark, pad, '+y', 1.05, 1.6, -2.2, 2.2, 0.02);
  P.plate('H bar', 'plain', pal.mark, pad, '+y', -1.05, 1.05, -0.28, 0.28, 0.02);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      P.plate('corner mark', 'plain', pal.mark, pad, '+y', sx > 0 ? 5.9 : -6.9, sx > 0 ? 6.9 : -5.9, sz * 6.65 - 0.15, sz * 6.65 + 0.15, 0.01);
      P.plate('corner mark', 'plain', pal.mark, pad, '+y', sx * 6.65 - 0.15, sx * 6.65 + 0.15, sz > 0 ? 5.9 : -6.9, sz > 0 ? 6.9 : -5.9, 0.01);
    }
  }
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    P.disc('edge light', 'plain', i % 2 ? 0x6fbf4a : 0xd7c34a, pad, '+y', 6.6 * Math.cos(a) * 0.98, 6.6 * Math.sin(a) * 0.98, 0.09, DECOR_PROUD, 10);
  }
  for (let x = -7; x <= 7.01; x += 3.5) P.plate('joint', 'plain', scaled(pal.pad, 0.85), pad, '+y', x - 0.02, x + 0.02, -7, 7, 0.004);
  return P;
}

// ---------------------------------------------------------------------------------------------
// Emplacements, barriers, camp

function ammoCrates(theme: ThemeId): Parts {
  const boxes = BASE_BOXES.ammoCrates;
  const P = new Parts(boxes);
  const pal = PALETTES[theme];
  colliders(P, boxes, (b, i) => {
    if (i < 2) return ['trim', pal.wood];
    if (b.material === 'metal') return ['paint', scaled(pal.crate, 0.95)];
    return ['trim', scaled(pal.crate, [1, 0.9, 1.08, 0.95, 1.04][i % 5])];
  });
  boxes.forEach((b, i) => {
    const h = b.halfSize;
    const c = b.center;
    const x0 = c.x - h.x;
    const x1 = c.x + h.x;
    const y0 = c.y - h.y;
    const y1 = c.y + h.y;
    const z0 = c.z - h.z;
    const z1 = c.z + h.z;
    if (i < 2) {
      // Pallet: dark gaps between the top boards, blocks showing on the sides.
      for (let x = x0 + 0.2; x < x1 - 0.1; x += 0.2) P.plate('pallet gap', 'plain', 0x2a241a, b, '+y', x - 0.015, x + 0.015, z0, z1, 0.004);
      for (const face of ['+z', '-z'] as const) P.plate('pallet gap', 'plain', 0x1d1912, b, face, x0 + 0.12, x1 - 0.12, y0 + 0.02, y1 - 0.05, 0.004);
      return;
    }
    if (b.material === 'metal') {
      P.plate('can lid', 'plain', scaled(pal.crate, 0.7), b, '+y', x0 + 0.02, x1 - 0.02, z0 + 0.02, z1 - 0.02, 0.012);
      P.plate('can handle', 'plain', DARK, b, '+y', c.x - 0.06, c.x + 0.06, c.z - 0.015, c.z + 0.015, DECOR_PROUD);
      return;
    }
    // Wooden crate: lid battens, end cleats, rope handles, a stencilled band.
    const dark = scaled(pal.crate, 0.62);
    P.plate('lid batten', 'trim', dark, b, '+y', x0, x1, z0, z0 + 0.05, 0.016);
    P.plate('lid batten', 'trim', dark, b, '+y', x0, x1, z1 - 0.05, z1, 0.016);
    for (const face of ['+x', '-x'] as const) {
      P.plate('cleat', 'trim', dark, b, face, z0, z1, y1 - 0.05, y1, 0.016);
      P.plate('cleat', 'trim', dark, b, face, z0, z1, y0, y0 + 0.05, 0.016);
      if (h.y > 0.12) P.plate('rope handle', 'plain', 0x2a2620, b, face, c.z - 0.08, c.z + 0.08, c.y - 0.02, c.y + 0.03, DECOR_PROUD);
    }
    for (const face of ['+z', '-z'] as const) {
      P.plate('edge', 'trim', dark, b, face, x0, x0 + 0.05, y0, y1, 0.016);
      P.plate('edge', 'trim', dark, b, face, x1 - 0.05, x1, y0, y1, 0.016);
    }
    if (h.x > 0.3 && h.y > 0.12) P.plate('stencil band', 'plain', HAZARD, b, '+z', c.x - h.x * 0.6, c.x + h.x * 0.6, c.y - 0.03, c.y + 0.02, 0.02);
  });
  return P;
}

function mgNest(theme: ThemeId): Parts {
  const boxes = BASE_BOXES.mgNest;
  const P = new Parts(boxes);
  const pal = PALETTES[theme];
  colliders(P, boxes, (b) => {
    if (b.part === 'bags') return ['plain', pal.bag];
    if (b.part === 'crate') return ['paint', scaled(pal.crate, 1.1)];
    return ['plain', GUNMETAL];
  });
  const receiver = boxes[5];
  const barrel = boxes[6];
  P.plate('feed cover', 'plain', 0x3a3c3a, receiver, '+y', -0.06, 0.06, 0.45, 0.75, DECOR_PROUD);
  P.plate('stock', 'plain', 0x24221e, receiver, '-z', -0.04, 0.04, 1.12, 1.27, DECOR_PROUD);
  P.plate('sight', 'plain', DARK, receiver, '+y', -0.015, 0.015, 0.75, 0.84, DECOR_PROUD);
  P.cyl('flash hider', 'plain', 0x1a1a1a, 'z', 0, barrel.center.y, barrel.center.z + barrel.halfSize.z - 0.06, 0.035, 0.035, 0.06, 10);
  P.cyl('barrel jacket', 'plain', 0x3a3c3a, 'z', 0, barrel.center.y, 1.05, 0.04, 0.04, 0.2, 10);
  for (const b of boxes) if (b.part === 'bags') skirt(P, b, 'plain', scaled(pal.bag, 0.7));
  return P;
}

function radar(theme: ThemeId): Parts {
  const boxes = BASE_BOXES.radar;
  const P = new Parts(boxes);
  const pal = PALETTES[theme];
  colliders(P, boxes, (b) => {
    if (b.part === 'wheel') return ['plain', RUBBER];
    if (b.part === 'post') return ['plain', b.look === 'roundY' ? STEEL : GUNMETAL];
    if (b.part === 'frame') return ['plain', GUNMETAL];
    return ['paint', b.part === 'panel' ? scaled(pal.paint, 1.05) : pal.paint];
  });
  for (const b of boxes) if (b.part === 'wheel') hub(P, b, pal.paint);
  const bed = boxes[0];
  const cabin = boxes[8];
  const panel = boxes[11];
  const iff = boxes[12];
  // The array face: a frame and a grid of radiating tiles; the back: stiffeners.
  const px0 = -1.9;
  const py0 = 4.9;
  P.plate('array frame', 'plain', GUNMETAL, panel, '+z', px0, -px0, py0, py0 + 0.08, 0.016);
  P.plate('array frame', 'plain', GUNMETAL, panel, '+z', px0, -px0, 6.22, 6.3, 0.016);
  P.plate('array frame', 'plain', GUNMETAL, panel, '+z', px0, px0 + 0.08, py0, 6.3, 0.016);
  P.plate('array frame', 'plain', GUNMETAL, panel, '+z', -px0 - 0.08, -px0, py0, 6.3, 0.016);
  for (let col = 0; col < 8; col++) {
    for (let row = 0; row < 3; row++) {
      const a0 = px0 + 0.12 + col * 0.46;
      const b0 = py0 + 0.12 + row * 0.4;
      P.plate('array tile', 'plain', (col + row) % 2 ? 0x5d625c : 0x4f544f, panel, '+z', a0, a0 + 0.42, b0, b0 + 0.36, 0.01);
    }
  }
  for (let x = -1.5; x <= 1.51; x += 0.75) P.plate('stiffener', 'plain', GUNMETAL, panel, '-z', x - 0.04, x + 0.04, 4.95, 6.25, 0.02);
  P.plate('iff elements', 'plain', 0x3d413e, iff, '+z', -1.6, 1.6, 6.34, 6.41, DECOR_PROUD);
  // Cabin: a door, an air-conditioner, louvres, cable runs; bed: side rails.
  P.plate('cabin door', 'paint', scaled(pal.paint, 0.88), cabin, '+x', -2.1, -1.4, 1.15, 2.25, 0.014);
  P.plate('door handle', 'plain', CHROME, cabin, '+x', -1.55, -1.48, 1.65, 1.72, DECOR_PROUD);
  P.plate('air conditioner', 'plain', 0x8a8d88, cabin, '-z', -0.6, 0.6, 1.6, 2.2, 0.024);
  P.plate('fan grille', 'plain', 0x2a2c2b, cabin, '-z', -0.4, 0.4, 1.7, 2.1, DECOR_PROUD);
  for (let y = 1.4; y < 1.9; y += 0.1) P.plate('louvre', 'plain', DARK, cabin, '-x', -1.6, -0.9, y, y + 0.04, 0.02);
  P.plate('cable run', 'plain', 0x1d1d1c, cabin, '+y', 0.1, 0.2, -1.0, -0.5, DECOR_PROUD);
  camo(P, cabin, ['+x', '-x', '+y'], [pal.camo, pal.camo2], 2, 61);
  for (const face of ['+x', '-x'] as const) P.plate('bed rail', 'plain', DARK, bed, face, -2.4, 2.2, 1.0, 1.05, 0.02);
  return P;
}

function watchTower(theme: ThemeId): Parts {
  const boxes = BASE_BOXES.watchTower;
  const P = new Parts(boxes);
  const pal = PALETTES[theme];
  colliders(P, boxes, (b) => {
    if (b.part === 'canopy') return ['plain', pal.sheet];
    if (b.part === 'lamp') return ['plain', GUNMETAL];
    if (b.part === 'frame' && b.look === 'tube') return ['trim', scaled(pal.wood, 0.85)];
    if (b.part === 'wall') return ['trim', scaled(pal.wood, 1.08)];
    return ['trim', pal.wood];
  });
  for (const b of boxes) {
    const c = b.center;
    const h = b.halfSize;
    if (b.part === 'post' && c.y < 3) P.box('leg footing', 'plain', scaled(pal.concrete, 0.8), c.x - 0.2, c.x + 0.2, -SKIRT, 0, c.z - 0.2, c.z + 0.2);
    if (b.part === 'wall') {
      // Parapet: plank joints on the outside, a capping rail on top.
      const outward: Face = h.x < h.z ? (c.x > 0 ? '+x' : '-x') : c.z > 0 ? '+z' : '-z';
      const along = outward === '+x' || outward === '-x' ? [c.z - h.z, c.z + h.z] : [c.x - h.x, c.x + h.x];
      for (let y = c.y - h.y + 0.25; y < c.y + h.y - 0.05; y += 0.25) P.plate('plank joint', 'plain', scaled(pal.wood, 0.55), b, outward, along[0], along[1], y - 0.012, y + 0.012, 0.012);
      P.plate('capping rail', 'trim', scaled(pal.wood, 0.75), b, '+y', c.x - h.x, c.x + h.x, c.z - h.z, c.z + h.z, 0.02);
    }
    if (b.part === 'canopy') {
      for (let x = -1.6; x < 1.65; x += 0.2) P.plate('roof corrugation', 'plain', scaled(pal.sheet, 0.8), b, '+y', x - 0.03, x + 0.03, -1.7, 1.7, 0.016);
      for (const face of ['+z', '-z', '+x', '-x'] as const) {
        const [a0, a1, b0, b1] = faceRange(b, face);
        P.plate('roof edge', 'plain', scaled(pal.sheet, 0.6), b, face, a0, a1, b0, b1, 0.012);
      }
    }
    if (b.part === 'lamp') P.disc('searchlight lens', 'plain', LAMP, b, '+z', c.x, c.y, 0.12, DECOR_PROUD, 16);
    if (b.part === 'roof') P.plate('deck edge', 'trim', scaled(pal.wood, 0.7), b, '+z', c.x - h.x, c.x + h.x, c.y - h.y, c.y + h.y, 0.014);
  }
  return P;
}

function hesco(theme: ThemeId): Parts {
  const boxes = BASE_BOXES.hesco;
  const P = new Parts(boxes);
  const pal = PALETTES[theme];
  const b = boxes[0];
  P.collider(0, 'plain', pal.hesco, false);
  skirt(P, b, 'plain', scaled(pal.hesco, 0.75));
  const x0 = -b.halfSize.x;
  const x1 = b.halfSize.x;
  const top = b.halfSize.y * 2;
  const z0 = -b.halfSize.z;
  const z1 = b.halfSize.z;
  const wire = scaled(pal.hesco, 0.62);
  const cell = (x1 - x0) / 5;
  // Five cells: wire-mesh posts at the cell joints, a grid of mesh lines, the geotextile bulging a little between
  // the posts, and the earth fill showing on top.
  for (const face of ['+z', '-z'] as const) {
    for (let i = 0; i <= 5; i++) {
      const x = x0 + i * cell;
      P.plate('mesh post', 'plain', wire, b, face, Math.max(x0, x - 0.035), Math.min(x1, x + 0.035), 0, top, DECOR_PROUD);
    }
    for (let y = 0.35; y < top - 0.05; y += 0.35) P.plate('mesh line', 'plain', wire, b, face, x0, x1, y - 0.01, y + 0.01, 0.02);
    for (let i = 0; i < 5; i++) {
      const xa = x0 + i * cell + 0.06;
      P.plate('bulge', 'plain', scaled(pal.hesco, 1.05), b, face, xa, xa + cell - 0.12, 0.05, top - 0.05, 0.01);
    }
  }
  for (const face of ['+x', '-x'] as const) {
    P.plate('end post', 'plain', wire, b, face, z0, z1, 0, top, 0.012);
  }
  for (let i = 0; i < 5; i++) {
    const xa = x0 + i * cell;
    P.plate('earth fill', 'plain', theme === 'arctic' ? 0xe4e8ea : scaled(pal.hesco, 0.7), b, '+y', xa + 0.05, xa + cell - 0.05, z0 + 0.05, z1 - 0.05, 0.012);
    P.plate('top wire', 'plain', wire, b, '+y', xa - 0.02, xa + 0.02, z0, z1, 0.02);
  }
  return P;
}

function sandbags(theme: ThemeId): Parts {
  const boxes = BASE_BOXES.sandbags;
  const P = new Parts(boxes);
  const pal = PALETTES[theme];
  P.collider(0, 'plain', pal.bag, false);
  skirt(P, boxes[0], 'plain', scaled(pal.bag, 0.7));
  return P;
}

function jersey(theme: ThemeId): Parts {
  const boxes = BASE_BOXES.jersey;
  const P = new Parts(boxes);
  const pal = PALETTES[theme];
  colliders(P, boxes, () => ['plain', pal.concrete]);
  const [low, high] = boxes;
  skirt(P, low, 'plain', scaled(pal.concrete, 0.8));
  P.plate('top', 'plain', scaled(pal.concrete, 1.08), high, '+y', -1.5, 1.5, -0.2, 0.2, 0.012);
  for (const face of ['+z', '-z'] as const) {
    P.plate('step', 'plain', scaled(pal.concrete, 0.88), low, face, -1.5, 1.5, 0, 0.3, 0.008);
    P.plate('reflector', 'plain', HAZARD, high, face, -0.15, 0.15, 0.6, 0.68, 0.016);
    P.plate('lifting slot', 'plain', 0x2a2a28, low, face, -0.9, -0.6, 0.05, 0.15, 0.012);
    P.plate('lifting slot', 'plain', 0x2a2a28, low, face, 0.6, 0.9, 0.05, 0.15, 0.012);
  }
  return P;
}

function gate(theme: ThemeId): Parts {
  const boxes = BASE_BOXES.gate;
  const P = new Parts(boxes);
  const pal = PALETTES[theme];
  colliders(P, boxes, (_b, i) => {
    if (i === 2) return ['plain', WHITE];
    if (i === 3) return ['paint', pal.paint];
    return ['plain', pal.concrete];
  });
  const arm = boxes[2];
  for (let x = -3.4; x < 3.5; x += 0.8) {
    for (const face of ['+z', '-z'] as const) P.plate('arm stripe', 'plain', RED, arm, face, x, Math.min(3.6, x + 0.4), 1.0, 1.12, 0.012);
    P.plate('arm stripe', 'plain', RED, arm, '+y', x, Math.min(3.6, x + 0.4), -0.05, 0.05, 0.012);
  }
  for (const b of [boxes[0], boxes[1]]) {
    skirt(P, b, 'plain', scaled(pal.concrete, 0.8));
    const c = b.center;
    for (const face of ['+z', '-z'] as const) {
      for (let y = 0.1; y < 1.25; y += 0.3) P.plate('hazard stripe', 'plain', y % 0.6 < 0.3 ? HAZARD : 0x1c1c1c, b, face, c.x - 0.3, c.x + 0.3, y, y + 0.15, 0.012);
    }
    P.plate('cap', 'plain', scaled(pal.concrete, 1.1), b, '+y', c.x - 0.3, c.x + 0.3, -0.3, 0.3, 0.012);
  }
  P.plate('counterweight', 'plain', GUNMETAL, boxes[3], '-x', -0.18, 0.18, 1.3, 1.55, DECOR_PROUD);
  return P;
}

function booth(theme: ThemeId): Parts {
  const boxes = BASE_BOXES.booth;
  const P = new Parts(boxes);
  const pal = PALETTES[theme];
  const wallColour = theme === 'arctic' ? 0x5a5f55 : pal.concrete;
  P.collider(0, 'wall', wallColour, false);
  P.collider(1, 'roof', theme === 'arctic' ? 0xdde3ea : scaled(pal.concrete, 0.8), false);
  const [w, roof] = boxes;
  skirt(P, w, 'wall', wallColour);
  // Windows on three sides (the guard sees the road both ways), the door at the back.
  glazed(P, w, '+z', -0.65, 0.65, 1.1, 1.9);
  glazed(P, w, '+x', -0.6, 0.6, 1.1, 1.9);
  glazed(P, w, '-x', -0.6, 0.6, 1.1, 1.9);
  P.plate('door', 'plain', scaled(pal.paint, 0.8), w, '-z', -0.45, 0.45, 0, 2.0, 0.018);
  P.plate('door handle', 'plain', CHROME, w, '-z', 0.25, 0.35, 1.0, 1.06, DECOR_PROUD);
  for (const face of ['+z', '-z', '+x', '-x'] as const) {
    const [a0, a1] = faceRange(w, face);
    P.plate('plinth', 'wall', scaled(wallColour, 0.7), w, face, a0, a1, 0, 0.25, 0.012);
    const [r0, r1, rb0, rb1] = faceRange(roof, face);
    P.plate('fascia', 'plain', DARK, roof, face, r0, r1, rb0, rb1, 0.012);
  }
  P.plate('stripe', 'plain', HAZARD, w, '+z', -0.9, 0.9, 2.1, 2.2, 0.012);
  return P;
}

function tent(theme: ThemeId): Parts {
  const boxes = BASE_BOXES.tent;
  const P = new Parts(boxes);
  const pal = PALETTES[theme];
  colliders(P, boxes, (b) => (b.part === 'fabric' ? ['trim', b.look === 'arch' ? scaled(pal.canvas, 0.95) : pal.canvas] : ['plain', DARK]));
  const w = boxes[0];
  skirt(P, w, 'trim', scaled(pal.canvas, 0.8));
  const flap = scaled(pal.canvas, 0.78);
  for (const face of ['+z', '-z'] as const) {
    P.plate('door flap', 'trim', flap, w, face, -0.65, 0.65, 0, 1.58, 0.014);
    P.plate('door seam', 'plain', scaled(pal.canvas, 0.5), w, face, -0.02, 0.02, 0, 1.58, 0.02);
    P.plate('rolled flap', 'trim', scaled(pal.canvas, 0.65), w, face, -0.7, 0.7, 1.42, 1.58, DECOR_PROUD);
  }
  for (const face of ['+x', '-x'] as const) {
    for (const z of [-2.6, 0, 2.6]) {
      P.plate('window', 'plain', 0x2c2b25, w, face, z - 0.45, z + 0.45, 0.85, 1.3, 0.012);
      P.plate('window roll', 'trim', scaled(pal.canvas, 0.65), w, face, z - 0.5, z + 0.5, 1.3, 1.4, 0.02);
    }
    for (let z = -4; z <= 4.01; z += 1.33) P.plate('pole seam', 'trim', scaled(pal.canvas, 0.82), w, face, Math.max(-4, z - 0.04), Math.min(4, z + 0.04), 0, 1.6, 0.016);
    P.plate('mud line', 'plain', theme === 'arctic' ? 0xb8bdb9 : scaled(pal.canvas, 0.6), w, face, -4, 4, 0, 0.18, 0.01);
  }
  return P;
}

function generator(theme: ThemeId): Parts {
  const boxes = BASE_BOXES.generator;
  const P = new Parts(boxes);
  const pal = PALETTES[theme];
  colliders(P, boxes, (b) => (b.part === 'wheel' ? ['plain', RUBBER] : b.part === 'frame' ? ['plain', GUNMETAL] : ['paint', pal.paint]));
  for (const b of boxes) if (b.part === 'wheel') hub(P, b, pal.paint);
  const body = boxes[0];
  for (const face of ['+x', '-x'] as const) {
    for (let y = 0.8; y < 1.4; y += 0.1) P.plate('louvre', 'plain', DARK, body, face, -1.0, -0.2, y, y + 0.04, 0.02);
    P.plate('door seam', 'plain', DARK, body, face, 0.1, 0.13, 0.5, 1.5, 0.016);
    P.plate('door seam', 'plain', DARK, body, face, 1.05, 1.08, 0.5, 1.5, 0.016);
    P.plate('warning plate', 'plain', HAZARD, body, face, 0.5, 0.8, 1.2, 1.35, 0.02);
  }
  P.plate('control panel', 'plain', 0x2a2c2b, body, '-z', -0.45, 0.45, 0.85, 1.4, 0.016);
  for (let i = 0; i < 3; i++) P.disc('gauge', 'plain', 0xd8d8cc, body, '-z', -0.25 + i * 0.25, 1.25, 0.05, DECOR_PROUD, 10);
  P.plate('lifting eye', 'plain', GUNMETAL, body, '+y', -0.08, 0.08, -0.05, 0.05, DECOR_PROUD);
  camo(P, body, ['+x', '-x', '+y'], [pal.camo, pal.camo2], 2, 71, DECOR_PROUD);
  return P;
}

function fuelDrums(theme: ThemeId): Parts {
  const boxes = BASE_BOXES.fuelDrums;
  const P = new Parts(boxes);
  const pal = PALETTES[theme];
  const colours = [scaled(pal.paint, 0.85), 0x3c5470, scaled(pal.paint, 0.7), 0x7a3a2a, scaled(pal.paint, 0.9), 0x3c5470, scaled(pal.paint, 0.8), 0x5a5d58];
  colliders(P, boxes, (_b, i) => ['paint', colours[i % colours.length]]);
  boxes.forEach((b, i) => {
    const c = b.center;
    const r = b.halfSize.x === b.halfSize.y ? b.halfSize.x : b.halfSize.x; // standing drums: x = z radius
    const hoop = scaled(colours[i % colours.length], 0.7);
    if (b.look === 'roundY') {
      for (const y of [0.3, 0.58]) P.cyl('hoop', 'paint', hoop, 'y', c.x, y, c.z, r + 0.012, 0.015, r + 0.012, 20);
      P.cyl('lid rim', 'plain', scaled(hoop, 0.8), 'y', c.x, 0.88 + 0.008, c.z, r - 0.02, 0.008, r - 0.02, 20);
      P.cyl('bung', 'plain', GUNMETAL, 'y', c.x + 0.15, 0.88 + 0.012, c.z, 0.04, 0.012, 0.04, 8);
    } else {
      for (const dz of [-0.14, 0.14]) P.cyl('hoop', 'paint', hoop, 'z', c.x, c.y, c.z + dz, b.halfSize.x + 0.012, b.halfSize.y + 0.012, 0.015, 20);
    }
  });
  return P;
}

function flagPole(theme: ThemeId): Parts {
  const boxes = BASE_BOXES.flagPole;
  const P = new Parts(boxes);
  const pal = PALETTES[theme];
  colliders(P, boxes, (b, i) => {
    if (i === 0) return ['plain', pal.concrete];
    if (i === 2) return ['plain', 0xb09a50];
    if (b.part === 'fabric') return ['trim', scaled(pal.paint, 0.8)];
    return ['plain', STEEL];
  });
  const flag = boxes[3];
  skirt(P, boxes[0], 'plain', scaled(pal.concrete, 0.8));
  // A plain unit flag: two bands and a hoist stripe (no real nation's colours).
  for (const face of ['+z', '-z'] as const) {
    P.plate('flag band', 'trim', theme === 'valley' ? 0x8a6a3a : pal.camo, flag, face, 0.05, 1.65, 6.9, 7.4, 0.004);
    P.plate('flag hoist', 'plain', WHITE, flag, face, 0.05, 0.3, 6.9, 7.9, 0.006);
  }
  return P;
}

function floodlight(theme: ThemeId): Parts {
  const boxes = BASE_BOXES.floodlight;
  const P = new Parts(boxes);
  const pal = PALETTES[theme];
  colliders(P, boxes, (b) => {
    if (b.part === 'wheel') return ['plain', RUBBER];
    if (b.part === 'hull') return ['paint', HAZARD];
    if (b.part === 'post') return ['plain', STEEL];
    return ['plain', GUNMETAL];
  });
  for (const b of boxes) {
    if (b.part === 'wheel') hub(P, b, pal.paint);
    if (b.part === 'lamp') {
      P.plate('lamp lens', 'plain', LAMP, b, '+z', b.center.x - 0.15, b.center.x + 0.15, 6.15, 6.41, DECOR_PROUD);
      P.plate('lamp grille', 'plain', DARK, b, '+z', b.center.x - 0.15, b.center.x + 0.15, 6.27, 6.29, DECOR_PROUD);
    }
  }
  const body = boxes[0];
  for (const face of ['+x', '-x'] as const) {
    for (let y = 0.55; y < 0.85; y += 0.08) P.plate('louvre', 'plain', DARK, body, face, -0.6, 0.2, y, y + 0.03, 0.02);
  }
  P.plate('control panel', 'plain', 0x2a2c2b, body, '+z', -0.35, 0.35, 0.5, 0.85, 0.016);
  return P;
}

function camoNet(theme: ThemeId): Parts {
  const boxes = BASE_BOXES.camoNet;
  const P = new Parts(boxes);
  const pal = PALETTES[theme];
  colliders(P, boxes, (b) => (b.part === 'net' ? ['trim', pal.net] : ['plain', scaled(pal.wood, 0.7)]));
  const net = boxes[4];
  // Garnish: patches of a second and third colour and darker holes, so the net reads as a net, not a roof.
  camo(P, net, ['+y'], [pal.netCamo, scaled(pal.net, 0.75), pal.camo2], 14, 81, 0.016);
  const rnd = lcg(82);
  for (let i = 0; i < 40; i++) {
    const x = -3.5 + 7 * rnd();
    const z = -4.8 + 9.6 * rnd();
    P.plate('net hole', 'plain', scaled(pal.net, 0.4), net, '+y', x - 0.12, x + 0.12, z - 0.12, z + 0.12, 0.008);
  }
  for (const face of ['+x', '-x', '+z', '-z'] as const) {
    const [a0, a1, b0, b1] = faceRange(net, face);
    P.plate('net edge', 'trim', pal.netCamo, net, face, a0, a1, b0, b1, 0.02);
  }
  return P;
}

function commsMast(theme: ThemeId): Parts {
  const boxes = BASE_BOXES.commsMast;
  const P = new Parts(boxes);
  const pal = PALETTES[theme];
  colliders(P, boxes, (b, i) => {
    if (i === 0) return ['paint', pal.paint];
    if (b.part === 'post') return ['plain', STEEL];
    if (b.part === 'panel') return ['plain', 0xc9ccc8];
    return ['plain', DARK];
  });
  const [shelter, mast] = boxes;
  P.plate('door', 'paint', scaled(pal.paint, 0.85), shelter, '+z', -0.45, 0.45, 0.05, 2.0, 0.016);
  P.plate('door handle', 'plain', CHROME, shelter, '+z', 0.25, 0.35, 1.0, 1.05, DECOR_PROUD);
  P.plate('air conditioner', 'plain', 0x8a8d88, shelter, '-x', -0.5, 0.5, 1.3, 1.9, 0.024);
  P.plate('fan grille', 'plain', 0x2a2c2b, shelter, '-x', -0.35, 0.35, 1.4, 1.8, DECOR_PROUD);
  P.plate('cable entry', 'plain', DARK, shelter, '+x', -0.2, 0.2, 1.8, 2.1, DECOR_PROUD);
  for (const face of ['+x', '-x', '+z', '-z'] as const) {
    const [a0, a1] = faceRange(shelter, face);
    P.plate('corner casting', 'plain', GUNMETAL, shelter, face, a0, a0 + 0.12, 2.15, 2.3, 0.02);
    P.plate('corner casting', 'plain', GUNMETAL, shelter, face, a1 - 0.12, a1, 2.15, 2.3, 0.02);
  }
  camo(P, shelter, ['+x', '-x', '+z', '-z', '+y'], [pal.camo, pal.camo2], 2, 91);
  // Mast: red and white bands near the top (an obstruction marking), climbing rungs at the foot.
  const mx = mast.center.x;
  for (let i = 0; i < 4; i++) P.cyl('mast band', 'plain', i % 2 ? WHITE : RED, 'y', mx, 9.0 + i * 1.0 + 0.5, 0, 0.125, 0.5, 0.125, 12);
  for (let y = 0.4; y < 2.6; y += 0.35) P.box('rung', 'plain', DARK, mx - 0.08, mx + 0.08, y, y + 0.03, -0.11 - 0.02, -0.11);
  return P;
}

const BUILDERS: Record<BaseKind, (theme: ThemeId) => Parts> = {
  tank,
  artillery,
  cargoTruck,
  fuelTruck,
  helicopter,
  helipad,
  ammoCrates,
  mgNest,
  radar,
  aaGun,
  watchTower,
  hesco,
  sandbags,
  jersey,
  gate,
  booth,
  tent,
  generator,
  fuelDrums,
  flagPole,
  floodlight,
  camoNet,
  commsMast,
};

/** Every part of a military prop in its local frame (collider boxes, in order, then decorations). */
export function baseParts(kind: BaseKind, theme: ThemeId): readonly PropPart[] {
  return BUILDERS[kind](theme).list;
}
