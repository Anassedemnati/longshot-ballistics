import * as THREE from 'three';
import type { Vec3 } from '../ballistics/types';
import type { ThemeId } from '../mission/themes';
import { SKY_LOOKS, sunDirectionOf } from './sky';

// Real-time sun shadows. One directional light (the theme's sun) casts into a 2048 x 2048 map; its
// orthographic box is only 60 m wide, so it follows where the player looks: the point under the crosshair
// when scoped (the rangefinder reading), the ground ~40 m ahead otherwise. The two pure helpers below
// (the focus choice and the texel snap) are unit-tested; the terrain receives shadows but never casts them.

/** Side of the shadow map, texels. */
export const SHADOW_MAP_SIZE = 2048;
/** Half the width of the shadow box, m: shadows exist within +-30 m of the focus. */
export const SHADOW_HALF_EXTENT = 30;
/** When not scoped the shadows are focused this far ahead of the eye, m. */
export const SHADOW_AHEAD_M = 40;
/** The light sits this far from the focus along the sun direction, m. */
const LIGHT_DISTANCE = 200;
/** Depth range of the shadow camera around the focus: casters up to this far from it along the sun direction are kept, m. */
const DEPTH_HALF_RANGE = 150;

export interface ShadowFocusInput {
  /** True while looking through the scope. */
  scoped: boolean;
  eye: Vec3;
  /** View direction (any length). */
  forward: Vec3;
  /** Latest rangefinder reading along `forward`, m; null when the ray meets nothing (sky). */
  rangeM: number | null;
  /** Ground height at (x, z), m. */
  ground: (x: number, z: number) => number;
}

/**
 * The point the shadow box is centred on. Scoped with a rangefinder reading: the point under the crosshair
 * (eye + forward * range). Otherwise (naked eye, or the scope aimed at the sky): the ground
 * 40 m ahead along the horizontal part of the view direction (straight up or down: right below the eye).
 * The result is written into `out` (returned): the game calls this every frame and must not allocate.
 */
export function shadowFocus(input: ShadowFocusInput, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  const { eye, forward, rangeM } = input;
  const length = Math.hypot(forward.x, forward.y, forward.z);
  if (input.scoped && rangeM !== null && Number.isFinite(rangeM) && rangeM >= 0 && length > 1e-9) {
    const k = rangeM / length;
    out.x = eye.x + forward.x * k;
    out.y = eye.y + forward.y * k;
    out.z = eye.z + forward.z * k;
    return out;
  }
  const horizontal = Math.hypot(forward.x, forward.z);
  const reach = horizontal > 1e-9 ? SHADOW_AHEAD_M / horizontal : 0;
  const x = eye.x + forward.x * reach;
  const z = eye.z + forward.z * reach;
  out.x = x;
  out.y = input.ground(x, z);
  out.z = z;
  return out;
}

/**
 * Move `focus` to the nearest point on the shadow map's texel grid (the grid is the light's own right
 * and up axes, `texelM` metres apart), leaving its depth along the sun untouched. A shadow box that
 * only ever moves in whole texels does not make the shadow edges shimmer as the view turns.
 * The result is written into `out` (returned; it may be `focus` itself).
 */
export function snapToTexelGrid(focus: Vec3, sunDir: Vec3, texelM: number, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  const sl = Math.hypot(sunDir.x, sunDir.y, sunDir.z);
  const sx = sunDir.x / sl;
  const sy = sunDir.y / sl;
  const sz = sunDir.z / sl;
  const fx = focus.x;
  const fy = focus.y;
  const fz = focus.z;
  // The light camera looks along -s with world up (0, 1, 0): its right axis is up x s, its up axis s x right.
  let rx = sz;
  let rz = -sx;
  const rl = Math.hypot(rx, rz);
  if (!(rl > 1e-9)) {
    // sun straight overhead: no preferred right axis
    out.x = fx;
    out.y = fy;
    out.z = fz;
    return out;
  }
  rx /= rl;
  rz /= rl;
  const ux = sy * rz;
  const uy = sz * rx - sx * rz;
  const uz = -sy * rx;
  const a = fx * rx + fz * rz;
  const b = fx * ux + fy * uy + fz * uz;
  const da = Math.round(a / texelM) * texelM - a;
  const db = Math.round(b / texelM) * texelM - b;
  out.x = fx + rx * da + ux * db;
  out.y = fy + uy * db;
  out.z = fz + rz * da + uz * db;
  return out;
}

export interface ShadowLight {
  /** The shadow-casting sun. */
  light: THREE.DirectionalLight;
  /** Centre the shadow box on `focus` (a world point); call once per frame. */
  update(focus: Vec3): void;
  /** Redraw the map every `n` frames from now on (1 = every frame). */
  setEvery(n: number): void;
}

export interface ShadowOptions {
  /** Side of the map, texels (default `SHADOW_MAP_SIZE`). */
  mapSize?: number;
  /** The map is redrawn every this many frames (1 = every frame). The box moves only when the map is redrawn, so between redraws the shadows lag the view by a frame or two. */
  every?: number;
}

/**
 * Turn the scene's sun into the shadow caster: a PCF map (2048 x 2048 by default), a +-30 m box. `sun` is the light
 * `createSky` already added (so the scene is not lit twice); without one a new light with the theme's
 * sun colour and intensity is added to `scene`.
 */
export function createShadowLight(scene: THREE.Scene, theme: ThemeId, sun?: THREE.DirectionalLight, options: ShadowOptions = {}): ShadowLight {
  const mapSize = options.mapSize ?? SHADOW_MAP_SIZE;
  let every = Math.max(1, Math.floor(options.every ?? 1));
  const look = SKY_LOOKS[theme];
  const dir = sunDirectionOf(look);
  const light = sun ?? new THREE.DirectionalLight(look.sunColor, look.sunIntensity);
  if (!sun) scene.add(light);
  light.castShadow = true;
  light.shadow.mapSize.set(mapSize, mapSize);
  light.shadow.autoUpdate = every === 1;
  const cam = light.shadow.camera;
  cam.left = -SHADOW_HALF_EXTENT;
  cam.right = SHADOW_HALF_EXTENT;
  cam.top = SHADOW_HALF_EXTENT;
  cam.bottom = -SHADOW_HALF_EXTENT;
  cam.near = LIGHT_DISTANCE - DEPTH_HALF_RANGE;
  cam.far = LIGHT_DISTANCE + DEPTH_HALF_RANGE;
  cam.updateProjectionMatrix();
  light.shadow.bias = -0.0003;
  light.shadow.normalBias = 0.03;
  scene.add(light.target); // its world matrix places the box: it must be in the scene graph

  const texel = (2 * SHADOW_HALF_EXTENT) / mapSize;
  let frame = 0;
  const snapped: Vec3 = { x: 0, y: 0, z: 0 }; // reused every frame
  return {
    light,
    setEvery(n) {
      every = Math.max(1, Math.floor(n));
      light.shadow.autoUpdate = every === 1;
    },
    update(focus) {
      if (every > 1) {
        // With autoUpdate off the map is drawn on the frames asked for; the box moves only then too, so a held map is never looked up through a moved box.
        if (frame++ % every !== 0) return;
        light.shadow.needsUpdate = true;
      }
      const f = snapToTexelGrid(focus, dir, texel, snapped);
      light.target.position.set(f.x, f.y, f.z);
      light.position.set(f.x + dir.x * LIGHT_DISTANCE, f.y + dir.y * LIGHT_DISTANCE, f.z + dir.z * LIGHT_DISTANCE);
    },
  };
}
