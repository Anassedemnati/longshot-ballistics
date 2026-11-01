import * as THREE from 'three';
import type { Vec3 } from '../ballistics/types';
import { NAKED_VFOV_RAD, magnificationToVfov } from '../game/aim';
import { drawReticle } from './reticle';

export const MAG_MIN = 4;
export const MAG_MAX = 20;
/** Zoom factor per wheel notch. */
export const MAG_STEP = 1.25;
/** Look sensitivity at 1x, rad per mouse px; divided by the magnification while scoped. */
export const BASE_SENSITIVITY = 0.0016;

/** The scope picture fills this fraction of the shorter screen side. */
const LENS_DIAMETER_FRACTION = 0.92;

const NEAR = 0.1;
const FAR = 100000;

/** Black mask with a round hole, plus the reticle clipped to that hole. DOM only. */
class ScopeOverlay {
  private readonly root = document.createElement('div');
  private readonly lens = document.createElement('div');
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D | null;

  constructor(parent: HTMLElement) {
    this.root.className = 'scope-overlay';
    this.root.hidden = true;
    this.lens.className = 'scope-lens';
    this.canvas.className = 'scope-reticle';
    this.root.append(this.lens, this.canvas);
    parent.appendChild(this.root);
    this.ctx = this.canvas.getContext('2d');
  }

  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
  }

  /** Lay out for a viewport of width x height CSS px and redraw the reticle for `vfovRad`. */
  redraw(width: number, height: number, vfovRad: number): void {
    const diameter = Math.min(width, height) * LENS_DIAMETER_FRACTION;
    this.lens.style.width = `${diameter}px`;
    this.lens.style.height = `${diameter}px`;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.canvas.style.clipPath = `circle(${diameter / 2}px at 50% 50%)`;
    if (this.ctx) drawReticle(this.ctx, width, height, vfovRad, window.devicePixelRatio || 1);
  }
}

/**
 * The shooter's eye: a camera pinned to one spot that looks around, with a toggleable scope
 * (4x-20x). Look angles come from the InputState; this owns the field of view and the overlay.
 */
export class PlayerView {
  readonly camera: THREE.PerspectiveCamera;
  private readonly overlay: ScopeOverlay;
  private scoped = false;
  private mag = MAG_MIN;
  private width: number;
  private height: number;

  constructor(overlayParent: HTMLElement, eye: Vec3, width: number, height: number) {
    this.width = width;
    this.height = height;
    this.camera = new THREE.PerspectiveCamera(60, width / height, NEAR, FAR);
    this.camera.rotation.order = 'YXZ'; // yaw about world Y, then pitch: no roll
    this.camera.position.set(eye.x, eye.y, eye.z);
    this.overlay = new ScopeOverlay(overlayParent);
    this.applyFov();
  }

  get isScoped(): boolean {
    return this.scoped;
  }

  /** Scope magnification, or 1 with the naked eye. */
  get magnification(): number {
    return this.scoped ? this.mag : 1;
  }

  /** Current vertical field of view, rad. */
  get vfov(): number {
    return this.scoped ? magnificationToVfov(this.mag) : NAKED_VFOV_RAD;
  }

  /** Mouse look sensitivity now, rad per px. */
  get sensitivity(): number {
    return BASE_SENSITIVITY / this.magnification;
  }

  toggleScope(): void {
    this.scoped = !this.scoped;
    this.overlay.setVisible(this.scoped);
    this.applyFov();
  }

  /** Zoom by wheel notches: positive zooms out, negative in. Only while scoped. */
  zoom(notches: number): void {
    if (!this.scoped || notches === 0) return;
    const next = this.mag * Math.pow(MAG_STEP, -notches);
    this.mag = Math.min(MAG_MAX, Math.max(MAG_MIN, next));
    this.applyFov();
  }

  look(yaw: number, pitch: number): void {
    this.camera.rotation.set(pitch, yaw, 0, 'YXZ');
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.camera.aspect = width / height;
    this.applyFov();
  }

  /** Unit vector the camera is looking along. */
  forward(): Vec3 {
    const v = new THREE.Vector3();
    this.camera.getWorldDirection(v);
    return { x: v.x, y: v.y, z: v.z };
  }

  /** Unit vector pointing up out of the top of the view. */
  up(): Vec3 {
    const v = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
    return { x: v.x, y: v.y, z: v.z };
  }

  private applyFov(): void {
    this.camera.fov = (this.vfov * 180) / Math.PI;
    this.camera.updateProjectionMatrix();
    if (this.scoped) this.overlay.redraw(this.width, this.height, this.vfov);
  }
}
