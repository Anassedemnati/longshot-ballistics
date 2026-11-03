import { createRng } from './random';
import { SNIPER_PARTS, SNIPER_RIFLE } from './sniperDims';
import type { ModelPart, SkinBinding, V3 } from './modelPart';

// The prone enemy sniper as DRAWN (pure data, no three.js; scene/sniperMesh.ts turns it into triangles): a rifleman
// in a ghillie suit lying head toward the shooter, hooded, elbows down and forearms forward, boots splayed behind,
// a pack on his back, behind a scoped bolt rifle on a bipod.
//
// None of this is a hit zone. The hit spheres are blanketed over the ellipsoids of SNIPER_PARTS (sniperParts.ts) and
// stay as they were, so the drawn body is made of the same ellipsoids (the base mass of the suit, a hair smaller so the
// shaggy strands can finish the outline) and tests/scene/sniperMesh.test.ts measures what it covers from 14 angles.
// Frame: origin on the ground under the belly, +Z toward the shooter (the head end), +Y up, +X to his left; the rifle is
// in its own frame at SNIPER_RIFLE.pivot (it sweeps about that point), +Z along the barrel.

// ---- colours (sRGB hex) ----
const SUIT = 0x626243; // the cloth under the strands: dark, so the gaps between them read as depth
const SUIT_DARK = 0x525237;
const PACK = 0x52523a;
const HAT = 0x646445;
const GLOVE = 0x2a2820;
const BOOT = 0x37302a;
const FACE = 0x74603f; // skin under face paint
const LENS = 0x10161a;
const STEEL = 0x2b2f31;
const STOCK = 0x3d4331;

/** The jute strands of the suit, as sRGB hex: dry grass, olive, brown, dark moss and a sandy tan. */
export const GHILLIE_TONES: readonly number[] = [0x8c7f56, 0x6a7147, 0x5e5136, 0x535f35, 0x9a8d63];

/**
 * The base mass is each hit ellipsoid scaled by this: the spheres were blanketed over the exact ellipsoids with the full MAX_OVERHANG,
 * so a polygonal mesh inside them would leave the rim of a disc more than 3 cm out; 5 % (6-10 mm) more than covers the facets.
 */
export const SNIPER_BASE_SCALE = 1.05;

/** The bone each part of SNIPER_PARTS rides when he goes limp (by index in SNIPER_PARTS; scene/ragdollBody.ts, mission/sniperRig.ts). The right side is -X. */
export const SNIPER_PART_BONES: readonly string[] = ['chest', 'pelvis', 'legR', 'legL', 'armR', 'armL', 'head'];
/** The pack on his back hangs between his shoulders and his hips: weighted from the pelvis bone to the chest bone along his length. */
const PACK_SKIN: SkinBinding = { low: 'pelvis', high: 'chest', axis: 2, from: -0.76, to: -0.4 };

/** The prone body: the suit's mass in the shape of the hit ellipsoids, hood, face, gloves, boots and pack. */
export function sniperBodyParts(): ModelPart[] {
  const parts: ModelPart[] = [];
  SNIPER_PARTS.forEach((p, index) => {
    if (p.zone === 'head') return; // the hood below
    const radii: V3 = [p.rx * SNIPER_BASE_SCALE, p.ry * SNIPER_BASE_SCALE, p.rz * SNIPER_BASE_SCALE];
    const limb = p.zone === 'limbs';
    parts.push({ kind: 'ellipsoid', c: [p.cx, p.cy, p.cz], r: radii, surface: 'cloth', color: limb ? SUIT : SUIT_DARK, detail: 1, skin: SNIPER_PART_BONES[index] });
  });
  const head = SNIPER_PARTS.find((p) => p.zone === 'head');
  if (!head) throw new Error('sniper has no head');
  const hood = head.rx * 1.03;
  const headParts: ModelPart[] = [
    { kind: 'ellipsoid', c: [head.cx, head.cy, head.cz], r: [hood, hood, hood], surface: 'cloth', color: SUIT, detail: 1 }, // the hood
    { kind: 'ellipsoid', c: [head.cx, head.cy - 0.015, head.cz + 0.095], r: [0.074, 0.07, 0.05], surface: 'skin', color: FACE }, // the face in the hood opening
    { kind: 'ellipsoid', c: [0, head.cy + 0.002, head.cz + 0.136], r: [0.05, 0.014, 0.012], surface: 'glass', color: LENS }, // sunglasses
    // a boonie hat over the hood: crown and a floppy brim that shades the face
    {
      kind: 'lathe',
      profile: [[0.12, -0.014], [0.17, -0.014], [0.172, 0.004], [0.135, 0.012], [0.126, 0.04], [0.1, 0.064], [0.05, 0.074], [0, 0.076]],
      c: [head.cx, head.cy + 0.062, head.cz - 0.005],
      surface: 'cloth',
      color: HAT,
      sides: 16,
    },
  ];
  parts.push(
    ...headParts.map((part): ModelPart => ({ ...part, skin: 'head' })),
    // the pack on his back (under the strands)
    { kind: 'ellipsoid', c: [0, 0.3, -0.58], r: [0.17, 0.1, 0.22], surface: 'cloth', color: PACK, detail: 1, skin: PACK_SKIN },
  );
  for (const side of [-1, 1] as const) {
    parts.push(
      { kind: 'ellipsoid', c: [side * 0.25, 0.13, 0.215], r: [0.062, 0.05, 0.085], surface: 'gear', color: GLOVE, skin: side > 0 ? 'armL' : 'armR' }, // gloved hands
      { kind: 'ellipsoid', c: [side * 0.15, 0.065, -1.52], r: [0.075, 0.062, 0.11], surface: 'polymer', color: BOOT, rot: [0, side * -0.25, 0], skin: side > 0 ? 'legL' : 'legR' }, // boots, toes turned out
    );
  }
  return parts;
}

/** One strand of the ghillie suit: a thin three-sided spike from `root` to `tip`. */
export interface Strand {
  root: V3;
  tip: V3;
  /** Radius of its base, m. */
  radius: number;
  color: number;
  /** The index in SNIPER_PARTS of the part of the suit it hangs from (it rides that part's bone). */
  part: number;
}

/** How many strands go on each hit ellipsoid of the suit (by its index in SNIPER_PARTS; the head's are the hood's). */
const STRANDS_PER_PART: readonly number[] = [200, 95, 80, 80, 70, 70, 40];
/** No strand reaches farther than this out from the surface of the suit it hangs from, m. */
const STRAND_REACH = 0.04;
/** Strands are never rooted in front of this z (the face and the sight line), m. */
const STRAND_MAX_Z = 0.19;

/**
 * The suit's strands, seeded (always the same): rooted on the base mass, drooping down and back like hanging jute,
 * 6.5-12 cm long. The ones on the head are on its top and sides only.
 */
export function sniperStrands(): Strand[] {
  const rng = createRng(0x9e3779b1);
  const strands: Strand[] = [];
  SNIPER_PARTS.forEach((p, index) => {
    const count = STRANDS_PER_PART[index] ?? 40;
    const head = p.zone === 'head';
    for (let made = 0, tries = 0; made < count && tries < count * 40; tries++) {
      // A uniform direction on the sphere, upper and side hemispheres only (the underside lies on the ground).
      const nz = rng() * 2 - 1;
      const phi = rng() * 2 * Math.PI;
      const s = Math.sqrt(1 - nz * nz);
      const n: V3 = [s * Math.cos(phi), s * Math.sin(phi), nz];
      if (n[1] < -0.25) continue;
      const root: V3 = [
        p.cx + n[0] * p.rx * SNIPER_BASE_SCALE,
        p.cy + n[1] * p.ry * SNIPER_BASE_SCALE,
        p.cz + n[2] * p.rz * SNIPER_BASE_SCALE,
      ];
      if (root[2] > STRAND_MAX_Z) continue; // not in front of the face
      if (head && (n[1] < 0.2 || (n[2] > 0.45 && n[1] < 0.75))) continue; // the hood: top and back, and a fringe over the brow
      // The outward normal of the ellipsoid there, then weighed against gravity and the way he lies (strands trail backward).
      const out: V3 = [n[0] / p.rx, n[1] / p.ry, n[2] / p.rz];
      const ol = Math.hypot(...out);
      const jitter = (): number => (rng() - 0.5) * 0.7;
      const unit: V3 = [out[0] / ol, out[1] / ol, out[2] / ol];
      const raw: [number, number, number] = [unit[0] * 0.55 + jitter() * 0.4, unit[1] * 0.4 - 0.85 + jitter() * 0.35, unit[2] * 0.4 - 0.45 + jitter() * 0.4];
      // Never pointing into the suit: lean it out until it clears the surface by a little.
      const into = raw[0] * unit[0] + raw[1] * unit[1] + raw[2] * unit[2];
      const lift = Math.max(0, 0.22 * Math.hypot(...raw) - into);
      raw[0] += unit[0] * lift;
      raw[1] += unit[1] * lift;
      raw[2] += unit[2] * lift;
      const rl = Math.hypot(...raw);
      // 6.5-12 cm long, but never reaching out more than STRAND_REACH past the suit: a strand that points away from it is shorter.
      const outward = (raw[0] * unit[0] + raw[1] * unit[1] + raw[2] * unit[2]) / rl;
      const length = Math.min(0.065 + 0.055 * rng(), STRAND_REACH / Math.max(outward, 0.1));
      const tip: V3 = [root[0] + (raw[0] / rl) * length, Math.max(0.004, root[1] + (raw[1] / rl) * length), root[2] + (raw[2] / rl) * length];
      const tone = GHILLIE_TONES[Math.floor(rng() * GHILLIE_TONES.length)];
      strands.push({ root, tip, radius: 0.005 + 0.0035 * rng(), color: tone, part: index });
      made++;
    }
  });
  return strands;
}

/** The scoped bolt rifle on its bipod, in the rifle's own frame (origin at SNIPER_RIFLE.pivot, barrel along +Z). */
export function sniperRifleParts(): ModelPart[] {
  const { bipod, glint } = SNIPER_RIFLE;
  const bore = 0.09; // the bore axis above the pivot; the scope sits 7 cm above it, at the glint's height
  const scopeY = glint.y;
  const parts: ModelPart[] = [
    { kind: 'box', c: [0, bore - 0.02, -0.19], size: [0.05, 0.105, 0.28], radius: 0.014, surface: 'polymer', color: STOCK }, // stock
    { kind: 'box', c: [0, bore + 0.04, -0.21], size: [0.04, 0.03, 0.12], radius: 0.008, surface: 'polymer', color: STOCK }, // cheek rest
    { kind: 'box', c: [0, bore - 0.02, -0.317], size: [0.052, 0.12, 0.016], radius: 0.006, surface: 'polymer', color: 0x1b1a17 }, // butt pad
    { kind: 'box', c: [0, bore, 0.04], size: [0.06, 0.08, 0.2], radius: 0.012, surface: 'metal', color: STEEL }, // action
    { kind: 'tube', a: [0.03, bore + 0.012, 0.0], b: [0.085, bore + 0.002, -0.01], ra: 0.006, rb: 0.006, surface: 'metal', color: STEEL, sides: 6 }, // bolt handle
    { kind: 'ellipsoid', c: [0.093, bore, -0.01], r: [0.014, 0.014, 0.014], surface: 'metal', color: STEEL }, // and its knob
    { kind: 'tube', a: [0, bore - 0.012, 0.14], b: [0, bore - 0.012, 0.4], ra: 0.029, rb: 0.026, surface: 'polymer', color: STOCK, sides: 8 }, // forend
    { kind: 'tube', a: [0, bore, 0.14], b: [0, bore, 0.485], ra: 0.016, rb: 0.012, surface: 'metal', color: STEEL, sides: 8 }, // barrel
    { kind: 'tube', a: [0, bore, 0.47], b: [0, bore, 0.505], ra: 0.02, rb: 0.02, surface: 'metal', color: STEEL, sides: 8 }, // muzzle brake
    // The scope: tube, flared objective ending just behind the glint, eyepiece, rings and turrets.
    { kind: 'tube', a: [0, scopeY, -0.04], b: [0, scopeY, 0.2], ra: 0.017, rb: 0.017, surface: 'metal', color: STEEL, sides: 10 },
    { kind: 'tube', a: [0, scopeY, 0.2], b: [0, scopeY, 0.268], ra: 0.021, rb: 0.03, surface: 'metal', color: STEEL, sides: 10 },
    { kind: 'ellipsoid', c: [0, scopeY, 0.292], r: [0.027, 0.027, 0.006], surface: 'glass', color: LENS },
    { kind: 'tube', a: [0, scopeY, -0.1], b: [0, scopeY, -0.04], ra: 0.024, rb: 0.019, surface: 'metal', color: STEEL, sides: 10 },
    { kind: 'box', c: [0, scopeY - 0.04, 0.0], size: [0.03, 0.06, 0.026], radius: 0.006, surface: 'metal', color: STEEL },
    { kind: 'box', c: [0, scopeY - 0.04, 0.14], size: [0.03, 0.06, 0.026], radius: 0.006, surface: 'metal', color: STEEL },
    { kind: 'ellipsoid', c: [0, scopeY + 0.025, 0.07], r: [0.013, 0.014, 0.013], surface: 'metal', color: STEEL }, // elevation turret
    { kind: 'box', c: [0, bore - 0.005, 0.36], size: [0.04, 0.03, 0.04], radius: 0.006, surface: 'metal', color: STEEL }, // bipod hinge
  ];
  for (const leg of bipod) {
    // The old bipod legs ran from y = -0.22 to 0.02 below the pivot, splayed outward by `tilt`; the bore is higher now, so each leg
    // starts at the hinge and ends where the old one did.
    const half = leg.length / 2;
    parts.push({
      kind: 'tube',
      a: [leg.x * 0.4, bore - 0.01, leg.z],
      b: [leg.x + Math.sin(leg.tilt) * half, leg.y - Math.cos(leg.tilt) * half, leg.z],
      ra: 0.009,
      rb: 0.007,
      surface: 'metal',
      color: STEEL,
      sides: 6,
    });
  }
  return parts;
}
