import * as THREE from 'three';
import { BASE_KINDS } from '../mission/baseProps';
import type { BaseKind } from '../mission/baseProps';
import { BASE_RADIUS, planBase } from '../mission/basePlan';
import type { BaseSize } from '../mission/basePlan';
import { propFootprintRadius, propBoxes } from '../mission/props';
import type { SceneryPlacement } from '../mission/props';
import { createRng } from '../mission/random';
import type { ThemeId } from '../mission/themes';
import { createBaseMesh } from '../scene/baseMesh';
import { createPropMesh } from '../scene/props';
import { createRenderer } from '../scene/renderer';
import { createShadowLight } from '../scene/shadows';
import { createSky } from '../scene/sky';

// Dev-only preview of the military base (`?basePreview=1`, loaded by main.ts on demand: not in the game's bundle
// path): a base on flat ground under the theme's sky, and a gallery of every military prop off to one side. No
// layout, no mission. `window.__preview` drives the camera for scripts/base-shots.mjs:
//   focus(kind)          a three-quarter close-up of one gallery prop
//   overview(d, h)       the base from d m in front of its gate, h m up, through a long lens
//   setMode(m)           'merged' (scene/baseMesh.ts) | 'single' (one createPropMesh per prop) | 'none'
//   calls()              draw calls of the last frame (renderer.info), after rendering one
// Query: theme=desert|arctic|valley, size=outpost|base, seed=<n>.

const GROUND: Record<ThemeId, number> = { desert: 0xc4aa7c, arctic: 0xe6eaee, valley: 0x6e7a46 };
/** The gallery stands far to the side of the base, out of the overview's long lens. */
const GALLERY = { x: -1500, z: 0, spacing: 26, perRow: 6 };

interface Preview {
  ready: boolean;
  kinds: readonly BaseKind[];
  focus(kind: BaseKind): void;
  overview(distance: number, height: number): void;
  setMode(mode: 'merged' | 'single' | 'none'): void;
  calls(): { calls: number; triangles: number };
  props: number;
  colliders: number;
}

declare global {
  interface Window {
    __preview?: Preview;
  }
}

export function startBasePreview(app: HTMLElement): void {
  const q = new URLSearchParams(window.location.search);
  const theme = (['desert', 'arctic', 'valley'].includes(q.get('theme') ?? '') ? q.get('theme') : 'desert') as ThemeId;
  const size: BaseSize = q.get('size') === 'outpost' ? 'outpost' : 'base';
  const seed = Number(q.get('seed') ?? 7) || 7;

  const renderer = createRenderer(app, { composer: false });
  const scene = new THREE.Scene();
  const { sun } = createSky(scene, theme);
  const shadow = createShadowLight(scene, theme, sun, { mapSize: 4096 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: GROUND[theme], roughness: 1 }));
  ground.receiveShadow = true;
  scene.add(ground);
  const camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.1, 5000);

  // The base at the origin, its gate facing +Z (toward the overview camera).
  const plan = planBase({ x: 0, z: 0 }, 0, size, createRng(seed));
  const flat = (): number => 0;
  const merged = createBaseMesh(plan.props, flat, theme);
  const single = new THREE.Group();
  for (const p of plan.props) single.add(createPropMesh(p, 0, theme));
  scene.add(merged, single);
  single.visible = false;

  // Gallery: every kind in a grid, facing the camera side (+Z).
  const spots = new Map<BaseKind, SceneryPlacement>();
  BASE_KINDS.forEach((kind, i) => {
    const p: SceneryPlacement = {
      id: `gallery-${kind}`,
      kind,
      x: GALLERY.x + (i % GALLERY.perRow) * GALLERY.spacing,
      z: GALLERY.z - Math.floor(i / GALLERY.perRow) * GALLERY.spacing,
      yaw: 0,
    };
    spots.set(kind, p);
    scene.add(createPropMesh(p, 0, theme));
  });

  let focusPoint = new THREE.Vector3();
  const frame = (): void => {
    shadow.update({ x: focusPoint.x, y: focusPoint.y, z: focusPoint.z });
    renderer.render(scene, camera);
  };
  const resize = (): void => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  };
  window.addEventListener('resize', resize);

  const preview: Preview = {
    ready: false,
    kinds: BASE_KINDS,
    props: plan.props.length,
    colliders: plan.props.reduce((n, p) => n + propBoxes(p.kind).length, 0),
    focus(kind) {
      const p = spots.get(kind);
      if (!p) return;
      const r = propFootprintRadius(kind);
      const top = Math.max(...propBoxes(kind).map((b) => b.center.y + b.halfSize.y));
      const target = new THREE.Vector3(p.x, top * 0.42, p.z);
      const d = Math.max(4.5, r * 1.9, top * 1.7);
      camera.fov = 35;
      camera.position.set(p.x + d * 0.62, target.y + d * 0.42, p.z + d * 0.78);
      camera.lookAt(target);
      camera.updateProjectionMatrix();
      focusPoint = target;
      frame();
    },
    overview(distance, height) {
      // A long lens framing the base's diameter (plus a margin) across the image's width.
      const halfWidth = BASE_RADIUS[size] * 1.15;
      const hfov = 2 * Math.atan(halfWidth / distance);
      camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(hfov / 2) / camera.aspect));
      camera.position.set(distance * 0.25, height, distance);
      camera.lookAt(0, 0, 0);
      camera.updateProjectionMatrix();
      focusPoint = new THREE.Vector3(0, 0, 0);
      frame();
    },
    setMode(mode) {
      merged.visible = mode === 'merged';
      single.visible = mode === 'single';
      frame();
    },
    calls() {
      frame();
      return { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
    },
  };
  // The shadow box of the game is +-30 m round the view's focus; the overview needs the whole base in it.
  const cam = shadow.light.shadow.camera;
  const extent = BASE_RADIUS[size] + 10;
  cam.left = -extent;
  cam.right = extent;
  cam.top = extent;
  cam.bottom = -extent;
  cam.updateProjectionMatrix();
  window.__preview = preview;
  preview.overview(450, 40);
  const loop = (): void => {
    frame();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  preview.ready = true;
}
