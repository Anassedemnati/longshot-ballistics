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
import { JOINT_FLOATS } from '../mission/soldierPose';
import { S, SOLDIER_RIG, soldierFall } from '../mission/soldierRig';
import type { FallHit } from '../mission/soldierRig';
import type { SoldierVariant } from '../mission/soldierModel';
import { HEAD_BONE, attachSpheres, placeSpheres } from '../mission/soldierSpheres';
import { enemyMaterial } from './enemyMaterial';
import { createRagdollBody, seedOf } from './ragdollBody';
import type { FallFrom } from './ragdollBody';
import { soldierGeometry } from './soldierMesh';
import { terrainHeight } from './terrainHeight';

// The pure dummy dimensions live in mission/dummyDims.ts (the mission layout uses them too).
export { DUMMY_BOXES, DUMMY_HEAD, MAX_OVERHANG } from '../mission/dummyDims';
export type { DummyBox } from '../mission/dummyDims';

/** Time the body is given to go down and come to rest (the ragdoll usually settles sooner), s; the lying timer starts after it. */
export const FALL_DURATION = 2;
/** How long the body lies on the sand after the fall before the dummy stands up again, s. */
export const RESET_DELAY = 3;
/** Summed frame times can fall a hair short of a whole number of seconds. */
const TIMER_EPSILON = 1e-9;

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
  /**
   * Go down as a limp body (a physical ragdoll, scene/ragdollBody.ts) driven by the bullet that did it: `hit` is where it struck (world
   * space), the bullet's velocity there and the zone; without it he falls straight back, away from the shooter. Does nothing while already down.
   */
  knockDown(hit?: KnockHit): void;
  /** Stand it up again at once (upright, down = false), whatever state it is in. */
  reset(): void;
  /** Advance the fall by frameDt seconds; with autoReset (the default) it resets itself RESET_DELAY s after FALL_DURATION. */
  update(frameDt: number): void;
  /** Release what this dummy alone owns (its skeleton); the shared geometry and material stay. */
  dispose(): void;
}

/** A soldier: a target dummy that can also move (mission/squadDirector.ts drives it; one never driven stands as built). */
export interface SoldierDummy extends TargetDummy {
  /**
   * Put the body in a pose and in a place (a soldier that moves: mission/squadDirector.ts): the feet at ground level under (x, z), turned by `yaw`, the
   * bones posed from `joints` (see mission/soldierPose.ts) and every hit sphere carried to its bone. `velocity` (m/s, horizontal, world) and `jointSpeeds`
   * (m/s per joint, body frame) are what a fall now will carry on with. Never for a soldier that is down; a soldier never driven stays as built.
   */
  drive(frame: DriveFrame): void;
  /** True once `drive` has posed the body (a fall then starts from that pose). */
  readonly driven: boolean;
  /** The world position of the rifle's muzzle (written to `out`, returned). */
  muzzle(out: Vec3): Vec3;
}

/** One frame of an animated body, see `SoldierDummy.drive`. */
export interface DriveFrame {
  x: number;
  z: number;
  yaw: number;
  vx: number;
  vz: number;
  joints: ArrayLike<number>;
  jointSpeeds: ArrayLike<number> | null;
  /** Turn of the head about the vertical on top of what the chest gives it, rad. */
  headYaw: number;
}

/** The bullet that knocks a target down: world-space point and velocity, and the zone it struck. */
export interface KnockHit {
  point: Vec3;
  velocity: Vec3;
  zone: ZoneName;
}

/**
 * The ground of a body whose feet are at `origin` and which is turned by `yaw` about +Y, in the body's own frame: the world's ground height
 * under the point, minus the height of the feet (a flat ground at the feet when `world` is not given).
 */
export function localGround(world: ((x: number, z: number) => number) | undefined, origin: Vec3, yaw: number): (x: number, z: number) => number {
  if (!world) return () => 0;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return (x, z) => world(origin.x + c * x + s * z, origin.z - s * x + c * z) - origin.y;
}

/** A world-space point (or, with `translate` false, a vector) in the frame of a body at `origin` turned by `yaw` about +Y. */
export function toLocal(p: Vec3, origin: Vec3, yaw: number, translate = true): [number, number, number] {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const dx = p.x - (translate ? origin.x : 0);
  const dz = p.z - (translate ? origin.z : 0);
  return [c * dx - s * dz, p.y - (translate ? origin.y : 0), s * dx + c * dz];
}

/** The broad-phase sphere of a dummy is this much bigger than the farthest zone edge, m (a grazing hit must never be rejected). */
const BOUNDS_MARGIN = 0.05;

// All soldiers share one geometry and one material (scene/soldierMesh.ts and scene/enemyMaterial.ts; nothing changes
// them after creation, they live as long as the page). The soldier is drawn as a rifleman in uniform, helmet and kit
// (mission/soldierModel.ts), merged into ONE skinned mesh with ONE material: one draw call, as the boxy dummy was. Each
// soldier has its own bones (scene/ragdollBody.ts): standing they sit in the bind pose, shot they follow a ragdoll. The hit
// spheres above are built from the old DUMMY_BOXES and are unchanged; what is drawn covers every one of them to
// within MAX_OVERHANG (tests/scene/soldierMesh.test.ts).

let bodyMaterial: THREE.MeshStandardMaterial | null = null;

/** The soldier's geometry (one per variant) and material (shared by every dummy). */
function dummyBody(variant: SoldierVariant): { geometry: THREE.BufferGeometry; material: THREE.MeshStandardMaterial } {
  bodyMaterial ??= enemyMaterial();
  return { geometry: soldierGeometry(variant), material: bodyMaterial };
}

/**
 * A ~1.8 m rifleman standing with its feet at `position` (x, ground height, z), turned by
 * `yaw` about +Y like three.js `rotation.y`: its front (+Z) points at (sin yaw, cos yaw), so
 * `yaw = facingYaw(x, z)` makes it look at a shooter at the origin. The hit spheres turn with it.
 * `id` is the HitTarget id the bullets report. `autoReset` (default true, the stage-1 practice range)
 * makes the dummy stand up again RESET_DELAY s after its fall; a mission passes false so a downed
 * soldier stays down (reset() still works). `ground` is the world's ground height (x, z), where his body comes to rest
 * when it falls; without it the ground is flat at his feet. `variant` draws the HVT officer or one of his bodyguards on the same
 * skeleton and hit spheres (mission/soldierModel.ts).
 */
export function createTargetDummy(
  position: Vec3,
  yaw: number,
  id = 'dummy',
  opts: { autoReset?: boolean; ground?: (x: number, z: number) => number; variant?: SoldierVariant } = {},
): SoldierDummy {
  const autoReset = opts.autoReset ?? true;
  const groundY = position.y;
  const group = new THREE.Group();
  group.name = 'target-dummy';
  group.position.set(position.x, groundY, position.z);
  group.rotation.y = yaw;

  // Where the body is now: its feet and its turn. A soldier that never moves keeps what it was built with; one that is driven changes it every frame, and
  // the ragdoll's ground and the fall's frame follow.
  const cur = { x: position.x, y: groundY, z: position.z, yaw };
  const ground = (x: number, z: number): number => {
    if (!opts.ground) return 0;
    const c = Math.cos(cur.yaw);
    const s = Math.sin(cur.yaw);
    return opts.ground(cur.x + c * x + s * z, cur.z - s * x + c * z) - cur.y;
  };

  // The whole body is one mesh (see `dummyBody`): the helmet, rifle, pouches and boots are too small to be worth a draw of their own, so they ride along.
  const shared = dummyBody(opts.variant ?? 'rifleman');
  const ragdoll = createRagdollBody<FallHit>({
    rig: SOLDIER_RIG,
    geometry: shared.geometry,
    material: shared.material,
    group,
    ground,
    crumple: soldierFall,
    name: 'dummy-body',
    head: HEAD_BONE,
  });

  // Hit spheres in world space: the dummy's own (x, y) turned by the yaw about the feet.
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  const local = dummyHitSpheres();
  const zones: HitZone[] = local.map((s) => ({
    name: s.name,
    radius: s.radius,
    center: { x: position.x + cos * s.x, y: groundY + s.y, z: position.z - sin * s.x },
  }));
  // Each sphere hangs on a bone, for the days the body moves (standing at rest, the bones are where they were built and nothing changes).
  const attached = attachSpheres(local);
  // Broad phase: a sphere around the standing body that holds every zone.
  const boundsCenter = { x: position.x, y: groundY + 0.9, z: position.z };
  let boundsRadius = 0;
  for (const zone of zones) {
    const d = Math.hypot(zone.center.x - boundsCenter.x, zone.center.y - boundsCenter.y, zone.center.z - boundsCenter.z);
    boundsRadius = Math.max(boundsRadius, d + zone.radius);
  }
  const bounds = { center: boundsCenter, radius: boundsRadius + BOUNDS_MARGIN };
  const hitTarget: HitTarget = { id, zones, bounds };

  let down = false;
  let fallTime = 0;
  /** Seconds the body has been lying still since the fall finished. */
  let lyingTime = 0;
  // What `drive` last posed: the joints, how fast each was moving, and the body's own speed (world), for the fall.
  let driven = false;
  const joints = new Float64Array(JOINT_FLOATS);
  const jointSpeeds = new Float64Array(JOINT_FLOATS);
  const speed = { x: 0, z: 0 };

  const reset = (): void => {
    down = false;
    fallTime = 0;
    lyingTime = 0;
    ragdoll.reset();
  };

  return {
    group,
    hitTarget,
    get down() {
      return down;
    },
    get driven() {
      return driven;
    },
    drive(frame) {
      cur.x = frame.x;
      cur.z = frame.z;
      cur.yaw = frame.yaw;
      cur.y = opts.ground ? opts.ground(frame.x, frame.z) : groundY;
      group.position.set(cur.x, cur.y, cur.z);
      group.rotation.y = frame.yaw;
      const bones = ragdoll.animate(frame.joints, frame.headYaw);
      placeSpheres(attached, bones, cur.x, cur.y, cur.z, frame.yaw, zones);
      // The broad phase follows the pelvis; its radius reaches every zone (a bullet that grazes the edge of one must still be tested).
      const c = Math.cos(frame.yaw);
      const s = Math.sin(frame.yaw);
      const px = frame.joints[S.pelvis * 3];
      const py = frame.joints[S.pelvis * 3 + 1];
      const pz = frame.joints[S.pelvis * 3 + 2];
      boundsCenter.x = cur.x + c * px + s * pz;
      boundsCenter.y = cur.y + py;
      boundsCenter.z = cur.z - s * px + c * pz;
      let r = 0;
      for (const zone of zones) {
        r = Math.max(r, Math.hypot(zone.center.x - boundsCenter.x, zone.center.y - boundsCenter.y, zone.center.z - boundsCenter.z) + zone.radius);
      }
      bounds.radius = r + BOUNDS_MARGIN;
      for (let i = 0; i < JOINT_FLOATS; i++) {
        joints[i] = frame.joints[i];
        jointSpeeds[i] = frame.jointSpeeds ? frame.jointSpeeds[i] : 0;
      }
      speed.x = frame.vx;
      speed.z = frame.vz;
      driven = true;
    },
    muzzle(out) {
      const c = Math.cos(cur.yaw);
      const s = Math.sin(cur.yaw);
      const lx = driven ? joints[S.muzzle * 3] : SOLDIER_RIG.particles[S.muzzle].p[0];
      const ly = driven ? joints[S.muzzle * 3 + 1] : SOLDIER_RIG.particles[S.muzzle].p[1];
      const lz = driven ? joints[S.muzzle * 3 + 2] : SOLDIER_RIG.particles[S.muzzle].p[2];
      out.x = cur.x + c * lx + s * lz;
      out.y = cur.y + ly;
      out.z = cur.z - s * lx + c * lz;
      return out;
    },
    knockDown(hit?: KnockHit) {
      if (down) return;
      down = true;
      const fall: FallHit | undefined = hit && {
        point: toLocal(hit.point, cur, cur.yaw),
        velocity: toLocal(hit.velocity, cur, cur.yaw, false),
        zone: hit.zone,
      };
      // A body that was moving falls from the pose it was in, still running.
      const from: FallFrom | undefined = driven ? { pose: joints, velocities: jointSpeeds, body: toLocal({ x: speed.x, y: 0, z: speed.z }, cur, cur.yaw, false) } : undefined;
      ragdoll.fall(fall, seedOf(id, hit ? Math.round(hit.point.x * 1000 + hit.point.y * 7000 + hit.point.z * 311) : 0), from);
    },
    reset,
    dispose() {
      ragdoll.dispose();
    },
    update(frameDt: number) {
      if (!down) return;
      let dt = Number.isFinite(frameDt) && frameDt > 0 ? frameDt : 0;
      ragdoll.update(dt);
      if (fallTime < FALL_DURATION) {
        const remaining = FALL_DURATION - fallTime;
        const step = Math.min(dt, remaining);
        fallTime = step >= remaining ? FALL_DURATION : fallTime + step;
        dt -= step; // what is left of this frame counts as lying time
      }
      if (fallTime >= FALL_DURATION) {
        lyingTime += dt;
        if (autoReset && lyingTime >= RESET_DELAY - TIMER_EPSILON) reset();
      }
    },
  };
}

/** The stage-1 dummy: standing at (0, ground, -range), facing +Z (straight at the shooter). */
export function createTargetDummyAtRange(range: number): SoldierDummy {
  return createTargetDummy({ x: 0, y: terrainHeight(0, -range), z: -range }, 0, 'dummy', { ground: terrainHeight });
}
