import { frameAlong, pair } from './modelPart';
import type { ModelGroup, ModelPart, SkinBinding, V3 } from './modelPart';

// The standing soldier as DRAWN (pure data, no three.js; scene/soldierMesh.ts turns it into triangles): a rifleman
// in a combat helmet with goggles, a face wrap, a camo uniform, a plate carrier with magazine pouches, hip kit, an
// assault pack, knee pads, gloves and boots, holding an assault rifle across his body at the low ready.
//
// None of this is a hit zone. The hit spheres are blanketed over the old boxes of dummyDims.ts (DUMMY_BOXES) and
// stay as they were, so what is drawn has to cover them: every sphere may stick out of the visible silhouette by at
// most MAX_OVERHANG. That is what dictates the proportions below (tests/scene/soldierMesh.test.ts measures it):
//   * the arms hang at the sides, x = +-0.27, from the shoulder down to the hip, because the arm spheres do (the
//     forearms come inward across the belly, and the hip pouches fill the column below the elbows);
//   * the legs stay 0.15 m wide from the hip to the boot, bloused over the boots, because the leg spheres are;
//   * the shoulders and the top of the pack rise to y = 1.6, because the top row of chest spheres reaches 1.63.
// Frame: origin at the feet, +Z toward the shooter, +Y up, +X to his left (the same frame as the dummy's boxes).

// ---- colours (sRGB hex; the camo carries its own tones, white leaves it as printed) ----
const CAMO = 0xffffff;
const CAMO_DARK = 0xc9c4b4; // helmet cover and pack: the same print, a little darker
const CARRIER = 0x423d29; // plate carrier and webbing: the old vest's dark olive, a touch lighter
const POUCH = 0x39351f;
const GLOVE = 0x26241c;
const KNEE = 0x38352a;
const BOOT = 0x3a2f22;
const SKIN = 0x9a7556;
const WRAP = 0x8a7d5c; // the face wrap and neck scarf: a tan shemagh
const LENS = 0x12171a;
const STEEL = 0x26292b;
const FURNITURE = 0x2f302b;

/** Where the weapon lies: the stock end, and the way it points (forward and to his left, a little down). */
export const SOLDIER_RIFLE_BUTT: V3 = [-0.3, 1.155, 0.08];
export const SOLDIER_RIFLE_DIR: V3 = [0.78, -0.12, 0.62];

/** The soldier's joints standing at rest, in the model's frame (the ragdoll rig, mission/soldierRig.ts, starts from them: what is drawn and what falls cannot drift apart). The left side is +X. */
export const SOLDIER_JOINTS = {
  shoulderY: 1.508,
  shoulderX: 0.268,
  hipX: 0.1,
  hipY: 0.95,
  /** Knee and ankle of one leg (the leg on his left, +X, is a step forward). */
  knee: (side: -1 | 1): V3 => [0.1 * side, 0.5, 0.015 + 0.035 * (side > 0 ? 1 : 0)],
  ankle: (side: -1 | 1): V3 => [0.1 * side, 0.16, -0.01 + 0.05 * (side > 0 ? 1 : 0)],
  rightElbow: [-0.28, 1.17, 0.05] as V3,
  leftElbow: [0.27, 1.17, 0.14] as V3,
  rightHand: [-0.07, 1.09, 0.265] as V3,
  leftHand: [0.135, 1.075, 0.43] as V3,
};

/** Everything in `parts` rides the bone (or blend of bones) `skin` when the body goes limp. */
const skinned = (parts: ModelPart[], skin: SkinBinding): ModelPart[] => parts.map((p) => ({ ...p, skin }));
/** The torso parts: weighted from the pelvis bone at the belt to the chest bone at the ribs, so the waist bends instead of cracking. */
const SPINE: SkinBinding = { low: 'pelvis', high: 'chest', axis: 1, from: 1.1, to: 1.4 };

const t = (a: V3, b: V3, ra: number, rb: number, surface: ModelPart['surface'], color: number, extra: Partial<{ sx: number; sz: number; sides: number; caps: number }> = {}): ModelPart => ({
  kind: 'tube',
  a,
  b,
  ra,
  rb,
  surface,
  color,
  ...extra,
});
const e = (c: V3, r: V3, surface: ModelPart['surface'], color: number, rot?: V3, detail?: number): ModelPart => ({ kind: 'ellipsoid', c, r, surface, color, rot, detail });
const b = (c: V3, size: V3, radius: number, surface: ModelPart['surface'], color: number, rot?: V3): ModelPart => ({ kind: 'box', c, size, radius, surface, color, rot });

/** The legs, pelvis, belt and hip kit. The leg on his left (+X) is a step forward. */
function lowerBody(): ModelPart[] {
  const parts: ModelPart[] = [];
  for (const side of [-1, 1] as const) {
    const x = 0.1 * side;
    const front = side > 0 ? 1 : 0; // the left leg steps forward
    const kneeZ = 0.015 + 0.035 * front;
    const ankleZ = -0.01 + 0.05 * front;
    const bone = side > 0 ? 'L' : 'R';
    parts.push(
      ...skinned([t([x, 0.95, 0], [x, 0.5, kneeZ], 0.083, 0.078, 'camo', CAMO)], `thigh${bone}`), // thigh
      ...skinned(
        [
          t([x, 0.5, kneeZ], [x, 0.16, ankleZ], 0.078, 0.078, 'camo', CAMO), // shin, trousers bloused over the boot
          e([x, 0.195, ankleZ], [0.084, 0.06, 0.086], 'camo', CAMO), // the blousing
          b([x, 0.52, kneeZ + 0.082], [0.1, 0.11, 0.046], 0.02, 'gear', KNEE), // knee pad
          t([x, 0.06, ankleZ + 0.015], [x, 0.21, ankleZ], 0.079, 0.079, 'polymer', BOOT, { caps: 2 }), // boot shaft, down to the sole
          e([x, 0.05, ankleZ + 0.065], [0.084, 0.066, 0.15], 'polymer', BOOT), // boot
        ],
        `shin${bone}`,
      ),
    );
  }
  parts.push(
    ...skinned(
      [
        e([0, 0.99, 0], [0.18, 0.135, 0.125], 'camo', CAMO, undefined, 1), // pelvis
        { kind: 'lathe', profile: [[0.96, -0.032], [1, -0.024], [1, 0.024], [0.96, 0.032]], c: [0, 1.065, 0], scale: [0.19, 1, 0.135], surface: 'gear', color: CARRIER, sides: 16 }, // belt
        b([-0.262, 1.04, 0.005], [0.13, 0.22, 0.1], 0.028, 'gear', POUCH), // right hip: holster and utility pouch
        b([-0.262, 1.1, 0.06], [0.1, 0.04, 0.03], 0.01, 'gear', CARRIER), // its flap
        b([0.262, 1.04, 0.005], [0.13, 0.22, 0.1], 0.028, 'gear', POUCH), // left hip: dump pouch
        b([0.262, 1.1, 0.06], [0.1, 0.04, 0.03], 0.01, 'gear', CARRIER),
      ],
      'pelvis',
    ),
    ...pair({ ...b([0.19, 0.74, 0.01], [0.05, 0.17, 0.13], 0.022, 'camo', 0xd6d0bd), skin: 'thighL' }), // cargo pockets (the mirrored one rides the right thigh)
  );
  return parts;
}

/** Torso: uniform, plate carrier with three magazine pouches, shoulder pads, assault pack, neck wrap. */
function upperBody(): ModelPart[] {
  const parts: ModelPart[] = [
    e([0, 1.19, 0], [0.165, 0.12, 0.115], 'camo', CAMO, undefined, 1), // abdomen
    e([0, 1.38, -0.005], [0.19, 0.17, 0.125], 'camo', CAMO, undefined, 1), // chest
    { kind: 'lathe', profile: [[0.96, -0.07], [1, -0.06], [1, 0.06], [0.96, 0.07]], c: [0, 1.185, 0], scale: [0.185, 1, 0.13], surface: 'gear', color: CARRIER, sides: 16 }, // cummerbund
    b([0, 1.36, 0.12], [0.31, 0.33, 0.05], 0.022, 'gear', CARRIER), // front plate
    b([-0.095, 1.255, 0.16], [0.08, 0.125, 0.045], 0.012, 'gear', POUCH), // three magazine pouches
    b([0, 1.255, 0.16], [0.08, 0.125, 0.045], 0.012, 'gear', POUCH),
    b([0.095, 1.255, 0.16], [0.08, 0.125, 0.045], 0.012, 'gear', POUCH),
    b([-0.095, 1.31, 0.17], [0.075, 0.03, 0.045], 0.008, 'gear', CARRIER), // their flaps
    b([0, 1.31, 0.17], [0.075, 0.03, 0.045], 0.008, 'gear', CARRIER),
    b([0.095, 1.31, 0.17], [0.075, 0.03, 0.045], 0.008, 'gear', CARRIER),
    b([0.085, 1.45, 0.152], [0.105, 0.07, 0.04], 0.014, 'gear', POUCH), // admin pouch
    b([0, 1.28, -0.2], [0.32, 0.38, 0.15], 0.05, 'camo', 0xb7b29d), // assault pack
    t([-0.15, 1.5, -0.2], [0.15, 1.5, -0.2], 0.042, 0.042, 'gear', 0x5b5a3c), // sleeping mat rolled on top of it
    t([0, 1.5, 0], [0, 1.6, 0.015], 0.052, 0.05, 'skin', SKIN, { sides: 8 }), // neck
    e([0, 1.548, 0.01], [0.098, 0.052, 0.098], 'cloth', WRAP), // neck wrap
  ];
  // Shoulders: carrier straps and a shemagh draped over them, so the top row of the torso spheres (they reach y = 1.63) has something under it.
  parts.push(...pair(b([0.15, 1.52, 0.0], [0.17, 0.05, 0.19], 0.02, 'gear', CARRIER)));
  parts.push(...pair(e([0.15, 1.54, 0.012], [0.115, 0.068, 0.1], 'camo', CAMO_DARK)));
  return skinned(parts, SPINE);
}

/** Head: skull, face wrap, sunglasses, ears, and the helmet with its cover, goggles and mount. */
function head(): ModelPart[] {
  const helmet: ModelPart = {
    kind: 'lathe',
    // skirt, side wall, crown (radius, height above the rim), scaled to 0.30 m wide and 0.35 m long
    profile: [
      [0.148, -0.05],
      [0.16, -0.012],
      [0.156, 0.025],
      [0.14, 0.066],
      [0.11, 0.104],
      [0.065, 0.128],
      [0, 0.137],
    ],
    c: [0, 1.7, -0.016],
    scale: [1.0, 1.03, 1.1],
    rot: [-0.3, 0, 0],
    surface: 'camo',
    color: CAMO_DARK,
    sides: 16,
  };
  return skinned([
    e([0, 1.645, 0.012], [0.1, 0.117, 0.11], 'skin', SKIN, undefined, 1), // skull and face
    ...pair(e([0.1, 1.652, -0.005], [0.022, 0.042, 0.03], 'skin', SKIN)), // ears
    e([0, 1.604, 0.054], [0.1, 0.058, 0.074], 'cloth', WRAP), // face wrap over nose and mouth
    e([0, 1.666, 0.086], [0.085, 0.02, 0.035], 'glass', LENS, undefined, 1), // wraparound sunglasses
    helmet,
    { kind: 'lathe', profile: [[0.154, -0.014], [0.166, -0.012], [0.166, 0.012], [0.154, 0.014]], c: [0, 1.716, -0.016], scale: [1.0, 1.03, 1.1], rot: [-0.3, 0, 0], surface: 'gear', color: GLOVE, sides: 16 }, // helmet band
    e([0, 1.632, 0.113], [0.014, 0.024, 0.022], 'skin', SKIN), // nose
  ], 'head');
}

/** The arms: shoulder to elbow hanging at the side, elbow to hand carrying the rifle; gloves. */
function arms(): ModelPart[] {
  const { rightElbow, leftElbow, rightHand, leftHand, shoulderX, shoulderY } = SOLDIER_JOINTS;
  const parts: ModelPart[] = [];
  const arm = (shoulder: V3, elbow: V3, hand: V3, bone: 'L' | 'R'): void => {
    parts.push(
      ...skinned([t(shoulder, elbow, 0.073, 0.058, 'camo', CAMO, { caps: 2 })], `upperArm${bone}`), // upper arm, its rounded top is the shoulder
      ...skinned(
        [
          e(elbow, [0.058, 0.058, 0.052], 'gear', KNEE), // elbow pad
          t(elbow, hand, 0.054, 0.042, 'camo', CAMO), // forearm
          e(hand, [0.046, 0.046, 0.056], 'gear', GLOVE), // gloved hand
        ],
        `foreArm${bone}`,
      ),
    );
  };
  arm([-shoulderX, shoulderY, 0], rightElbow, rightHand, 'R');
  arm([shoulderX, shoulderY, 0], leftElbow, leftHand, 'L');
  return parts;
}

/** The assault rifle, along +Z from the butt (z = 0) to the muzzle (z = 0.84), top at +Y. */
function rifle(): ModelPart[] {
  return [
    b([0, -0.02, 0.095], [0.04, 0.085, 0.19], 0.012, 'polymer', FURNITURE), // stock
    b([0, -0.02, 0.005], [0.042, 0.1, 0.018], 0.006, 'polymer', 0x1c1b18), // butt pad
    b([0, 0, 0.31], [0.05, 0.085, 0.24], 0.01, 'metal', STEEL), // receiver
    b([0, 0.055, 0.31], [0.024, 0.02, 0.24], 0.006, 'metal', STEEL), // top rail
    t([0, 0.088, 0.27], [0, 0.088, 0.37], 0.021, 0.021, 'polymer', 0x1a1c1d, { sides: 8 }), // optic
    e([0, 0.088, 0.372], [0.019, 0.019, 0.004], 'glass', LENS), // its lens
    b([0, 0.066, 0.31], [0.03, 0.026, 0.05], 0.006, 'metal', STEEL), // optic mount
    t([0, -0.035, 0.27], [0, -0.115, 0.255], 0.019, 0.017, 'polymer', FURNITURE, { sides: 8 }), // pistol grip
    b([0, -0.105, 0.355], [0.032, 0.125, 0.058], 0.006, 'metal', STEEL, [-0.18, 0, 0]), // magazine
    t([0, 0, 0.43], [0, 0, 0.68], 0.034, 0.034, 'polymer', FURNITURE, { sides: 8 }), // handguard
    t([0, 0, 0.68], [0, 0, 0.84], 0.0105, 0.0105, 'metal', STEEL, { sides: 8 }), // barrel
    t([0, 0, 0.8], [0, 0, 0.84], 0.016, 0.016, 'metal', STEEL, { sides: 8 }), // muzzle device
    b([0, 0.04, 0.72], [0.008, 0.04, 0.012], 0.002, 'metal', STEEL), // front sight
  ];
}

/** The whole soldier as groups of parts (the rifle in its own frame, laid along its direction). */
export function soldierModel(): ModelGroup[] {
  return [
    { parts: [...lowerBody(), ...upperBody(), ...head(), ...arms()] },
    { frame: frameAlong(SOLDIER_RIFLE_BUTT, SOLDIER_RIFLE_DIR), parts: skinned(rifle(), 'rifle') },
  ];
}
