import * as THREE from 'three';
import type { HitTarget, HitZone, ZoneName } from '../game/hit';
import { terrainHeight } from './terrainHeight';

const KHAKI = 0x70623f;
const VEST_COLOR = 0x3f3a26;
const BOOT_COLOR = 0x2b251a;

/** Time to tip over backwards, s. */
export const FALL_DURATION = 0.4;
/** How long the body lies on the sand after the fall before the dummy stands up again, s. */
export const RESET_DELAY = 3;
/** Summed frame times can fall a hair short of a whole number of seconds. */
const TIMER_EPSILON = 1e-9;
/** After falling the body lies on its back; this lifts it so it rests on the sand, m. */
const LYING_LIFT = 0.1;

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

const ARM_X = 0.27;
const LEG_X = 0.1;

const NECK: DummyBox = { name: 'neck', cx: 0, cy: 1.54, cz: 0, w: 0.08, h: 0.1, d: 0.08, color: KHAKI };
const VEST: DummyBox = { name: 'vest', cx: 0, cy: 1.35, cz: 0, w: 0.46, h: 0.5, d: 0.22, color: VEST_COLOR };
const PELVIS: DummyBox = { name: 'pelvis', cx: 0, cy: 0.97, cz: 0, w: 0.34, h: 0.26, d: 0.2, color: KHAKI };
const arm = (side: -1 | 1): DummyBox => ({
  name: side < 0 ? 'left arm' : 'right arm',
  cx: side * ARM_X,
  cy: 1.26,
  cz: 0,
  w: 0.1,
  h: 0.62,
  d: 0.12,
  color: KHAKI,
});
const leg = (side: -1 | 1): DummyBox => ({
  name: side < 0 ? 'left leg' : 'right leg',
  cx: side * LEG_X,
  cy: 0.45,
  cz: 0,
  w: 0.15,
  h: 0.78,
  d: 0.17,
  color: KHAKI,
});
const boot = (side: -1 | 1): DummyBox => ({
  name: side < 0 ? 'left boot' : 'right boot',
  cx: side * LEG_X,
  cy: 0.04,
  cz: 0.04,
  w: 0.16,
  h: 0.08,
  d: 0.26,
  color: BOOT_COLOR,
});

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

/** The four zone spheres from the brief, kept verbatim (radius, height above the feet). */
const BASE_ZONES: ReadonlyArray<{ name: ZoneName; radius: number; cy: number }> = [
  { name: 'head', radius: DUMMY_HEAD.radius, cy: DUMMY_HEAD.cy },
  { name: 'upperTorso', radius: 0.22, cy: 1.35 },
  { name: 'lowerTorso', radius: 0.2, cy: 1.0 },
  { name: 'limbs', radius: 0.15, cy: 0.5 },
];

/** Hit spheres may stick out past the visible silhouette by at most this, m. */
export const MAX_OVERHANG = 0.03;
/** Coverage margin: every point of a covered face is at least this far inside some sphere, m. */
const COVER_MARGIN = 0.002;
const MAX_SPHERES_PER_AXIS = 16;

/** A face to blanket with spheres of one zone. Sphere radius is chosen per face. */
interface CoverFace {
  zone: ZoneName;
  cx: number;
  cy: number;
  w: number;
  h: number;
  radius: number;
}

/**
 * Faces the extra spheres must cover. One BASE_ZONES sphere per zone is not enough: the vest is
 * 0.46 x 0.50 m, the arms and legs are thin and long. Zones may repeat (several spheres per name).
 * The legs are covered down through the boots, to the ground.
 */
const COVER_FACES: readonly CoverFace[] = ((): CoverFace[] => {
  const legTop = leg(1).cy + leg(1).h / 2;
  const footBottom = boot(1).cy - boot(1).h / 2;
  const legWidth = leg(1).w; // the boots are 5 mm wider each side; the spheres cover them anyway
  const faces: CoverFace[] = [
    { zone: 'upperTorso', cx: VEST.cx, cy: VEST.cy, w: VEST.w, h: VEST.h, radius: 0.095 },
    { zone: 'lowerTorso', cx: PELVIS.cx, cy: PELVIS.cy, w: PELVIS.w, h: PELVIS.h, radius: 0.095 },
  ];
  for (const side of [-1, 1] as const) {
    const a = arm(side);
    faces.push({ zone: 'limbs', cx: a.cx, cy: a.cy, w: a.w, h: a.h, radius: a.w / 2 + MAX_OVERHANG });
    faces.push({
      zone: 'limbs',
      cx: side * LEG_X,
      cy: (legTop + footBottom) / 2,
      w: legWidth,
      h: legTop - footBottom,
      radius: 0.095,
    });
  }
  return faces;
})();

/**
 * Sphere centres (x, y relative to the feet, all at the body's mid depth) whose discs of radius
 * `face.radius` cover the whole face, with at most MAX_OVERHANG of overhang past its edges.
 * Smallest grid that works. Viewed along the line of sight, every point of the face is inside a disc.
 */
function coverCentres(face: CoverFace): Array<{ x: number; y: number }> {
  const { cx, cy, radius: r } = face;
  const hw = face.w / 2;
  const hh = face.h / 2;
  const insetX = Math.min(hw, r - MAX_OVERHANG);
  const insetY = Math.min(hh, r - MAX_OVERHANG);

  // Worst distance from a face point to the nearest centre along one axis, for n centres.
  const reach = (n: number, half: number, inset: number): number | null => {
    if (n === 1) return half <= r - MAX_OVERHANG + 1e-9 ? half : null; // one centre must reach both edges
    const spacing = (2 * (half - inset)) / (n - 1);
    return Math.max(inset, spacing / 2);
  };

  let best: { nx: number; ny: number } | null = null;
  for (let nx = 1; nx <= MAX_SPHERES_PER_AXIS; nx++) {
    for (let ny = 1; ny <= MAX_SPHERES_PER_AXIS; ny++) {
      const ex = reach(nx, hw, insetX);
      const ey = reach(ny, hh, insetY);
      if (ex === null || ey === null) continue;
      if (Math.hypot(ex, ey) > r - COVER_MARGIN) continue;
      if (best === null || nx * ny < best.nx * best.ny) best = { nx, ny };
    }
  }
  if (best === null) throw new Error(`no sphere cover for ${face.zone} face ${face.w} x ${face.h}`);

  const axis = (n: number, centre: number, half: number, inset: number): number[] => {
    if (n === 1) return [centre];
    const span = half - inset;
    return Array.from({ length: n }, (_, k) => centre - span + (2 * span * k) / (n - 1));
  };
  const xs = axis(best.nx, cx, hw, insetX);
  const ys = axis(best.ny, cy, hh, insetY);
  return ys.flatMap((y) => xs.map((x) => ({ x, y })));
}

/** One hit sphere in the dummy's own frame (origin at the feet). */
interface LocalSphere {
  name: ZoneName;
  x: number;
  y: number;
  radius: number;
}

/**
 * Every hit sphere of the dummy, in its own frame: the four brief spheres first (so the first
 * sphere of each zone name is the specified one), then the covering spheres.
 */
export function dummyHitSpheres(): LocalSphere[] {
  const spheres: LocalSphere[] = BASE_ZONES.map((z) => ({ name: z.name, x: 0, y: z.cy, radius: z.radius }));
  for (const face of COVER_FACES) {
    for (const c of coverCentres(face)) spheres.push({ name: face.zone, x: c.x, y: c.y, radius: face.radius });
  }
  return spheres;
}

export interface TargetDummy {
  /** Root object, origin at the feet, facing +Z (the shooter). */
  group: THREE.Group;
  /** World-space hit spheres; read by the BulletSystem. */
  hitTarget: HitTarget;
  /**
   * True from knockDown() until the dummy stands up again; the zones do not describe where the body
   * is meanwhile, so the game offers no hit target while it is down.
   */
  readonly down: boolean;
  /** Start tipping over backwards (away from the shooter) over 0.4 s. Does nothing while already down. */
  knockDown(): void;
  /** Stand it up again at once (upright, down = false), whatever state it is in. */
  reset(): void;
  /** Advance the fall animation by frameDt seconds; it resets itself RESET_DELAY s after the fall ended. */
  update(frameDt: number): void;
}

/** A ~1.8 m low-poly humanoid standing on the ground at (0, *, -range). */
export function createTargetDummy(range: number): TargetDummy {
  const groundY = terrainHeight(0, -range);
  const group = new THREE.Group();
  group.name = 'target-dummy';
  group.position.set(0, groundY, -range);

  const material = (color: number): THREE.MeshLambertMaterial =>
    new THREE.MeshLambertMaterial({ color, flatShading: true });
  const head = new THREE.Mesh(new THREE.IcosahedronGeometry(DUMMY_HEAD.radius, 1), material(KHAKI));
  head.position.set(0, DUMMY_HEAD.cy, 0);
  group.add(head);
  for (const b of DUMMY_BOXES) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(b.w, b.h, b.d), material(b.color));
    mesh.position.set(b.cx, b.cy, b.cz);
    mesh.name = b.name;
    group.add(mesh);
  }

  // Hit spheres in world space.
  const zones: HitZone[] = dummyHitSpheres().map((s) => ({
    name: s.name,
    radius: s.radius,
    center: { x: s.x, y: groundY + s.y, z: -range },
  }));
  const hitTarget: HitTarget = { id: 'dummy', zones };

  let down = false;
  let fallTime = 0;
  /** Seconds the body has been lying still since the fall finished. */
  let lyingTime = 0;

  const apply = (t: number): void => {
    const eased = t * t; // starts slow, accelerates like a falling body
    group.rotation.x = 0 - eased * (Math.PI / 2); // top swings toward -Z, away from the shooter
    group.position.y = groundY + eased * LYING_LIFT;
  };

  const reset = (): void => {
    down = false;
    fallTime = 0;
    lyingTime = 0;
    apply(0);
  };

  return {
    group,
    hitTarget,
    get down() {
      return down;
    },
    knockDown() {
      down = true;
    },
    reset,
    update(frameDt: number) {
      if (!down) return;
      let dt = Number.isFinite(frameDt) && frameDt > 0 ? frameDt : 0;
      if (fallTime < FALL_DURATION) {
        const remaining = FALL_DURATION - fallTime;
        const step = Math.min(dt, remaining);
        fallTime = step >= remaining ? FALL_DURATION : fallTime + step;
        dt -= step; // what is left of this frame counts as lying time
        apply(fallTime / FALL_DURATION);
      }
      if (fallTime >= FALL_DURATION) {
        lyingTime += dt;
        if (lyingTime >= RESET_DELAY - TIMER_EPSILON) reset();
      }
    },
  };
}
