import * as THREE from 'three';
import type { Vec3 } from '../ballistics/types';
import { DustSystem } from '../fx/dust';
import { SparkSystem } from '../fx/sparks';
import type { HitTarget, Obstacle } from '../game/hit';
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
import type { TargetDummy } from '../scene/target';
import { DESERT_FIELD, createRocks, createTerrainMesh } from '../scene/terrain';
import { createTerrainField } from '../scene/terrainField';
import type { TerrainField } from '../scene/terrainField';
import { createVehicleTarget } from '../scene/vehicleTarget';
import type { VehicleTarget } from '../scene/vehicleTarget';
import { createVegetation, gltfModelLoader, meshGroundOf } from '../scene/vegetation';
import type { ModelLoader, Vegetation } from '../scene/vegetation';
import type { MissionConfig } from './config';
import { generateLayout, legacyLayout, soldierAimPoints } from './layout';
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
  dummy: TargetDummy;
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
  /** Soldiers + vehicle targets + enemy snipers. */
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
  opts: { legacy: boolean; maxAnisotropy: number; wind: Vec3; loadModel?: ModelLoader },
): World {
  const { field, layout } = plan;
  const scene = new THREE.Scene();
  const { sun } = createSky(scene, config.theme);
  const shadow = createShadowLight(scene, config.theme, sun);
  scene.add(createTerrainMesh(field, opts.maxAnisotropy));
  scene.add(createRocks(field));
  // Pebbles (and grass in the valley): visual only, kept off the lanes, the props and every target, enemy snipers included.
  scene.add(createGroundDetail(field, layout, config.seed, opts.maxAnisotropy, layout.snipers).group);
  // Trees, boulders, grass and the firing nest stand on the terrain mesh's surface; both keep clear of every line of sight.
  const ground = meshGroundOf(field);
  const loadModel = opts.loadModel ?? gltfModelLoader(); // one loader, so a model both use (the boulder) is fetched once
  const vegetation = createVegetation(field, layout, config.seed, config.position, { maxAnisotropy: opts.maxAnisotropy, loadModel, ground });
  scene.add(vegetation.group);
  const nest = createNest(field, config.seed, config.position, { maxAnisotropy: opts.maxAnisotropy, loadModel, ground });
  scene.add(nest.group);
  const dust = new DustSystem();
  scene.add(dust.group);
  const sparks = new SparkSystem();
  scene.add(sparks.group);

  const obstacles: Obstacle[] = [];
  for (const p of layout.props) {
    const groundY = field.height(p.x, p.z);
    const mesh = createPropMesh(p, groundY, config.theme);
    freezeStatic(mesh);
    scene.add(mesh);
    obstacles.push(...propColliders(p, groundY));
  }

  const liveTargets: HitTarget[] = [];
  const soldiers = new Map<string, Soldier>();
  for (const p of layout.soldiers) {
    const groundY = field.height(p.x, p.z);
    // Mission soldiers stay down; only the practice range's dummy stands up again.
    const dummy = createTargetDummy({ x: p.x, y: groundY, z: p.z }, p.yaw, p.id, { autoReset: opts.legacy });
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
    const sniper = createSniper({ x: p.x, y: p.y, z: p.z }, p.yaw, p.id);
    scene.add(sniper.group);
    const aim = sniperAimPoints(p);
    snipers.set(p.id, { placement: p, sniper, head: aim.head, upperTorso: aim.upperTorso, live: true });
    liveTargets.push(sniper.hitTarget);
  }
  const targetsTotal = layout.soldiers.length + layout.vehicleTargets.length + layout.snipers.length;

  return { ...plan, scene, shadow, dust, sparks, vegetation, nest, obstacles, liveTargets, soldiers, vehicles, snipers, targetsTotal };
}

/** The point to start looking at: the nearest target's chest (a soldier) or engine (a vehicle); null with no targets. */
export function nearestAimPoint(world: World): Vec3 | null {
  let nearest: { range: number; point: Vec3 } | null = null;
  for (const s of world.soldiers.values()) {
    const g = world.field.height(s.placement.x, s.placement.z);
    if (!nearest || s.placement.range < nearest.range) {
      nearest = { range: s.placement.range, point: { x: s.placement.x, y: g + CHEST_HEIGHT, z: s.placement.z } };
    }
  }
  for (const v of world.vehicles.values()) {
    if (!nearest || v.placement.range < nearest.range) nearest = { range: v.placement.range, point: v.engineCenter };
  }
  return nearest ? nearest.point : null;
}
