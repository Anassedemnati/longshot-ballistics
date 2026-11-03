import * as THREE from 'three';
import type { Vec3 } from '../ballistics/types';
import { makeBlobTexture } from './blob';

// The muzzle flashes of the soldiers that shoot back: a short bright flash at the rifle's muzzle for every round. A pool of sprites made once
// (a flash takes a free one, nothing is allocated while the game runs). A flash is drawn bigger the farther it is, so that at 800 m it is still a
// bright point a few pixels across with the naked eye and a clear flash through the scope, where the real one (half a metre) would be a speck.

/** How long a flash lives, s. */
export const FLASH_LIFE_S = 0.07;
const POOL = 40;
/** The flash is this many metres across per metre of distance, within these limits (m). */
const SIZE_PER_M = 0.0036;
const MIN_SIZE_M = 0.5;
const MAX_SIZE_M = 5;
const CORE_COLOR = 0xfff3d0;
const GLOW_COLOR = 0xffa23a;

interface Slot {
  core: THREE.Sprite;
  glow: THREE.Sprite;
  age: number;
  size: number;
}

export class MuzzleFlashes {
  readonly group = new THREE.Group();
  private readonly slots: Slot[] = [];
  private next = 0;
  private readonly texture: THREE.Texture = makeBlobTexture();

  constructor() {
    const make = (color: number): THREE.Sprite => {
      const material = new THREE.SpriteMaterial({
        map: this.texture,
        color,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false, // haze would swallow a flash at 1 km
      });
      const sprite = new THREE.Sprite(material);
      sprite.visible = false;
      sprite.renderOrder = 5;
      this.group.add(sprite);
      return sprite;
    };
    for (let i = 0; i < POOL; i++) this.slots.push({ core: make(CORE_COLOR), glow: make(GLOW_COLOR), age: FLASH_LIFE_S, size: 1 });
  }

  /** A flash at `point`, `distanceM` from the player's eye (it sets how big the flash is drawn). The oldest flash is recycled when none is free. */
  spawn(point: Vec3, distanceM: number): void {
    const slot = this.slots[this.next];
    this.next = (this.next + 1) % this.slots.length;
    slot.age = 0;
    slot.size = Math.min(MAX_SIZE_M, Math.max(MIN_SIZE_M, distanceM * SIZE_PER_M)) * (0.85 + Math.random() * 0.3);
    for (const sprite of [slot.core, slot.glow]) {
      sprite.position.set(point.x, point.y, point.z);
      sprite.visible = true;
    }
    this.apply(slot);
  }

  private apply(slot: Slot): void {
    const t = slot.age / FLASH_LIFE_S;
    const fade = 1 - t;
    slot.core.scale.setScalar(slot.size * (0.8 + 0.4 * fade));
    slot.glow.scale.setScalar(slot.size * (1.5 + 0.4 * t));
    (slot.core.material as THREE.SpriteMaterial).opacity = fade;
    (slot.glow.material as THREE.SpriteMaterial).opacity = 0.45 * fade;
  }

  /** Age every live flash by `dt` seconds and hide the finished ones. */
  update(dt: number): void {
    if (!(dt > 0)) return;
    for (const slot of this.slots) {
      if (slot.age >= FLASH_LIFE_S) continue;
      slot.age += dt;
      if (slot.age >= FLASH_LIFE_S) {
        slot.core.visible = false;
        slot.glow.visible = false;
      } else this.apply(slot);
    }
  }

  /** Flashes on screen right now (for the tests and the debug state). */
  get live(): number {
    let n = 0;
    for (const slot of this.slots) if (slot.age < FLASH_LIFE_S) n++;
    return n;
  }
}
