import * as THREE from 'three';
import type { Vec3 } from '../ballistics/types';
import type { HitTarget, HitZone, Obstacle } from '../game/hit';
import { SmokeColumn } from '../fx/smoke';
import type { VehicleTargetPlacement } from '../mission/layout';
import { toWorldBox, vehicleTargetBoxes, vehicleTargetColliders } from '../mission/props';
import type { LocalBox } from '../mission/props';
import type { ThemeId } from '../mission/themes';
import { createPropMesh } from './props';

// A vehicle the player must disable by hitting its engine. The mesh is the prop mesh; the body boxes
// are solid metal obstacles; the engine block is NOT an obstacle but a cloud of 'engine' hit spheres
// that blankets its front, its two sides and its top, edges and corners included.

/** Engine hit spheres may stick out past the engine box by at most this, m (the same 3 cm as the dummy). */
export const ENGINE_OVERHANG = 0.03;
/** Coverage margin, m: every covered point is at least this far inside some sphere. */
const COVER_MARGIN = 0.002;
/** Face spheres cover a face up to this far from its edges; the edge spheres take over from there to the edge itself, m. */
const EDGE_INSET = 0.03;
/** Broad-phase sphere margin, m: a grazing hit must never be rejected. */
const BOUNDS_MARGIN = 0.05;

/** A sphere size and how far its centre sits inside each box face it is placed against, m. */
interface Tier {
  radius: number;
  inset: number;
}

// Three sizes of sphere, each with radius = inset + ENGINE_OVERHANG so it pokes out of the box by exactly 3 cm
// through every face it sits against:
//  - face spheres (inset 8 cm) tile the faces: a face point is at least hypot(inset, a, b) from the nearest
//    centre, a and b being its in-plane offsets (at most half the spacing, or inset - EDGE_INSET next to an edge);
//  - edge spheres (inset 5 cm from BOTH faces of an edge) reach the edge line itself (inset * sqrt(2) <= reach)
//    and the 3 cm bands beside it;
//  - corner spheres (inset 3.5 cm from all three faces) reach the corner point (inset * sqrt(3) <= reach).
export const FACE_TIER: Tier = { radius: 0.11, inset: 0.08 };
export const EDGE_TIER: Tier = { radius: 0.08, inset: 0.05 };
export const CORNER_TIER: Tier = { radius: 0.065, inset: 0.035 };
/** Kept for callers that only need a typical engine sphere size. */
export const ENGINE_ZONE_RADIUS = FACE_TIER.radius;

const reachOf = (t: Tier): number => t.radius - COVER_MARGIN;
for (const t of [FACE_TIER, EDGE_TIER, CORNER_TIER]) {
  if (Math.abs(t.radius - t.inset - ENGINE_OVERHANG) > 1e-12) throw new Error('vehicleTarget: a sphere tier overhangs by more than the allowed 3 cm');
}
if (Math.hypot(FACE_TIER.inset, FACE_TIER.inset - EDGE_INSET, FACE_TIER.inset - EDGE_INSET) > reachOf(FACE_TIER)) {
  throw new Error('vehicleTarget: face spheres cannot cover the faces up to the edge inset');
}
if (Math.SQRT2 * EDGE_TIER.inset > reachOf(EDGE_TIER)) throw new Error('vehicleTarget: edge spheres cannot reach the edge line');
if (Math.sqrt(3) * CORNER_TIER.inset > reachOf(CORNER_TIER)) throw new Error('vehicleTarget: corner spheres cannot reach the corner');

/** Largest spacing at which a lattice of face spheres still covers a face, m. */
const FACE_SPACING = 2 * Math.sqrt((reachOf(FACE_TIER) ** 2 - FACE_TIER.inset ** 2) / 2);
/** Largest spacing of edge spheres along an edge that still covers the edge line and the bands beside it (worst case: on the line itself), m. */
const EDGE_SPACING = 2 * Math.sqrt(reachOf(EDGE_TIER) ** 2 - 2 * EDGE_TIER.inset ** 2);

/** Sphere centres along one axis, evenly spaced (at most `spacing` apart), both extremes `inset` inside the box ends. */
function axis(half: number, inset: number, spacing: number): number[] {
  const span = 2 * (half - inset);
  const n = Math.max(2, Math.ceil(span / spacing - 1e-9) + 1);
  return Array.from({ length: n }, (_, k) => -(half - inset) + (span * k) / (n - 1));
}

/** A hit sphere of an engine block: centre relative to the box centre, and its radius. */
export interface EngineSphere extends Vec3 {
  radius: number;
}

/** Faces that get spheres: the front (+Z), both sides (+-X), the top (+Y). The back faces the cab / hull, the bottom the ground. */
const covered = (axisName: 'x' | 'y' | 'z', sign: number): boolean => axisName === 'x' || sign > 0;
const AXES = ['x', 'y', 'z'] as const;

const lattices = new Map<LocalBox, EngineSphere[]>();

/**
 * The hit spheres of an engine box, relative to its centre: a shell lattice of face spheres over the front,
 * the two sides and the top, edge spheres along every box edge that borders one of those faces (all but
 * the back-bottom edge), and a corner sphere at each of the eight corners. Cached per engine box.
 * A segment reaching the back or the bottom crosses a body obstacle or the terrain first.
 */
export function engineSphereOffsets(engine: LocalBox): EngineSphere[] {
  let out = lattices.get(engine);
  if (!out) {
    const h = engine.halfSize;
    out = [];
    // Faces.
    const xs = axis(h.x, FACE_TIER.inset, FACE_SPACING);
    const ys = axis(h.y, FACE_TIER.inset, FACE_SPACING);
    const zs = axis(h.z, FACE_TIER.inset, FACE_SPACING);
    for (let ix = 0; ix < xs.length; ix++) {
      for (let iy = 0; iy < ys.length; iy++) {
        for (let iz = 0; iz < zs.length; iz++) {
          if (ix === 0 || ix === xs.length - 1 || iz === zs.length - 1 || iy === ys.length - 1) {
            out.push({ x: xs[ix], y: ys[iy], z: zs[iz], radius: FACE_TIER.radius });
          }
        }
      }
    }
    // Edges: for each axis w, the four edges parallel to it.
    for (const w of AXES) {
      const [u, t] = AXES.filter((a) => a !== w);
      const along = axis(h[w], EDGE_TIER.inset, EDGE_SPACING);
      for (const su of [-1, 1]) {
        for (const st of [-1, 1]) {
          if (!covered(u, su) && !covered(t, st)) continue;
          for (const a of along) {
            const p = { x: 0, y: 0, z: 0, radius: EDGE_TIER.radius };
            p[u] = su * (h[u] - EDGE_TIER.inset);
            p[t] = st * (h[t] - EDGE_TIER.inset);
            p[w] = a;
            out.push(p);
          }
        }
      }
    }
    // Corners.
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        for (const sz of [-1, 1]) {
          out.push({
            x: sx * (h.x - CORNER_TIER.inset),
            y: sy * (h.y - CORNER_TIER.inset),
            z: sz * (h.z - CORNER_TIER.inset),
            radius: CORNER_TIER.radius,
          });
        }
      }
    }
    lattices.set(engine, out);
  }
  return out;
}

export interface VehicleTarget {
  /** The mesh (at the vehicle's position and yaw); the smoke column joins it when the vehicle is disabled. */
  group: THREE.Group;
  /** 'engine' spheres covering the engine block, with broad-phase bounds. Stays after disable(): the caller decides whether to offer it. */
  hitTarget: HitTarget;
  /** The body boxes (metal), the engine block excluded. */
  obstacles: Obstacle[];
  readonly disabled: boolean;
  /** Knock the engine out: the bonnet chars and a smoke column rises (idempotent). */
  disable(): void;
  /** Advance the smoke by frameDt seconds. */
  update(frameDt: number): void;
  /**
   * Free what this vehicle target owns: the smoke column's sprite materials and texture, and the smoke
   * group in the mesh. The shared geometry and materials of the prop meshes are never disposed. Safe to call
   * twice and before disable(); afterwards disable() still flips `disabled` but makes no smoke. The caller
   * removes `group` from its scene.
   */
  dispose(): void;
}

/** Shared charred bonnet. */
let burnt: THREE.MeshLambertMaterial | null = null;
function burntMaterial(): THREE.MeshLambertMaterial {
  burnt ??= new THREE.MeshLambertMaterial({ color: 0x1d1a17, flatShading: true });
  return burnt;
}

export function createVehicleTarget(
  v: VehicleTargetPlacement,
  groundY: number,
  theme: ThemeId,
  opts: { wind?: Vec3; rng?: () => number } = {},
): VehicleTarget {
  const { engine } = vehicleTargetBoxes(v.kind);
  const group = createPropMesh({ id: v.id, kind: v.kind, x: v.x, z: v.z, yaw: v.yaw }, groundY, theme);
  const engineMesh = group.children.find((c) => c.userData.part === 'engine') as THREE.Mesh | undefined;
  if (!engineMesh) throw new Error(`vehicleTarget: ${v.kind} has no engine mesh`);

  const { body, engineCenter } = vehicleTargetColliders(v, groundY);

  const zones: HitZone[] = engineSphereOffsets(engine).map((o) => ({
    name: 'engine',
    radius: o.radius,
    center: toWorldBox(
      {
        center: { x: engine.center.x + o.x, y: engine.center.y + o.y, z: engine.center.z + o.z },
        halfSize: { x: 0, y: 0, z: 0 },
        part: 'engine',
      },
      v.x,
      v.z,
      v.yaw,
      groundY,
    ).center,
  }));
  let boundsRadius = 0;
  for (const z of zones) {
    const d = Math.hypot(z.center.x - engineCenter.x, z.center.y - engineCenter.y, z.center.z - engineCenter.z);
    boundsRadius = Math.max(boundsRadius, d + z.radius);
  }
  const hitTarget: HitTarget = {
    id: v.id,
    zones,
    bounds: { center: { x: engineCenter.x, y: engineCenter.y, z: engineCenter.z }, radius: boundsRadius + BOUNDS_MARGIN },
  };

  let disabled = false;
  let disposed = false;
  let smoke: SmokeColumn | null = null;
  let anchor: THREE.Group | null = null;

  return {
    group,
    hitTarget,
    obstacles: body,
    get disabled() {
      return disabled;
    },
    disable() {
      if (disabled) return;
      disabled = true;
      engineMesh.material = burntMaterial();
      if (disposed) return;
      smoke = new SmokeColumn({ wind: opts.wind, rng: opts.rng });
      // The anchor undoes the vehicle's yaw so the smoke's axes (and the wind drift) are the world's.
      anchor = new THREE.Group();
      anchor.name = 'smoke-anchor';
      anchor.position.set(engine.center.x, engine.center.y + engine.halfSize.y, engine.center.z);
      anchor.rotation.y = -v.yaw;
      anchor.add(smoke.group);
      group.add(anchor);
    },
    update(frameDt: number) {
      smoke?.update(frameDt);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      smoke?.dispose();
      smoke = null;
      anchor?.removeFromParent();
      anchor = null;
    },
  };
}
