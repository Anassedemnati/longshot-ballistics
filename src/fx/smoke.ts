import * as THREE from 'three';
import type { Vec3 } from '../ballistics/types';
import { makeBlobTexture } from './blob';

/** Sprites in one column. Each lives LIFETIME seconds, so the column gives off about COUNT / LIFETIME puffs a second. */
const COUNT = 48;
const LIFETIME_MIN = 6;
const LIFETIME_MAX = 8;
/** Rise speed, m/s: the column is ~20 m tall by the time the oldest puffs fade out. */
const RISE_MIN = 2.4;
const RISE_MAX = 3.4;
/** A puff starts this wide and swells to this wide, m (a dozen metres across the column is visible at 1.5 km). */
const SIZE_START = 1.2;
const SIZE_END = 8;
/** Puffs start within this radius of the column's foot, m. */
const FOOT_RADIUS = 0.5;
/** Share of the wind speed the smoke drifts at, and the drift cap, m/s. */
const DRIFT_SHARE = 0.6;
const DRIFT_MAX = 6;
/** Opacity at its thickest. */
const MAX_OPACITY = 0.7;
/** Fresh smoke is nearly black, old smoke grey (linear RGB). */
const DARK = { r: 0.05, g: 0.045, b: 0.04 };
const LIGHT = { r: 0.3, g: 0.29, b: 0.28 };

interface Puff {
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  /** Seconds since it was released; negative while it waits for its turn (so the column builds up). */
  age: number;
  life: number;
  rise: number;
  ox: number;
  oz: number;
}

/**
 * Smoke rising above a disabled vehicle: a ring of recycled sprites. The group is positioned at the
 * foot of the column by the owner and must not be rotated (the wind drift is in world axes).
 * No per-frame allocation. `update` is a no-op for a bad frame time.
 */
export class SmokeColumn {
  readonly group = new THREE.Group();
  private readonly puffs: Puff[] = [];
  private readonly rng: () => number;
  private readonly texture: THREE.Texture;
  private driftX = 0;
  private driftZ = 0;
  private disposed = false;

  constructor(opts: { wind?: Vec3; rng?: () => number } = {}) {
    this.rng = opts.rng ?? Math.random;
    this.group.name = 'smoke';
    if (opts.wind) this.setWind(opts.wind);
    const texture = (this.texture = makeBlobTexture());
    for (let i = 0; i < COUNT; i++) {
      const material = new THREE.SpriteMaterial({
        map: texture,
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        fog: false, // haze would swallow the column at 1.5 km; it marks the kill
      });
      const sprite = new THREE.Sprite(material);
      sprite.visible = false;
      this.group.add(sprite);
      const puff: Puff = { sprite, material, age: 0, life: 1, rise: 1, ox: 0, oz: 0 };
      this.release(puff);
      puff.age = -(i / COUNT) * LIFETIME_MIN; // stagger the first puffs
      this.puffs.push(puff);
    }
  }

  /** The wind the smoke drifts with, world m/s (the horizontal part counts). */
  setWind(wind: Vec3): void {
    const speed = Math.hypot(wind.x, wind.z);
    const k = speed > 0 ? Math.min(DRIFT_SHARE * speed, DRIFT_MAX) / speed : 0;
    this.driftX = wind.x * k;
    this.driftZ = wind.z * k;
  }

  private release(p: Puff): void {
    const rng = this.rng;
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(rng()) * FOOT_RADIUS;
    p.age = 0;
    p.life = LIFETIME_MIN + rng() * (LIFETIME_MAX - LIFETIME_MIN);
    p.rise = RISE_MIN + rng() * (RISE_MAX - RISE_MIN);
    p.ox = Math.cos(a) * r;
    p.oz = Math.sin(a) * r;
  }

  update(frameDt: number): void {
    if (this.disposed || !Number.isFinite(frameDt) || frameDt <= 0) return;
    for (const p of this.puffs) {
      p.age += frameDt;
      if (p.age >= p.life) this.release(p);
      if (p.age < 0) {
        p.sprite.visible = false;
        continue;
      }
      const t = p.age / p.life; // 0..1
      p.sprite.visible = true;
      p.sprite.position.set(p.ox + this.driftX * p.age, p.rise * p.age, p.oz + this.driftZ * p.age);
      p.sprite.scale.setScalar(SIZE_START + (SIZE_END - SIZE_START) * Math.sqrt(t));
      // Fade in over the first tenth, then thin out.
      const fadeIn = Math.min(1, t / 0.1);
      const fadeOut = (1 - t) * (1 - t);
      p.material.opacity = MAX_OPACITY * fadeIn * fadeOut;
      p.material.color.setRGB(
        DARK.r + (LIGHT.r - DARK.r) * t,
        DARK.g + (LIGHT.g - DARK.g) * t,
        DARK.b + (LIGHT.b - DARK.b) * t,
      );
    }
  }

  /** Free the sprite materials and the texture and empty the group (the owner calls this when the mission is torn down). Safe to repeat. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const p of this.puffs) p.material.dispose();
    this.texture.dispose();
    this.group.clear();
  }
}
