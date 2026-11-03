import * as THREE from 'three';
import type { Vec3 } from '../ballistics/types';

// The wound a bullet leaves: a small dark-red mist where it goes in, a wider spray with a few droplets where it comes out. One pooled
// `THREE.Points` with preallocated buffers (spawning and updating allocate nothing; the draw is skipped while nothing is alive), with
// its own tiny shader so each particle has its own size in metres and its own alpha: a point's size has to follow the camera's field
// of view (through an 8-25x scope a 30 cm puff must be 30 cm), which PointsMaterial's size attenuation does not do.

/** Ring buffer size: the oldest particle is recycled when a burst finds none free. */
const MAX_PARTICLES = 384;
const GRAVITY = 9.80665;
/** However far away, a particle is drawn at least this many pixels wide (a wound is still a cue at 800 m). */
const MIN_PIXELS = 2.5;

// Linear RGB: venous dark red for the mist, nearly black red for the droplets.
const MIST = [0.16, 0.006, 0.007] as const;
const DROPLET = [0.1, 0.003, 0.004] as const;

const VERTEX = /* glsl */ `
  attribute float aSize;
  attribute vec4 aColor;
  uniform float uHeight;
  varying vec4 vColor;
  void main() {
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4( position, 1.0 );
    gl_Position = projectionMatrix * mv;
    float px = aSize * uHeight * 0.5 * projectionMatrix[ 1 ][ 1 ] / max( 0.1, -mv.z );
    gl_PointSize = clamp( px, ${MIN_PIXELS.toFixed(1)}, 300.0 );
  }
`;
const FRAGMENT = /* glsl */ `
  varying vec4 vColor;
  void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot( c, c );
    if ( r2 > 1.0 ) discard;
    float soft = 1.0 - r2;
    gl_FragColor = vec4( vColor.rgb, vColor.a * soft * soft );
  }
`;

export class BloodSystem {
  readonly group = new THREE.Group();
  private readonly positions = new Float32Array(MAX_PARTICLES * 3);
  private readonly colors = new Float32Array(MAX_PARTICLES * 4);
  private readonly sizes = new Float32Array(MAX_PARTICLES);
  private readonly velocities = new Float32Array(MAX_PARTICLES * 3);
  private readonly ages = new Float32Array(MAX_PARTICLES);
  /** Lifetime of each particle, s; 0 marks a free slot. */
  private readonly lifetimes = new Float32Array(MAX_PARTICLES);
  private readonly size0 = new Float32Array(MAX_PARTICLES);
  private readonly size1 = new Float32Array(MAX_PARTICLES);
  private readonly alpha0 = new Float32Array(MAX_PARTICLES);
  private readonly gravity = new Float32Array(MAX_PARTICLES);
  /** Share of its velocity a particle loses per second (a mist cloud hangs in the air; a droplet flies). */
  private readonly drag = new Float32Array(MAX_PARTICLES);
  private readonly positionAttribute: THREE.BufferAttribute;
  private readonly colorAttribute: THREE.BufferAttribute;
  private readonly sizeAttribute: THREE.BufferAttribute;
  private readonly points: THREE.Points;
  private readonly material: THREE.ShaderMaterial;
  private next = 0;
  private alive = 0;
  private disposed = false;
  // Scratch for the cone basis (no allocation per shot).
  private readonly u = new THREE.Vector3();
  private readonly v = new THREE.Vector3();
  private readonly axis = new THREE.Vector3();
  private readonly cone = new THREE.Vector3();
  private readonly drawSize = new THREE.Vector2();

  constructor(private readonly rng: () => number = Math.random) {
    this.positionAttribute = new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage);
    this.colorAttribute = new THREE.BufferAttribute(this.colors, 4).setUsage(THREE.DynamicDrawUsage);
    this.sizeAttribute = new THREE.BufferAttribute(this.sizes, 1).setUsage(THREE.DynamicDrawUsage);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', this.positionAttribute);
    geometry.setAttribute('aColor', this.colorAttribute);
    geometry.setAttribute('aSize', this.sizeAttribute);
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: { uHeight: { value: 720 } },
      transparent: true,
      depthWrite: false,
      fog: false, // haze would swallow a wound at 800 m
    });
    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false; // the buffer is rewritten every frame; its bounding sphere is never valid
    this.points.visible = false;
    this.points.name = 'blood';
    this.points.onBeforeRender = (renderer) => {
      renderer.getDrawingBufferSize(this.drawSize);
      this.material.uniforms.uHeight.value = this.drawSize.y;
    };
    this.group.add(this.points);
  }

  /** Particles alive now (the tests and the debug overlay read it). */
  get count(): number {
    return this.alive;
  }

  /** The bullet (unit direction `dir`) goes in at `point`: a small puff of mist thrown back toward the shooter, and a few fine droplets. */
  spawnEntry(point: Vec3, dir: Vec3): void {
    if (this.disposed) return;
    this.basis(dir);
    for (let n = 0; n < 8; n++) {
      // Mostly back along the bullet's line, a wide scatter around it.
      this.emit(point, this.inCone(-1, 0.9, 0.5 + this.rng() * 1.5), 0.09 + this.rng() * 0.05, 0.28 + this.rng() * 0.12, 0.35 + this.rng() * 0.2, 0.75, 0, 3, MIST);
    }
    for (let n = 0; n < 5; n++) {
      this.emit(point, this.inCone(-1, 1.2, 1.2 + this.rng() * 2.2), 0.02, 0.015, 0.3 + this.rng() * 0.2, 0.85, 1, 0.3, DROPLET);
    }
    this.flush();
  }

  /** The bullet comes out at `point` going along the unit vector `dir`: a wider cone of mist and a few droplets that fall. */
  spawnExit(point: Vec3, dir: Vec3): void {
    if (this.disposed) return;
    this.basis(dir);
    for (let n = 0; n < 18; n++) {
      this.emit(point, this.inCone(1, 0.75, 1.5 + this.rng() * 4.5), 0.13 + this.rng() * 0.07, 0.5 + this.rng() * 0.2, 0.55 + this.rng() * 0.45, 0.7, 0, 2.4, MIST);
    }
    for (let n = 0; n < 12; n++) {
      this.emit(point, this.inCone(1, 0.8, 2 + this.rng() * 6.5), 0.04, 0.025, 0.5 + this.rng() * 0.4, 0.95, 1, 0.2, DROPLET);
    }
    this.flush();
  }

  /** A unit vector in the cone of half-angle `spread` rad about `side` x the bullet direction, scaled by `speed` (written into the scratch `axis`). */
  private inCone(side: 1 | -1, spread: number, speed: number): THREE.Vector3 {
    const theta = Math.acos(1 - this.rng() * (1 - Math.cos(spread)));
    const phi = this.rng() * Math.PI * 2;
    const s = Math.sin(theta);
    const out = this.cone.copy(this.axis).multiplyScalar(side * Math.cos(theta));
    out.addScaledVector(this.u, s * Math.cos(phi)).addScaledVector(this.v, s * Math.sin(phi));
    return out.multiplyScalar(speed);
  }

  /** The cone basis: `axis` is `dir`, `u` and `v` complete it. */
  private basis(dir: Vec3): void {
    this.axis.set(dir.x, dir.y, dir.z).normalize();
    const helper = Math.abs(this.axis.y) < 0.9 ? this.v.set(0, 1, 0) : this.v.set(1, 0, 0);
    this.u.crossVectors(this.axis, helper).normalize();
    this.v.crossVectors(this.axis, this.u);
  }

  private emit(
    p: Vec3,
    vel: THREE.Vector3,
    s0: number,
    s1: number,
    life: number,
    alpha: number,
    gravity: number,
    drag: number,
    color: readonly [number, number, number],
  ): void {
    const i = this.next;
    this.next = (this.next + 1) % MAX_PARTICLES;
    if (this.lifetimes[i] === 0) this.alive++;
    const k = i * 3;
    this.positions[k] = p.x + (this.rng() - 0.5) * 0.04;
    this.positions[k + 1] = p.y + (this.rng() - 0.5) * 0.04;
    this.positions[k + 2] = p.z + (this.rng() - 0.5) * 0.04;
    this.velocities[k] = vel.x;
    this.velocities[k + 1] = vel.y;
    this.velocities[k + 2] = vel.z;
    this.ages[i] = 0;
    this.lifetimes[i] = life;
    this.size0[i] = s0;
    this.size1[i] = s1;
    this.alpha0[i] = alpha;
    this.gravity[i] = gravity * GRAVITY;
    this.drag[i] = drag;
    this.sizes[i] = s0;
    const c = i * 4;
    this.colors[c] = color[0];
    this.colors[c + 1] = color[1];
    this.colors[c + 2] = color[2];
    this.colors[c + 3] = alpha;
  }

  private flush(): void {
    this.points.visible = this.alive > 0;
    this.positionAttribute.needsUpdate = true;
    this.colorAttribute.needsUpdate = true;
    this.sizeAttribute.needsUpdate = true;
  }

  /** Advance every particle by frameDt seconds. */
  update(frameDt: number): void {
    if (this.disposed || this.alive === 0 || !Number.isFinite(frameDt) || frameDt <= 0) return;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const life = this.lifetimes[i];
      if (life === 0) continue;
      const k = i * 3;
      const age = this.ages[i] + frameDt;
      if (age >= life) {
        this.lifetimes[i] = 0;
        this.alive--;
        this.colors[i * 4 + 3] = 0;
        this.sizes[i] = 0;
        continue;
      }
      this.ages[i] = age;
      const t = age / life;
      const keep = Math.max(0, 1 - this.drag[i] * frameDt);
      this.velocities[k] *= keep;
      this.velocities[k + 1] = this.velocities[k + 1] * keep - this.gravity[i] * frameDt;
      this.velocities[k + 2] *= keep;
      this.positions[k] += this.velocities[k] * frameDt;
      this.positions[k + 1] += this.velocities[k + 1] * frameDt;
      this.positions[k + 2] += this.velocities[k + 2] * frameDt;
      this.sizes[i] = this.size0[i] + (this.size1[i] - this.size0[i]) * Math.sqrt(t);
      const fade = 1 - t;
      this.colors[i * 4 + 3] = this.alpha0[i] * fade * fade;
    }
    this.flush();
  }

  /** Free the geometry and material and empty the group (the owner calls this when the mission is torn down). Safe to repeat; spawn and update do nothing afterwards. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.points.geometry.dispose();
    this.material.dispose();
    this.group.clear();
  }
}
