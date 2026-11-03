import * as THREE from 'three';
import type { Vec3 } from '../ballistics/types';
import type { HitTarget, HitZone, ZoneName } from '../game/hit';
import {
  DUMMY_HEAD,
  LEG_X,
  MAX_OVERHANG,
  LOWER_TORSO_CY,
  PELVIS,
  UPPER_TORSO_CY,
  VEST,
  arm,
  boot,
  leg,
} from '../mission/dummyDims';
import { enemyMaterial } from './enemyMaterial';
import { soldierGeometry } from './soldierMesh';
import { terrainHeight } from './terrainHeight';

// The pure dummy dimensions live in mission/dummyDims.ts (the mission layout uses them too).
export { DUMMY_BOXES, DUMMY_HEAD, MAX_OVERHANG } from '../mission/dummyDims';
export type { DummyBox } from '../mission/dummyDims';

/** Time to tip over backwards, s. */
export const FALL_DURATION = 0.4;
/** How long the body lies on the sand after the fall before the dummy stands up again, s. */
export const RESET_DELAY = 3;
/** Summed frame times can fall a hair short of a whole number of seconds. */
const TIMER_EPSILON = 1e-9;
/** After falling the body lies on its back; this lifts it so it rests on the sand, m. */
const LYING_LIFT = 0.1;

/** The four zone spheres from the brief, kept verbatim (radius, height above the feet). */
const BASE_ZONES: ReadonlyArray<{ name: ZoneName; radius: number; cy: number }> = [
  { name: 'head', radius: DUMMY_HEAD.radius, cy: DUMMY_HEAD.cy },
  { name: 'upperTorso', radius: 0.22, cy: UPPER_TORSO_CY },
  { name: 'lowerTorso', radius: 0.2, cy: LOWER_TORSO_CY },
  { name: 'limbs', radius: 0.15, cy: 0.5 },
];

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
  /** Advance the fall animation by frameDt seconds; with autoReset (the default) it resets itself RESET_DELAY s after the fall ended. */
  update(frameDt: number): void;
}

/** The broad-phase sphere of a dummy is this much bigger than the farthest zone edge, m (a grazing hit must never be rejected). */
const BOUNDS_MARGIN = 0.05;

// All soldiers share one geometry and one material (scene/soldierMesh.ts and scene/enemyMaterial.ts; nothing changes
// them after creation, they live as long as the page). The soldier is drawn as a rifleman in uniform, helmet and kit
// (mission/soldierModel.ts), merged into ONE mesh with ONE material: one draw call, as the boxy dummy was. The hit
// spheres above are built from the old DUMMY_BOXES and are unchanged; what is drawn covers every one of them to
// within MAX_OVERHANG (tests/scene/soldierMesh.test.ts).

let bodyMaterial: THREE.MeshStandardMaterial | null = null;

/** The soldier's geometry and material (shared by every dummy). */
function dummyBody(): { geometry: THREE.BufferGeometry; material: THREE.MeshStandardMaterial } {
  bodyMaterial ??= enemyMaterial();
  return { geometry: soldierGeometry(), material: bodyMaterial };
}

/**
 * A ~1.8 m rifleman standing with its feet at `position` (x, ground height, z), turned by
 * `yaw` about +Y like three.js `rotation.y`: its front (+Z) points at (sin yaw, cos yaw), so
 * `yaw = facingYaw(x, z)` makes it look at a shooter at the origin. The hit spheres turn with it.
 * `id` is the HitTarget id the bullets report. `autoReset` (default true, the stage-1 practice range)
 * makes the dummy stand up again RESET_DELAY s after its fall; a mission passes false so a downed
 * soldier stays down (reset() still works).
 */
export function createTargetDummy(
  position: Vec3,
  yaw: number,
  id = 'dummy',
  opts: { autoReset?: boolean } = {},
): TargetDummy {
  const autoReset = opts.autoReset ?? true;
  const groundY = position.y;
  const group = new THREE.Group();
  group.name = 'target-dummy';
  group.position.set(position.x, groundY, position.z);
  // Yaw first, then the fall about the dummy's own X axis: it tips over backwards whichever way it faces.
  group.rotation.order = 'YXZ';
  group.rotation.y = yaw;

  // The whole body is one mesh (see `dummyBody`): the helmet, rifle, pouches and boots are too small to be worth a draw of their own, so they ride along.
  const body = dummyBody();
  const mesh = new THREE.Mesh(body.geometry, body.material);
  mesh.name = 'dummy-body';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);

  // Hit spheres in world space: the dummy's own (x, y) turned by the yaw about the feet.
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const zones: HitZone[] = dummyHitSpheres().map((s) => ({
    name: s.name,
    radius: s.radius,
    center: { x: position.x + cos * s.x, y: groundY + s.y, z: position.z - sin * s.x },
  }));
  // Broad phase: a sphere around the standing body that holds every zone.
  const boundsCenter = { x: position.x, y: groundY + 0.9, z: position.z };
  let boundsRadius = 0;
  for (const zone of zones) {
    const d = Math.hypot(zone.center.x - boundsCenter.x, zone.center.y - boundsCenter.y, zone.center.z - boundsCenter.z);
    boundsRadius = Math.max(boundsRadius, d + zone.radius);
  }
  const hitTarget: HitTarget = { id, zones, bounds: { center: boundsCenter, radius: boundsRadius + BOUNDS_MARGIN } };

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
        if (autoReset && lyingTime >= RESET_DELAY - TIMER_EPSILON) reset();
      }
    },
  };
}

/** The stage-1 dummy: standing at (0, ground, -range), facing +Z (straight at the shooter). */
export function createTargetDummyAtRange(range: number): TargetDummy {
  return createTargetDummy({ x: 0, y: terrainHeight(0, -range), z: -range }, 0);
}
