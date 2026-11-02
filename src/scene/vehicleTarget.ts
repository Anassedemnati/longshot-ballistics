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
// that blankets its front, its two sides and its top.

/** Engine hit spheres may stick out past the engine box by at most this, m (the same 3 cm as the dummy). */
export const ENGINE_OVERHANG = 0.03;
/** Radius of an engine hit sphere, m. */
export const ENGINE_ZONE_RADIUS = 0.11;
/** Every point of a covered face at least this far in from its edges is inside a sphere, m. */
const EDGE_INSET = 0.03;
/** Coverage margin, m. */
const COVER_MARGIN = 0.002;
/** Broad-phase sphere margin, m: a grazing hit must never be rejected. */
const BOUNDS_MARGIN = 0.05;

// A sphere on a face lattice has its centre INSET inside the face plane (so it pokes out by exactly
// ENGINE_OVERHANG). A face point is then at least hypot(INSET, a, b) from the nearest centre, where a
// and b are its in-plane offsets: at most half the lattice spacing, or INSET - EDGE_INSET next to an edge.
const INSET = ENGINE_ZONE_RADIUS - ENGINE_OVERHANG;
const REACH = ENGINE_ZONE_RADIUS - COVER_MARGIN;
if (Math.hypot(INSET, INSET - EDGE_INSET, INSET - EDGE_INSET) > REACH) {
  throw new Error('vehicleTarget: engine zone radius cannot cover the faces up to the edge inset');
}
/** Largest lattice spacing that still covers a face, m. */
const MAX_SPACING = 2 * Math.sqrt((REACH * REACH - INSET * INSET) / 2);

/** Sphere centres (relative to the engine box centre) along one lattice axis: both extremes sit INSET inside the faces. */
function axis(half: number): number[] {
  const span = 2 * (half - INSET);
  const n = Math.max(2, Math.ceil(span / MAX_SPACING - 1e-9) + 1);
  return Array.from({ length: n }, (_, k) => -(half - INSET) + (span * k) / (n - 1));
}

const lattices = new Map<LocalBox, Vec3[]>();

/**
 * Offsets from the engine box centre of the hit spheres: the shell of a regular lattice that covers the
 * front (+Z), the two sides (+-X) and the top (+Y). The back and the bottom are not covered: the back
 * faces the cab or the hull, the bottom faces the ground, and a segment reaching them crosses a body
 * obstacle or the terrain first. Cached per engine box.
 */
export function engineSphereOffsets(engine: LocalBox): Vec3[] {
  let out = lattices.get(engine);
  if (!out) {
    const xs = axis(engine.halfSize.x);
    const ys = axis(engine.halfSize.y);
    const zs = axis(engine.halfSize.z);
    out = [];
    for (let ix = 0; ix < xs.length; ix++) {
      for (let iy = 0; iy < ys.length; iy++) {
        for (let iz = 0; iz < zs.length; iz++) {
          if (ix === 0 || ix === xs.length - 1 || iz === zs.length - 1 || iy === ys.length - 1) {
            out.push({ x: xs[ix], y: ys[iy], z: zs[iz] });
          }
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
    radius: ENGINE_ZONE_RADIUS,
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
  let smoke: SmokeColumn | null = null;

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
      smoke = new SmokeColumn({ wind: opts.wind, rng: opts.rng });
      // The anchor undoes the vehicle's yaw so the smoke's axes (and the wind drift) are the world's.
      const anchor = new THREE.Group();
      anchor.name = 'smoke-anchor';
      anchor.position.set(engine.center.x, engine.center.y + engine.halfSize.y, engine.center.z);
      anchor.rotation.y = -v.yaw;
      anchor.add(smoke.group);
      group.add(anchor);
    },
    update(frameDt: number) {
      smoke?.update(frameDt);
    },
  };
}
