// Pure dummy dimensions (no three.js): the visible mesh in scene/target.ts, the hit spheres and the
// mission layout (aim points, upright bounds) are all built from these numbers, so they cannot drift apart.

export const DUMMY_KHAKI = 0x70623f;

/** Hit spheres may stick out past the visible silhouette by at most this, m (the soldier's and the sniper's alike). */
export const MAX_OVERHANG = 0.03;
const VEST_COLOR = 0x3f3a26;
const BOOT_COLOR = 0x2b251a;

// ---------------------------------------------------------------------------------------------
// Dummy dimensions, m. Origin at the feet, +Z toward the shooter. The visible mesh AND the hit
// spheres are both built from these numbers, so they cannot drift apart.
// ---------------------------------------------------------------------------------------------

/** An axis-aligned box of the visible dummy. (cx, cy, cz) is its centre. */
export interface DummyBox {
  name: string;
  cx: number;
  cy: number;
  cz: number;
  w: number;
  h: number;
  d: number;
  color: number;
}

export const DUMMY_HEAD = { cy: 1.65, radius: 0.12 } as const;

/** Height of the upper-torso hit sphere centre above the feet, m. */
export const UPPER_TORSO_CY = 1.35;
/** Height of the lower-torso hit sphere centre above the feet, m. */
export const LOWER_TORSO_CY = 1.0;

/**
 * Upright bounds of a standing dummy, used by the mission layout so one soldier cannot hide another:
 * a box around the whole body (the arms reach 0.32 m to the side, the boots 0.17 m forward), feet on
 * the ground, in the dummy's own frame (origin at the feet).
 */
export const DUMMY_UPRIGHT = { halfWidth: 0.32, halfHeight: 0.9, halfDepth: 0.2 } as const;

export const ARM_X = 0.27;
export const LEG_X = 0.1;

export const NECK: DummyBox = { name: 'neck', cx: 0, cy: 1.54, cz: 0, w: 0.08, h: 0.1, d: 0.08, color: DUMMY_KHAKI };
export const VEST: DummyBox = { name: 'vest', cx: 0, cy: 1.35, cz: 0, w: 0.46, h: 0.5, d: 0.22, color: VEST_COLOR };
export const PELVIS: DummyBox = { name: 'pelvis', cx: 0, cy: 0.97, cz: 0, w: 0.34, h: 0.26, d: 0.2, color: DUMMY_KHAKI };
export const arm = (side: -1 | 1): DummyBox => ({
  name: side < 0 ? 'left arm' : 'right arm',
  cx: side * ARM_X,
  cy: 1.26,
  cz: 0,
  w: 0.1,
  h: 0.62,
  d: 0.12,
  color: DUMMY_KHAKI,
});
export const leg = (side: -1 | 1): DummyBox => ({
  name: side < 0 ? 'left leg' : 'right leg',
  cx: side * LEG_X,
  cy: 0.45,
  cz: 0,
  w: 0.15,
  h: 0.78,
  d: 0.17,
  color: DUMMY_KHAKI,
});
export const boot = (side: -1 | 1): DummyBox => ({
  name: side < 0 ? 'left boot' : 'right boot',
  cx: side * LEG_X,
  cy: 0.04,
  cz: 0.04,
  w: 0.16,
  h: 0.08,
  d: 0.26,
  color: BOOT_COLOR,
});

/**
 * Corner radius of the rounded box drawn for each DUMMY_BOXES entry, m (the neck is covered by the scarf and not
 * drawn). The hit spheres are frozen against the sharp boxes and already reach MAX_OVERHANG past their faces, so
 * the drawn corners may only trim what the spheres' own corners leave to spare: small radii, and no capsules.
 * scene/target.ts builds the mesh with exactly these numbers and tests/scene/target.test.ts measures the result.
 */
export const DUMMY_CORNER_RADIUS: Readonly<Record<string, number>> = {
  vest: 0.03,
  pelvis: 0.025,
  'left arm': 0.02,
  'right arm': 0.02,
  'left leg': 0.02,
  'right leg': 0.02,
  'left boot': 0.02,
  'right boot': 0.02,
};

/** The corner radius the mesh of `box` is drawn with, m. */
export const cornerRadius = (box: DummyBox): number => DUMMY_CORNER_RADIUS[box.name] ?? 0;

/** Every box of the visible dummy (the head is a sphere of DUMMY_HEAD.radius, not listed here). */
export const DUMMY_BOXES: readonly DummyBox[] = [
  NECK,
  VEST,
  PELVIS,
  arm(-1),
  arm(1),
  leg(-1),
  leg(1),
  boot(-1),
  boot(1),
];

