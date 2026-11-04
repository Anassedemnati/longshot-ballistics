import * as THREE from 'three';
import type { Atmosphere, Rifle, Vec3, WindField } from '../ballistics/types';
import { createPathBuffer, nearestToCrosshair, predictPath, solveAim, spotterCall } from '../game/assistance';
import type { PredictOptions } from '../game/assistance';
import type { AimTarget } from '../game/assistance';
import type { PlayerView } from '../player/view';

// Aim assists (spec B.5): a trajectory preview line (T), the assisted-aim marker (A) and spotter calls (P).
// Every number comes from `game/assistance.ts` (the real ballistics); this file is the panel, the line in
// the scene, the diamond on screen and the keys. Only built when the mission enables assists.

export type AssistMode = 'trajectory' | 'aim' | 'spotter';

const MODES: ReadonlyArray<{ mode: AssistMode; key: string; code: string; label: string }> = [
  { mode: 'trajectory', key: 'T', code: 'KeyT', label: 'Trajectory' },
  { mode: 'aim', key: 'A', code: 'KeyA', label: 'Aim marker' },
  { mode: 'spotter', key: 'P', code: 'KeyP', label: 'Spotter' },
];

/** The line, the selected target, the solution and the spotter text are refreshed this often, s of game time. */
export const ASSIST_INTERVAL_S = 0.1;
/** The drawn line is flown with 5 ms steps (the solver keeps the bullets' 1 ms): a refresh costs a few ms, not ten, and the difference is millimetres. */
const LINE_DT_S = 0.005;
/** Every n-th integration step becomes a vertex of the line (one per 10 ms: a point about every 8 m at speed). */
const LINE_SAMPLE_EVERY = 2;
/**
 * The line starts this far from the eye, m: the bore sits 4 cm below the eye, so the first metres of the path would
 * be drawn as a stick hanging down from the crosshair (4 cm below at 0.1 m is 22 degrees under the view axis).
 */
const LINE_START_M = 8;
/** Vertices the line can hold: 6 s of flight at one per 10 ms, plus the first and the last. */
const LINE_CAPACITY = 700;
const LINE_COLOR = 0x7debdc;
/** Size of the dot drawn on every vertex of the line, device px. */
const DOT_SIZE_PX = 3;
/** In the scope the marker is only shown inside the lens (radius = this share of the shorter screen side). */
const LENS_RADIUS_FRACTION = 0.46;
/** The marker needs the solved direction at least this far in front of the view axis (cosine), to rule out "behind". */
const MIN_FRONT_COS = 0.01;
/** The marker's style is only rewritten when it has moved this far, px (below that nobody sees the move). */
const MARKER_STEP_PX = 0.5;

export interface AssistsOptions {
  /** Where the panel and the marker go (document.body). */
  parent: HTMLElement;
  scene: THREE.Scene;
  /** The shooter's view: the camera and where it looks. */
  view: Pick<PlayerView, 'camera' | 'forwardInto' | 'upInto' | 'isScoped'>;
  eye: Vec3;
  rifle: Rifle;
  atmo: Atmosphere;
  wind: WindField;
  /** Zero elevation of the rifle, rad (`findZeroElevation`). */
  zero: number;
  groundHeight: (x: number, z: number) => number;
  /** The targets still standing, with the point to hit on each; read at every refresh. */
  targets: () => AimTarget[];
  /** Called once, the first time any assist is switched on. */
  onUsed: () => void;
  /** True while the player is ducked behind cover: the spotter text and the aim marker are hidden then (the line is under the mask). */
  covered?: () => boolean;
}

/** Whether a key press belongs to a text field (typing there must not toggle assists). */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target.isContentEditable;
}

function el(parent: HTMLElement, tag: string, className: string, text = ''): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  parent.appendChild(node);
  return node;
}

/**
 * The assists: a panel with the three toggles, keys T / A / P, the trajectory line (cut where it meets the
 * terrain), the ◇ marker at the screen position of the direction that hits the selected target, and the spotter
 * text. The selected target is the one still standing nearest the crosshair by angle.
 */
export class Assists {
  private readonly opts: AssistsOptions;
  private readonly modes: Record<AssistMode, boolean> = { trajectory: false, aim: false, spotter: false };
  private readonly buttons = new Map<AssistMode, HTMLButtonElement>();
  private readonly panel: HTMLElement;
  private readonly spotter: HTMLElement;
  private readonly marker: HTMLElement;
  private readonly line: THREE.Line;
  /** A dot on every vertex: where vertices crowd together (far out) they make the line thicker than the 1 px a GL line can be. */
  private readonly dots: THREE.Points;
  private readonly positions = new Float32Array(LINE_CAPACITY * 3);
  private readonly ndc = new THREE.Vector3();
  /** Scratch for the per-frame view direction and the 10 Hz refresh: no vector is made per frame. */
  private readonly fwd: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly upDir: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly pathBuffer = createPathBuffer(LINE_CAPACITY);
  private readonly pathOptions: PredictOptions;
  /** Solutions per target (targets stand still, the eye and the wind are fixed): solved once, reused. */
  private readonly solutions = new Map<string, { point: Vec3; dir: Vec3 | null }>();
  private used = false;
  private disposed = false;
  private timer = 0;
  private refreshDue = false;
  /** The view direction the line was last flown for (valid when `lineKnown`): a still view needs no new flight. */
  private readonly lineFor: Vec3 = { x: 0, y: 0, z: 0 };
  private lineKnown = false;
  /** Where the marker's style was last written, px (NaN: not shown, write it at once). */
  private markerX = Number.NaN;
  private markerY = Number.NaN;
  /** The player is ducked: spotter text and marker are hidden whatever the toggles say. */
  private coverHidden = false;
  /** The direction that hits the selected target; null with none or no solution. */
  private solved: Vec3 | null = null;
  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
    const entry = MODES.find((m) => m.code === e.code);
    if (entry) this.toggle(entry.mode);
  };

  constructor(opts: AssistsOptions) {
    this.opts = opts;
    this.pathOptions = { groundHeight: opts.groundHeight, sampleEvery: LINE_SAMPLE_EVERY, dt: LINE_DT_S, buffer: this.pathBuffer };

    this.panel = el(opts.parent, 'div', 'assist-panel');
    // The panel is clickable (the HUD is not): a press on it must not reach the document handlers that grab the pointer or fire.
    this.panel.addEventListener('mousedown', (e) => e.stopPropagation());
    el(this.panel, 'div', 'assist-title', 'AIM ASSISTS');
    const row = el(this.panel, 'div', 'assist-buttons');
    for (const { mode } of MODES) {
      const button = el(row, 'button', 'assist-button') as HTMLButtonElement;
      button.type = 'button';
      button.dataset.mode = mode;
      button.addEventListener('click', () => {
        this.toggle(mode);
        button.blur(); // the keys stay with the game
      });
      this.buttons.set(mode, button);
      this.paintButton(mode);
    }
    this.spotter = el(this.panel, 'p', 'assist-spotter');
    this.spotter.hidden = true;

    this.marker = el(opts.parent, 'div', 'aim-marker', '◇');
    this.marker.hidden = true;
    this.marker.title = 'Put your crosshair on this diamond';

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geometry.setDrawRange(0, 0);
    this.line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: LINE_COLOR }));
    this.dots = new THREE.Points(geometry, new THREE.PointsMaterial({ color: LINE_COLOR, size: DOT_SIZE_PX, sizeAttenuation: false }));
    for (const o of [this.line, this.dots]) {
      o.frustumCulled = false; // the vertices move every refresh and the bounding sphere is never computed
      o.visible = false;
      opts.scene.add(o);
    }

    window.addEventListener('keydown', this.onKey);
  }

  /** Whether an assist is on right now. */
  isOn(mode: AssistMode): boolean {
    return this.modes[mode];
  }

  toggle(mode: AssistMode): void {
    this.modes[mode] = !this.modes[mode];
    this.paintButton(mode);
    if (this.modes[mode] && !this.used) {
      this.used = true;
      this.opts.onUsed();
    }
    this.line.visible = this.dots.visible = this.modes.trajectory;
    this.lineKnown = false;
    this.spotter.hidden = !this.modes.spotter || this.coverHidden;
    if (!this.modes.aim) this.hideMarker();
    this.refreshDue = true; // show the new assist at once, not up to 0.1 s later
  }

  /** Once per frame, after the view has turned: refresh at ~10 Hz, and keep the marker on its point every frame. */
  update(dt: number): void {
    if (this.disposed) return;
    const covered = this.opts.covered?.() ?? false;
    if (covered !== this.coverHidden) {
      this.coverHidden = covered;
      this.spotter.hidden = !this.modes.spotter || covered;
      if (covered) this.hideMarker();
    }
    if (!this.modes.trajectory && !this.modes.aim && !this.modes.spotter) return;
    this.timer += dt;
    if (this.refreshDue || this.timer >= ASSIST_INTERVAL_S) {
      this.timer = 0;
      this.refreshDue = false;
      this.refresh();
    }
    if (this.modes.aim) this.placeMarker();
  }

  /** Take the panel, the marker and the line away and stop listening to keys (the results screen replaces them). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('keydown', this.onKey);
    this.panel.remove();
    this.marker.remove();
    this.opts.scene.remove(this.line, this.dots);
    this.line.geometry.dispose(); // shared with the dots
    (this.line.material as THREE.Material).dispose();
    (this.dots.material as THREE.Material).dispose();
  }

  private paintButton(mode: AssistMode): void {
    const entry = MODES.find((m) => m.mode === mode);
    const button = this.buttons.get(mode);
    if (!entry || !button) return;
    const on = this.modes[mode];
    button.textContent = `${entry.key} · ${entry.label} ${on ? 'ON' : 'OFF'}`;
    button.setAttribute('aria-pressed', String(on));
  }

  /** The direction that hits `target` (cached while the target stands still: a soldier on the move or the walking HVT is solved again). */
  private solutionFor(target: AimTarget): Vec3 | null {
    const cached = this.solutions.get(target.id);
    const p = target.point;
    if (cached && cached.point.x === p.x && cached.point.y === p.y && cached.point.z === p.z) return cached.dir;
    const { eye, rifle, atmo, wind, zero } = this.opts;
    const dir = solveAim(eye, p, rifle, atmo, wind, zero);
    // A copy: the target's point is often a live object that moves with the body, and the cache must notice when it does.
    this.solutions.set(target.id, { point: { x: p.x, y: p.y, z: p.z }, dir });
    return dir;
  }

  private refresh(): void {
    const { view, eye, rifle, atmo, wind, zero } = this.opts;
    const forward = view.forwardInto(this.fwd);
    const up = view.upInto(this.upDir);

    const known = this.lineFor;
    if (this.modes.trajectory && !(this.lineKnown && known.x === forward.x && known.y === forward.y && known.z === forward.z)) {
      known.x = forward.x;
      known.y = forward.y;
      known.z = forward.z;
      this.lineKnown = true;
      const path = predictPath(eye, forward, up, rifle, atmo, wind, zero, this.pathOptions);
      let n = 0;
      for (let i = 0; i < path.count; i++) {
        const p = path.points[i];
        if (n >= LINE_CAPACITY || Math.hypot(p.x - eye.x, p.z - eye.z) < LINE_START_M) continue;
        this.positions[n * 3] = p.x;
        this.positions[n * 3 + 1] = p.y;
        this.positions[n * 3 + 2] = p.z;
        n++;
      }
      this.line.geometry.setDrawRange(0, n);
      (this.line.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    }

    if (this.modes.aim || this.modes.spotter) {
      const target = nearestToCrosshair(eye, forward, this.opts.targets());
      this.solved = target ? this.solutionFor(target) : null;
      if (this.modes.spotter) {
        const text = target
          ? `Target ${Math.round(Math.hypot(target.point.x - eye.x, target.point.z - eye.z))} m · ${spotterCall(forward, up, this.solved)}`
          : 'No target standing';
        if (this.spotter.textContent !== text) this.spotter.textContent = text;
      }
    }
  }

  private hideMarker(): void {
    this.marker.hidden = true;
    this.markerX = Number.NaN; // shown again: write the position at once
  }

  /**
   * The diamond sits where the solved direction appears on screen; hidden when that is behind the view, off screen,
   * outside the scope's lens, or while the player is ducked. Its style is rewritten only when it moved half a pixel.
   */
  private placeMarker(): void {
    const { view, eye } = this.opts;
    const dir = this.solved;
    const f = view.forwardInto(this.fwd);
    if (this.coverHidden || !dir || dir.x * f.x + dir.y * f.y + dir.z * f.z < MIN_FRONT_COS) {
      this.hideMarker();
      return;
    }
    view.camera.updateMatrixWorld();
    this.ndc.set(eye.x + dir.x, eye.y + dir.y, eye.z + dir.z).project(view.camera);
    const w = window.innerWidth;
    const h = window.innerHeight;
    const outside =
      Math.abs(this.ndc.x) > 1 ||
      Math.abs(this.ndc.y) > 1 ||
      (view.isScoped && Math.hypot((this.ndc.x * w) / 2, (this.ndc.y * h) / 2) > Math.min(w, h) * LENS_RADIUS_FRACTION);
    if (outside) {
      this.hideMarker();
      return;
    }
    const x = ((this.ndc.x + 1) * w) / 2;
    const y = ((1 - this.ndc.y) * h) / 2;
    if (!(Math.abs(x - this.markerX) < MARKER_STEP_PX && Math.abs(y - this.markerY) < MARKER_STEP_PX)) {
      this.markerX = x;
      this.markerY = y;
      this.marker.style.left = `${x.toFixed(1)}px`;
      this.marker.style.top = `${y.toFixed(1)}px`;
    }
    this.marker.hidden = false;
  }
}
