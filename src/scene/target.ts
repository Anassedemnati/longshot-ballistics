import * as THREE from 'three';
import type { HitTarget, HitZone } from '../game/hit';
import { terrainHeight } from './terrainHeight';

const KHAKI = 0x70623f;
const VEST = 0x3f3a26;
const BOOTS = 0x2b251a;

/** Time to tip over backwards, s. */
const FALL_DURATION = 0.4;
/** After falling the body lies on its back; this lifts it so it rests on the sand, m. */
const LYING_LIFT = 0.1;

export interface TargetDummy {
  /** Root object, origin at the feet, facing +Z (the shooter). */
  group: THREE.Group;
  /** World-space hit spheres; read by the BulletSystem. */
  hitTarget: HitTarget;
  /** True once knockDown() has been called; the zones no longer describe where the body is. */
  readonly down: boolean;
  /** Start tipping over backwards (away from the shooter) over 0.4 s. */
  knockDown(): void;
  /** Advance the fall animation by frameDt seconds. */
  update(frameDt: number): void;
}

function part(
  geometry: THREE.BufferGeometry,
  color: number,
  x: number,
  y: number,
  z = 0,
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ color, flatShading: true }));
  mesh.position.set(x, y, z);
  return mesh;
}

/** A ~1.8 m low-poly humanoid standing on the ground at (0, *, -range). */
export function createTargetDummy(range: number): TargetDummy {
  const groundY = terrainHeight(0, -range);
  const group = new THREE.Group();
  group.name = 'target-dummy';
  group.position.set(0, groundY, -range);

  const box = (w: number, h: number, d: number): THREE.BoxGeometry => new THREE.BoxGeometry(w, h, d);
  group.add(part(new THREE.IcosahedronGeometry(0.12, 1), KHAKI, 0, 1.65)); // head
  group.add(part(box(0.08, 0.1, 0.08), KHAKI, 0, 1.54)); // neck
  group.add(part(box(0.46, 0.5, 0.22), VEST, 0, 1.35)); // upper torso
  group.add(part(box(0.34, 0.26, 0.2), KHAKI, 0, 0.97)); // lower torso
  for (const side of [-1, 1]) {
    group.add(part(box(0.1, 0.62, 0.12), KHAKI, side * 0.27, 1.26)); // arm
    group.add(part(box(0.15, 0.78, 0.17), KHAKI, side * 0.1, 0.45)); // leg
    group.add(part(box(0.16, 0.08, 0.26), BOOTS, side * 0.1, 0.04, 0.04)); // boot
  }

  // Hit spheres in world space (height above the dummy's feet).
  const zone = (name: HitZone['name'], radius: number, height: number): HitZone => ({
    name,
    radius,
    center: { x: 0, y: groundY + height, z: -range },
  });
  const hitTarget: HitTarget = {
    id: 'dummy',
    zones: [
      zone('head', 0.12, 1.65),
      zone('upperTorso', 0.22, 1.35),
      zone('lowerTorso', 0.2, 1.0),
      zone('limbs', 0.15, 0.5),
    ],
  };

  let down = false;
  let fallTime = 0;

  const apply = (t: number): void => {
    const eased = t * t; // starts slow, accelerates like a falling body
    group.rotation.x = -eased * (Math.PI / 2); // top swings toward -Z, away from the shooter
    group.position.y = groundY + eased * LYING_LIFT;
  };

  return {
    group,
    hitTarget,
    get down() {
      return down;
    },
    knockDown() {
      down = true;
    },
    update(frameDt: number) {
      if (!down || fallTime >= FALL_DURATION) return;
      if (Number.isFinite(frameDt) && frameDt > 0) fallTime = Math.min(FALL_DURATION, fallTime + frameDt);
      apply(fallTime / FALL_DURATION);
    },
  };
}
