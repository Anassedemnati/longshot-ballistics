import * as THREE from 'three';
import type { Vec3 } from '../ballistics/types';
import { BloodSystem } from '../fx/blood';
import { DustSystem } from '../fx/dust';
import { SparkSystem } from '../fx/sparks';
import type { HitTarget, Obstacle } from '../game/hit';
import { createBaseMesh } from '../scene/baseMesh';
import { createGroundDetail } from '../scene/detail';
import { createNest } from '../scene/nest';
import type { Nest } from '../scene/nest';
import { createPropMesh } from '../scene/props';
import { createShadowLight } from '../scene/shadows';
import type { ShadowLight } from '../scene/shadows';
import { createSky } from '../scene/sky';
import { createSniper } from '../scene/sniper';
import type { Sniper } from '../scene/sniper';
import { createTargetDummy } from '../scene/target';
import type { SoldierDummy } from '../scene/target';
import { DESERT_FIELD, createRocks, createTerrainMesh } from '../scene/terrain';
import { createTerrainField } from '../scene/terrainField';
import type { TerrainField } from '../scene/terrainField';
import { createVehicleTarget } from '../scene/vehicleTarget';
import type { VehicleTarget } from '../scene/vehicleTarget';
import { createVegetation, gltfModelLoader, meshGroundOf } from '../scene/vegetation';
import type { ModelLoader, Vegetation } from '../scene/vegetation';
import type { MissionConfig } from './config';
import { routeSamples } from './hvtLayout';
import type { HvtPlacement } from './hvtLayout';
import { baseColliders, generateLayout, guardPlacements, legacyLayout, soldierAimPoints } from './layout';
import type { MissionLayout, SniperPlacement, SoldierPlacement, VehicleTargetPlacement } from './layout';
import { propColliders, vehicleEngineObstacle } from './props';
import { sniperAimPoints } from './sniperDims';

// Builds the mission's world from its config: the terrain field and the layout (pure, no three.js),
// then the scene with the sky and sun shadow, terrain, ground detail, vegetation, the firing nest, props, soldiers and vehicle targets, and the lists the bullets
// and the rangefinder read (cover colliders, live hit targets). `run.ts` plays it.

/** Height of the aim point on a soldier (chest), m above the feet. */
const CHEST_HEIGHT = 1.35;

export interface Soldier {
  placement: SoldierPlacement;
  dummy: SoldierDummy;
  head: Vec3;
  upperTorso: Vec3;
  lowerTorso: Vec3;
  /** Whether its hit target is in the live list the bullets see. */
  live: boolean;
}

/** An enemy sniper lying on a roof or the ground; an extra target that shoots back (see mission/combat.ts). */
export interface EnemySniper {
  placement: SniperPlacement;
  sniper: Sniper;
  head: Vec3;
  upperTorso: Vec3;
  /** Whether its hit target is in the live list the bullets see (a downed sniper stays down). */
  live: boolean;
}

export interface Vehicle {
  placement: VehicleTargetPlacement;
  target: VehicleTarget;
  /** The engine block as a solid; joins the obstacles once the engine is disabled (the zones then stop being a target). */
  engineSolid: Obstacle;
  engineCenter: Vec3;
}

/** The HVT's party of an `hvt` mission: the officer and his bodyguards (bodies like the soldiers', not in `soldiers`), and the jeep he can drive off in. */
export interface HvtWorld {
  placement: HvtPlacement;
  officer: Soldier;
  guards: Soldier[];
  /** The jeep's mesh (left movable) and its colliders (moved with it, edited in place). */
  vehicle: THREE.Object3D | null;
  vehicleColliders: Obstacle[];
}

/** What the render quality level changes in the scene itself (see scene/quality.ts); the defaults are the full scene. */
export interface WorldQuality {
  shadowMapSize?: number;
  shadowEvery?: number;
  vegetationScale?: number;
  detailScale?: number;
}

/** The terrain and where everything stands: all that can fail while a mission is planned, before any scene exists. */
export interface MissionPlan {
  field: TerrainField;
  layout: MissionLayout;
}

export interface World extends MissionPlan {
  scene: THREE.Scene;
  /** The sun's shadow: `run.ts` re-centres its box on where the player looks, every frame. */
  shadow: ShadowLight;
  dust: DustSystem;
  sparks: SparkSystem;
  /** The wounds of the bullets that hit a soldier or a sniper. */
  blood: BloodSystem;
  /** Trees, shrubs, boulders and grass; the glTF kinds join the scene as they load. */
  vegetation: Vegetation;
  /** The sandbags and rocks round the shooter. */
  nest: Nest;
  /**
   * Everything the bullets can meet. `obstacles` and `liveTargets` are single arrays built here and
   * only edited in place (BulletSystem caches bounding radii by Obstacle identity; no per-frame rebuilds).
   */
  obstacles: Obstacle[];
  liveTargets: HitTarget[];
  soldiers: Map<string, Soldier>;
  vehicles: Map<string, Vehicle>;
  snipers: Map<string, EnemySniper>;
  /** The HVT and his bodyguards (an `hvt` mission), else null. */
  hvt: HvtWorld | null;
  /** Soldiers (the base's guards included) + vehicle targets + enemy snipers (+ the HVT and his bodyguards). */
  targetsTotal: number;
}

/** Static scenery: its matrices never change, so the renderer need not recompute them every frame. */
function freezeStatic(root: THREE.Object3D): void {
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    o.matrixAutoUpdate = false;
  });
}

/**
 * The terrain and the layout of a mission. The legacy route is the desert of seed 1, which the stage-1
 * modules already hold.
 */
export function planMission(config: MissionConfig, legacy: boolean): MissionPlan {
  const field = legacy ? DESERT_FIELD : createTerrainField(config.theme, config.seed, config.position);
  const layout = legacy ? legacyLayout(config) : generateLayout(config, field);
  return { field, layout };
}

/**
 * The scene and everything in it. `legacy`: the practice dummy stands up again after a few seconds
 * (mission soldiers stay down). `wind` is the air velocity the vehicle target's smoke column drifts with.
 */
export function buildWorld(
  config: MissionConfig,
  plan: MissionPlan,
  opts: { legacy: boolean; maxAnisotropy: number; wind: Vec3; loadModel?: ModelLoader; quality?: WorldQuality },
): World {
  const { field, layout } = plan;
  const scene = new THREE.Scene();
  const { sun, sunDirection } = createSky(scene, config.theme);
  const quality = opts.quality ?? {};
  const shadow = createShadowLight(scene, config.theme, sun, { mapSize: quality.shadowMapSize, every: quality.shadowEvery });
  // The terrain's baked wall shadows are cast for the very sun the sky and the shadow light use (the HDRI is turned to match it).
  scene.add(createTerrainMesh(field, opts.maxAnisotropy, sunDirection));
  scene.add(createRocks(field));
  // Pebbles (and grass in the valley): visual only, kept off the lanes, the props and every target, enemy snipers included.
  // The HVT's walk is kept clear like a target's lane (a sample every few metres along it).
  const walk = layout.hvt ? routeSamples(layout.hvt.route) : [];
  scene.add(createGroundDetail(field, layout, config.seed, opts.maxAnisotropy, [...layout.snipers, ...walk], quality.detailScale ?? 1).group);
  // Trees, boulders, grass and the firing nest stand on the terrain mesh's surface; both keep clear of every line of sight.
  const ground = meshGroundOf(field);
  const loadModel = opts.loadModel ?? gltfModelLoader(); // one loader, so a model both use (the boulder) is fetched once
  const vegetation = createVegetation(field, layout, config.seed, config.position, { maxAnisotropy: opts.maxAnisotropy, loadModel, ground, scale: quality.vegetationScale });
  scene.add(vegetation.group);
  const nest = createNest(field, config.seed, config.position, { maxAnisotropy: opts.maxAnisotropy, loadModel, ground });
  scene.add(nest.group);
  const dust = new DustSystem();
  scene.add(dust.group);
  const sparks = new SparkSystem();
  scene.add(sparks.group);
  const blood = new BloodSystem();
  scene.add(blood.group);

  const obstacles: Obstacle[] = [];
  let hvtVehicle: THREE.Object3D | null = null;
  let hvtVehicleColliders: Obstacle[] = [];
  for (const p of layout.props) {
    const groundY = field.height(p.x, p.z);
    const mesh = createPropMesh(p, groundY, config.theme);
    const colliders = propColliders(p, groundY);
    // The HVT's jeep may drive off with him: it is left movable.
    if (layout.hvt && p.id === layout.hvt.vehicleId) {
      hvtVehicle = mesh;
      hvtVehicleColliders = colliders;
    } else freezeStatic(mesh);
    scene.add(mesh);
    obstacles.push(...colliders);
  }

  // A military base: the whole of it in one merged mesh (a handful of draw calls; never one mesh per prop, which would be well over a hundred),
  // its colliders registered like the village props'.
  if (layout.base) {
    const mesh = createBaseMesh(layout.base.props, field.height, config.theme);
    freezeStatic(mesh);
    scene.add(mesh);
    obstacles.push(...baseColliders(layout.base, field));
  }

  const liveTargets: HitTarget[] = [];
  const soldiers = new Map<string, Soldier>();
  // The mission's soldiers, then the base's guards (the squad's cover map gives the first ones their start spots, in this order).
  for (const p of [...layout.soldiers, ...guardPlacements(layout, field)]) {
    const groundY = p.y ?? field.height(p.x, p.z);
    const ground = p.y !== undefined ? deckGround(p, field) : field.height;
    // Mission soldiers stay down; only the practice range's dummy stands up again.
    const dummy = createTargetDummy({ x: p.x, y: groundY, z: p.z }, p.yaw, p.id, { autoReset: opts.legacy, ground });
    scene.add(dummy.group);
    const aim = soldierAimPoints(p, field);
    soldiers.set(p.id, {
      placement: p,
      dummy,
      head: aim.head,
      upperTorso: aim.upperTorso,
      lowerTorso: aim.lowerTorso,
      live: true,
    });
    liveTargets.push(dummy.hitTarget);
  }

  const vehicles = new Map<string, Vehicle>();
  for (const v of layout.vehicleTargets) {
    const groundY = field.height(v.x, v.z);
    const target = createVehicleTarget(v, groundY, config.theme, { wind: opts.wind });
    scene.add(target.group);
    obstacles.push(...target.obstacles);
    const engineSolid = vehicleEngineObstacle(v, groundY);
    vehicles.set(v.id, { placement: v, target, engineSolid, engineCenter: engineSolid.box.center });
    liveTargets.push(target.hitTarget);
  }

  const snipers = new Map<string, EnemySniper>();
  for (const p of layout.snipers) {
    // On a roof he lies on its flat top; on the ground, on the terrain (where his body settles when he is shot).
    const onRoof = p.y > field.height(p.x, p.z) + 0.3;
    const sniper = createSniper({ x: p.x, y: p.y, z: p.z }, p.yaw, p.id, { ground: onRoof ? () => p.y : field.height });
    scene.add(sniper.group);
    const aim = sniperAimPoints(p);
    snipers.set(p.id, { placement: p, sniper, head: aim.head, upperTorso: aim.upperTorso, live: true });
    liveTargets.push(sniper.hitTarget);
  }
  // The HVT and his bodyguards: the officer at the start of his walk (the door), the guards round him; mission/hvtDirector.ts moves them from the first frame.
  let hvt: HvtWorld | null = null;
  if (layout.hvt) {
    const h = layout.hvt;
    const body = (id: string, x: number, z: number, variant: 'officer' | 'guard'): Soldier => {
      const placement: SoldierPlacement = { id, x, z, yaw: Math.atan2(-x, -z), range: Math.hypot(x, z), behindCover: false };
      const dummy = createTargetDummy({ x, y: field.height(x, z), z }, placement.yaw, id, { autoReset: false, ground: field.height, variant });
      scene.add(dummy.group);
      liveTargets.push(dummy.hitTarget);
      const aim = soldierAimPoints(placement, field);
      return { placement, dummy, head: aim.head, upperTorso: aim.upperTorso, lowerTorso: aim.lowerTorso, live: true };
    };
    const start = h.route[0];
    const officer = body('hvt', start.x, start.z, 'officer');
    const guards = Array.from({ length: h.guards }, (_, i) => body(`guard-${i}`, start.x + 2 * Math.sin(i * 1.7), start.z + 2 * Math.cos(i * 1.7), 'guard'));
    hvt = { placement: h, officer, guards, vehicle: hvtVehicle, vehicleColliders: hvtVehicleColliders };
  }
  const targetsTotal = soldiers.size + layout.vehicleTargets.length + layout.snipers.length + (hvt ? 1 + hvt.guards.length : 0);

  return { ...plan, scene, shadow, dust, sparks, blood, vegetation, nest, obstacles, liveTargets, soldiers, vehicles, snipers, hvt, targetsTotal };
}

/** Half side of a watch tower's deck, m (2.9 m square, see mission/baseProps.ts): a tower guard's ground is the deck within it. */
const DECK_HALF_M = 1.45;

/**
 * The ground of a guard who stands on a watch-tower deck at height `p.y`: the deck inside its square (about his start: he stands near its
 * middle and never leaves it), the terrain outside it, so a body that falls over the parapet comes to rest on the ground.
 */
function deckGround(p: SoldierPlacement, field: TerrainField): (x: number, z: number) => number {
  const deck = p.y as number;
  const c = Math.cos(p.yaw);
  const s = Math.sin(p.yaw);
  // The deck's centre: the guard stands 0.3 m ahead of it, along his facing (basePlan.ts).
  const cx = p.x - s * 0.3;
  const cz = p.z - c * 0.3;
  return (x, z) => {
    const dx = x - cx;
    const dz = z - cz;
    const lx = c * dx - s * dz;
    const lz = s * dx + c * dz;
    return Math.abs(lx) <= DECK_HALF_M && Math.abs(lz) <= DECK_HALF_M ? deck : field.height(x, z);
  };
}

/** The point to start looking at: the nearest target's chest (a soldier) or engine (a vehicle); null with no targets. */
export function nearestAimPoint(world: World): Vec3 | null {
  let nearest: { range: number; point: Vec3 } | null = null;
  for (const s of world.soldiers.values()) {
    const g = s.placement.y ?? world.field.height(s.placement.x, s.placement.z);
    if (!nearest || s.placement.range < nearest.range) {
      nearest = { range: s.placement.range, point: { x: s.placement.x, y: g + CHEST_HEIGHT, z: s.placement.z } };
    }
  }
  for (const v of world.vehicles.values()) {
    if (!nearest || v.placement.range < nearest.range) nearest = { range: v.placement.range, point: v.engineCenter };
  }
  return nearest ? nearest.point : null;
}
