import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/ballistics/types';
import type { ThemeId } from '../../src/mission/themes';
import {
  SHADOW_AHEAD_M,
  SHADOW_HALF_EXTENT,
  SHADOW_MAP_SIZE,
  createShadowLight,
  shadowFocus,
  snapToTexelGrid,
} from '../../src/scene/shadows';
import { rangeUnderCrosshair } from '../../src/game/rangefinder';
import { sniperAimPoints } from '../../src/mission/sniperDims';
import { SKY_LOOKS, createSky, sunDirectionOf } from '../../src/scene/sky';
import { createSniper } from '../../src/scene/sniper';
import { createTerrainField } from '../../src/scene/terrainField';

const THEMES: ThemeId[] = ['desert', 'arctic', 'valley'];
const eye: Vec3 = { x: 0, y: 12.4, z: 0 };
const ground = (x: number, z: number): number => 0.01 * x + 0.02 * z + 1; // a slope, to see the ground height used

const unit = (v: Vec3): Vec3 => {
  const l = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / l, y: v.y / l, z: v.z / l };
};

describe('shadowFocus on an enemy sniper', () => {
  it('scoped on him, the rangefinder reads his range (he is a live target), so the shadow box is centred on him', () => {
    const field = createTerrainField('desert', 1);
    const pose = { x: 12, y: 3.4, z: -300, yaw: 0 }; // lying on a roof 300 m out
    const sniper = createSniper(pose, pose.yaw, 'sniper-0');
    const aim = sniperAimPoints(pose).upperTorso;
    const forward = unit({ x: aim.x - field.shooter.x, y: aim.y - field.shooter.y, z: aim.z - field.shooter.z });
    const rangeM = rangeUnderCrosshair(field.shooter, forward, field, [], [sniper.hitTarget]);
    expect(rangeM).not.toBeNull();
    const f = shadowFocus({ scoped: true, eye: field.shooter, forward, rangeM, ground: field.height });
    // His own shadow and the roof's fall inside the 60 m box around the focus.
    expect(Math.hypot(f.x - aim.x, f.y - aim.y, f.z - aim.z)).toBeLessThan(SHADOW_HALF_EXTENT / 3);
  });
});

describe('shadowFocus', () => {
  it('scoped with a rangefinder reading: the point under the crosshair', () => {
    const forward = unit({ x: -0.1, y: -0.02, z: -1 });
    const f = shadowFocus({ scoped: true, eye, forward, rangeM: 750, ground });
    // (the helper takes the reading along `forward`, whatever its length)
    expect(f.x).toBeCloseTo(eye.x + forward.x * 750, 9);
    expect(f.y).toBeCloseTo(eye.y + forward.y * 750, 9);
    expect(f.z).toBeCloseTo(eye.z + forward.z * 750, 9);
    // an unnormalised direction gives the same point
    const g = shadowFocus({ scoped: true, eye, forward: { x: forward.x * 5, y: forward.y * 5, z: forward.z * 5 }, rangeM: 750, ground });
    expect(g.x).toBeCloseTo(f.x, 9);
    expect(g.y).toBeCloseTo(f.y, 9);
    expect(g.z).toBeCloseTo(f.z, 9);
  });

  it('naked eye: the ground 40 m ahead along the horizontal view, whatever the pitch or any old reading', () => {
    for (const pitch of [-0.4, 0, 0.3]) {
      const yaw = 0.5;
      const forward = { x: -Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(yaw) * Math.cos(pitch) };
      const f = shadowFocus({ scoped: false, eye, forward, rangeM: 900, ground });
      expect(Math.hypot(f.x - eye.x, f.z - eye.z)).toBeCloseTo(SHADOW_AHEAD_M, 9);
      expect(f.x).toBeCloseTo(-Math.sin(yaw) * SHADOW_AHEAD_M, 9);
      expect(f.z).toBeCloseTo(-Math.cos(yaw) * SHADOW_AHEAD_M, 9);
      expect(f.y).toBeCloseTo(ground(f.x, f.z), 9);
    }
  });

  it('scoped at the sky (no reading): falls back to the area ahead', () => {
    const forward = unit({ x: 0, y: 0.5, z: -1 });
    const f = shadowFocus({ scoped: true, eye, forward, rangeM: null, ground });
    expect(f).toEqual({ x: 0, y: ground(0, -SHADOW_AHEAD_M), z: -SHADOW_AHEAD_M });
  });

  it('looking straight up or down: right below the eye, never NaN', () => {
    for (const y of [-1, 1]) {
      const f = shadowFocus({ scoped: false, eye, forward: { x: 0, y, z: 0 }, rangeM: null, ground });
      expect(f).toEqual({ x: eye.x, y: ground(eye.x, eye.z), z: eye.z });
    }
  });

  it('a reading of 0 (eye in the ground) or an infinite one does not break it', () => {
    const forward = { x: 0, y: 0, z: -1 };
    expect(shadowFocus({ scoped: true, eye, forward, rangeM: 0, ground })).toEqual({ x: eye.x, y: eye.y, z: eye.z + 0 });
    const f = shadowFocus({ scoped: true, eye, forward, rangeM: Infinity, ground });
    expect(Number.isFinite(f.z)).toBe(true);
    expect(f.z).toBeCloseTo(-SHADOW_AHEAD_M, 9);
  });
});

describe('shadowFocus and snapToTexelGrid write into the object they are given (the frame loop must not allocate)', () => {
  it('shadowFocus fills `out`, returns it, and gives the same point as without one, in every branch', () => {
    const out: Vec3 = { x: 99, y: 99, z: 99 };
    const cases = [
      { scoped: true, eye, forward: unit({ x: -0.1, y: -0.02, z: -1 }), rangeM: 750, ground },
      { scoped: false, eye, forward: unit({ x: 0.3, y: 0.1, z: -1 }), rangeM: 750, ground },
      { scoped: true, eye, forward: unit({ x: 0, y: 0.5, z: -1 }), rangeM: null, ground },
      { scoped: false, eye, forward: { x: 0, y: 1, z: 0 }, rangeM: null, ground },
    ];
    for (const input of cases) {
      expect(shadowFocus(input, out)).toBe(out);
      expect(out).toEqual(shadowFocus(input));
    }
  });

  it('snapToTexelGrid fills `out`, returns it, and may snap a point in place', () => {
    const texel = (2 * SHADOW_HALF_EXTENT) / SHADOW_MAP_SIZE;
    const sun = unit({ x: -0.8, y: 0.31, z: 0.46 });
    const p = { x: 12.3, y: 0.4, z: -840.77 };
    const out: Vec3 = { x: 0, y: 0, z: 0 };
    expect(snapToTexelGrid(p, sun, texel, out)).toBe(out);
    expect(out).toEqual(snapToTexelGrid(p, sun, texel));
    const inPlace = { ...p };
    expect(snapToTexelGrid(inPlace, sun, texel, inPlace)).toBe(inPlace);
    expect(inPlace).toEqual(out);
    const overhead = { x: 1.23, y: 4, z: 5.67 };
    expect(snapToTexelGrid(overhead, { x: 0, y: 1, z: 0 }, texel, out)).toBe(out);
    expect(out).toEqual(overhead);
  });
});

describe('snapToTexelGrid', () => {
  const texel = (2 * SHADOW_HALF_EXTENT) / SHADOW_MAP_SIZE;
  const sun = unit({ x: -0.8, y: 0.31, z: 0.46 });
  const sx = sun.x;
  const sz = sun.z;
  const rl = Math.hypot(sz, sx);
  const right: Vec3 = { x: sz / rl, y: 0, z: -sx / rl };
  const up: Vec3 = { x: sun.y * right.z, y: sun.z * right.x - sun.x * right.z, z: -sun.y * right.x };
  const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

  it('moves a point by less than one texel and lands on the light-space grid, depth unchanged', () => {
    for (const p of [{ x: 12.3, y: 0.4, z: -840.77 }, { x: -3.1, y: 11.9, z: -40 }, { x: 0, y: 0, z: 0 }]) {
      const s = snapToTexelGrid(p, sun, texel);
      expect(Math.hypot(s.x - p.x, s.y - p.y, s.z - p.z)).toBeLessThan(texel * Math.SQRT2);
      const a = dot(s, right) / texel;
      const b = dot(s, up) / texel;
      expect(Math.abs(a - Math.round(a))).toBeLessThan(1e-6);
      expect(Math.abs(b - Math.round(b))).toBeLessThan(1e-6);
      expect(dot(s, sun)).toBeCloseTo(dot(p, sun), 9);
    }
  });

  it('is idempotent, and a focus that moves less than a texel often does not move the box at all', () => {
    const p = { x: 101.234, y: 3.3, z: -555.5 };
    const s = snapToTexelGrid(p, sun, texel);
    const again = snapToTexelGrid(s, sun, texel);
    expect(again.x).toBeCloseTo(s.x, 9);
    expect(again.y).toBeCloseTo(s.y, 9);
    expect(again.z).toBeCloseTo(s.z, 9);
    const nudged = snapToTexelGrid({ x: s.x + right.x * texel * 0.2, y: s.y, z: s.z + right.z * texel * 0.2 }, sun, texel);
    expect(nudged.x).toBeCloseTo(s.x, 9);
    expect(nudged.z).toBeCloseTo(s.z, 9);
  });

  it('survives a sun straight overhead', () => {
    const s = snapToTexelGrid({ x: 1.23, y: 4, z: 5.67 }, { x: 0, y: 1, z: 0 }, texel);
    expect(s).toEqual({ x: 1.23, y: 4, z: 5.67 });
  });
});

describe('createShadowLight', () => {
  for (const theme of THEMES) {
    it(`${theme}: the sun casts a 2048 x 2048 shadow from the theme's sun direction and follows the focus`, () => {
      const scene = new THREE.Scene();
      const { sun } = createSky(scene, theme);
      const lights = () => scene.children.filter((c) => (c as THREE.DirectionalLight).isDirectionalLight);
      expect(lights()).toHaveLength(1);
      const shadow = createShadowLight(scene, theme, sun);
      expect(lights()).toHaveLength(1); // the same light: the scene is not lit twice
      expect(shadow.light).toBe(sun);
      expect(sun.castShadow).toBe(true);
      expect(sun.shadow.mapSize.x).toBe(2048);
      expect(sun.shadow.mapSize.y).toBe(2048);
      const cam = sun.shadow.camera;
      expect(cam.right - cam.left).toBe(60);
      expect(cam.top - cam.bottom).toBe(60);
      expect(scene.children).toContain(sun.target);

      shadow.update({ x: 10, y: 1, z: -700 });
      const dir = sunDirectionOf(SKY_LOOKS[theme]);
      const offset = sun.position.clone().sub(sun.target.position);
      expect(offset.clone().normalize().distanceTo(dir)).toBeLessThan(1e-9);
      expect(Math.abs(sun.target.position.z + 700)).toBeLessThan(1);
      shadow.update({ x: -20, y: 2, z: -1200 });
      expect(Math.abs(sun.target.position.z + 1200)).toBeLessThan(1);
      expect(sun.position.clone().sub(sun.target.position).normalize().distanceTo(dir)).toBeLessThan(1e-9);
    });
  }

  it('without a sun it adds its own light', () => {
    const scene = new THREE.Scene();
    const shadow = createShadowLight(scene, 'valley');
    expect(scene.children).toContain(shadow.light);
    expect(shadow.light.castShadow).toBe(true);
  });
});
