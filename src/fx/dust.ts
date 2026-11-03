import * as THREE from 'three';
import type { Vec3 } from '../ballistics/types';
import { makeBlobTexture } from './blob';

/** A puff is this many overlapping sprites. */
const SPRITES_PER_PUFF = 10;
/** The cloud fades out over this long, s. */
const PUFF_LIFETIME = 1.5;
/** Cloud radius at spawn, m: a ~1.5 m cloud once the sprites spread. */
const SPREAD = 0.45;
const PUFF_COLOR = 0xeedcb8;

interface Particle {
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  velocity: THREE.Vector3;
  startSize: number;
  endSize: number;
}

interface Puff {
  age: number;
  particles: Particle[];
}

/** Dust puffs kicked up by bullets that hit the ground. */
export class DustSystem {
  readonly group = new THREE.Group();
  private readonly texture: THREE.Texture = makeBlobTexture();
  private readonly puffs: Puff[] = [];

  /** Start a puff at a world position (the ground impact point); `scale` shrinks it (a bullet that came through a body and landed at its feet raises only a small one). */
  spawn(point: Vec3, scale = 1): void {
    const particles: Particle[] = [];
    for (let i = 0; i < SPRITES_PER_PUFF; i++) {
      const material = new THREE.SpriteMaterial({
        map: this.texture,
        color: PUFF_COLOR,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        fog: false, // haze would swallow a puff at 1.5 km; keep it readable
      });
      const sprite = new THREE.Sprite(material);
      const angle = Math.random() * Math.PI * 2;
      const dist = Math.random() * SPREAD * scale;
      sprite.position.set(
        point.x + Math.cos(angle) * dist,
        point.y + (0.15 + Math.random() * 0.6) * scale,
        point.z + Math.sin(angle) * dist,
      );
      const startSize = (0.7 + Math.random() * 0.5) * scale;
      sprite.scale.setScalar(startSize);
      this.group.add(sprite);
      particles.push({
        sprite,
        material,
        velocity: new THREE.Vector3(
          Math.cos(angle) * 0.25 * Math.random(),
          0.35 + Math.random() * 0.45,
          Math.sin(angle) * 0.25 * Math.random(),
        ),
        startSize,
        endSize: startSize * (1.6 + Math.random() * 0.8),
      });
    }
    this.puffs.push({ age: 0, particles });
  }

  /** Advance every puff by frameDt seconds and drop the finished ones. */
  update(frameDt: number): void {
    if (!Number.isFinite(frameDt) || frameDt <= 0) return;
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const puff = this.puffs[i];
      puff.age += frameDt;
      const t = Math.min(1, puff.age / PUFF_LIFETIME);
      for (const p of puff.particles) {
        p.sprite.position.addScaledVector(p.velocity, frameDt);
        p.sprite.scale.setScalar(p.startSize + (p.endSize - p.startSize) * Math.sqrt(t));
        p.material.opacity = 0.9 * (1 - t) * (1 - t);
      }
      if (t >= 1) {
        for (const p of puff.particles) {
          this.group.remove(p.sprite);
          p.material.dispose();
        }
        this.puffs.splice(i, 1);
      }
    }
  }
}
