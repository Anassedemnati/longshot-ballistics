import * as THREE from 'three';
import type { Vec3 } from '../ballistics/types';
import { makeBlobTexture } from './blob';

/** How long a spark lives, s (each one draws its own lifetime up to this). */
export const SPARK_LIFETIME = 0.3;
const MIN_LIFETIME = 0.18;
/** A hit throws this many sparks. */
const SPARKS_PER_HIT = 16;
/** Ring buffer size: the oldest spark is recycled when a burst finds none free. */
const MAX_SPARKS = 192;
const MIN_SPEED = 2;
const MAX_SPEED = 7;
const GRAVITY = 9.80665;
/** On-screen size of one spark, px: sparks must stay visible at 1500 m, so the size ignores distance. */
const POINT_SIZE_PX = 4;
/** Bright warm start colour (linear RGB, added on top of whatever is behind). */
const COLOR = { r: 1, g: 0.78, b: 0.4 };

/**
 * Sparks thrown by a bullet that hits metal: a few short-lived bright points that fly out and fall.
 * One `THREE.Points` with preallocated buffers: spawning and updating allocate nothing. A dead spark is
 * black, which draws nothing under additive blending.
 */
export class SparkSystem {
  readonly group = new THREE.Group();
  private readonly positions = new Float32Array(MAX_SPARKS * 3);
  private readonly colors = new Float32Array(MAX_SPARKS * 3);
  private readonly velocities = new Float32Array(MAX_SPARKS * 3);
  private readonly ages = new Float32Array(MAX_SPARKS);
  /** Lifetime of each spark, s; 0 marks a free slot. */
  private readonly lifetimes = new Float32Array(MAX_SPARKS);
  private readonly positionAttribute: THREE.BufferAttribute;
  private readonly colorAttribute: THREE.BufferAttribute;
  private readonly points: THREE.Points;
  private readonly material: THREE.PointsMaterial;
  private readonly texture: THREE.Texture;
  private next = 0;
  private alive = 0;
  private disposed = false;

  constructor(private readonly rng: () => number = Math.random) {
    this.positionAttribute = new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage);
    this.colorAttribute = new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', this.positionAttribute);
    geometry.setAttribute('color', this.colorAttribute);
    this.texture = makeBlobTexture();
    const material = new THREE.PointsMaterial({
      size: POINT_SIZE_PX,
      sizeAttenuation: false,
      map: this.texture,
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false, // haze would swallow a spark at 1.5 km
    });
    this.material = material;
    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false; // the buffer is rewritten every frame; its bounding sphere is never valid
    this.points.name = 'sparks';
    this.group.add(this.points);
  }

  /** Throw a burst of sparks from a world position (the impact point). */
  spawn(p: Vec3): void {
    if (this.disposed) return;
    const rng = this.rng;
    for (let n = 0; n < SPARKS_PER_HIT; n++) {
      const i = this.next;
      this.next = (this.next + 1) % MAX_SPARKS;
      if (this.lifetimes[i] === 0) this.alive++;
      // Mostly outward and up, like a ricochet fan.
      const azimuth = rng() * Math.PI * 2;
      const lift = 0.15 + rng() * 0.85;
      const flat = Math.sqrt(1 - lift * lift);
      const speed = MIN_SPEED + rng() * (MAX_SPEED - MIN_SPEED);
      const k = i * 3;
      this.positions[k] = p.x;
      this.positions[k + 1] = p.y;
      this.positions[k + 2] = p.z;
      this.velocities[k] = Math.cos(azimuth) * flat * speed;
      this.velocities[k + 1] = lift * speed;
      this.velocities[k + 2] = Math.sin(azimuth) * flat * speed;
      this.ages[i] = 0;
      this.lifetimes[i] = MIN_LIFETIME + rng() * (SPARK_LIFETIME - MIN_LIFETIME);
      this.colors[k] = COLOR.r;
      this.colors[k + 1] = COLOR.g;
      this.colors[k + 2] = COLOR.b;
    }
    this.positionAttribute.needsUpdate = true;
    this.colorAttribute.needsUpdate = true;
  }

  /** Advance every spark by frameDt seconds. */
  update(frameDt: number): void {
    if (this.disposed || this.alive === 0 || !Number.isFinite(frameDt) || frameDt <= 0) return;
    for (let i = 0; i < MAX_SPARKS; i++) {
      const life = this.lifetimes[i];
      if (life === 0) continue;
      const k = i * 3;
      const age = this.ages[i] + frameDt;
      if (age >= life) {
        this.lifetimes[i] = 0;
        this.alive--;
        this.colors[k] = 0;
        this.colors[k + 1] = 0;
        this.colors[k + 2] = 0;
        continue;
      }
      this.ages[i] = age;
      this.velocities[k + 1] -= GRAVITY * frameDt;
      this.positions[k] += this.velocities[k] * frameDt;
      this.positions[k + 1] += this.velocities[k + 1] * frameDt;
      this.positions[k + 2] += this.velocities[k + 2] * frameDt;
      const fade = 1 - age / life;
      const glow = fade * fade;
      this.colors[k] = COLOR.r * glow;
      this.colors[k + 1] = COLOR.g * glow;
      this.colors[k + 2] = COLOR.b * glow;
    }
    this.positionAttribute.needsUpdate = true;
    this.colorAttribute.needsUpdate = true;
  }

  /** Free the geometry, material and texture and empty the group (the owner calls this when the mission is torn down). Safe to repeat; spawn and update do nothing afterwards. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.points.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
    this.group.clear();
  }
}
