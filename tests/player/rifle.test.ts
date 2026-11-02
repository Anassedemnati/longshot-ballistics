import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { BOLT_TIME_S, RELOAD_TIME_S } from '../../src/game/weapon';
import {
  BARREL_LENGTH_M,
  FirstPersonRifle,
  SUPPRESSOR_LENGTH_M,
  boltLift,
  boltSlide,
  buildRifleModel,
} from '../../src/player/rifle';

const IDS = ['308', '338'] as const;
const FRAME_S = 1 / 60;
/** The rifle may add this many draw calls (meshes) to the frame; the whole game has a 400-call budget. */
const MAX_RIFLE_MESHES = 10;

function meshes(root: THREE.Object3D): THREE.Mesh[] {
  const found: THREE.Mesh[] = [];
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) found.push(o);
  });
  return found;
}

function triangles(root: THREE.Object3D): number {
  return meshes(root).reduce((n, m) => n + (m.geometry.index?.count ?? m.geometry.attributes.position.count) / 3, 0);
}

/** Bounding box of the model's geometry in model space (no flash sprites: the builder adds none). */
function bounds(root: THREE.Object3D): THREE.Box3 {
  root.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(root);
}

describe('rifle model', () => {
  for (const id of IDS) {
    for (const suppressed of [false, true]) {
      describe(`.${id}${suppressed ? ' suppressed' : ''}`, () => {
        const { group, bolt } = buildRifleModel(id, suppressed);

        it('builds without WebGL, with real geometry', () => {
          expect(triangles(group)).toBeGreaterThan(2000);
          for (const m of meshes(group)) expect(m.geometry.attributes.position.count).toBeGreaterThan(0);
        });

        it('is merged into a handful of meshes (the draw-call budget)', () => {
          expect(meshes(group).length).toBeLessThanOrEqual(MAX_RIFLE_MESHES);
          expect(meshes(group).length).toBeGreaterThanOrEqual(5);
        });

        it('has a bolt group with a handle', () => {
          expect(group.getObjectByName('bolt')).toBe(bolt);
          expect(meshes(bolt).length).toBeGreaterThan(0);
        });

        it(`${suppressed ? 'has' : 'has no'} suppressor parts`, () => {
          const suppressor = group.getObjectByName('suppressor');
          if (suppressed) {
            expect(suppressor).toBeDefined();
            expect(meshes(suppressor as THREE.Object3D).length).toBeGreaterThan(0);
          } else {
            expect(suppressor).toBeUndefined();
          }
        });
      });
    }
  }

  it('the suppressor adds triangles and length to the muzzle', () => {
    for (const id of IDS) {
      const plain = buildRifleModel(id, false);
      const can = buildRifleModel(id, true);
      expect(triangles(can.group)).toBeGreaterThan(triangles(plain.group));
      const extra = bounds(plain.group).min.z - bounds(can.group).min.z;
      expect(extra).toBeGreaterThan(SUPPRESSOR_LENGTH_M * 0.9);
      expect(can.muzzleZ).toBeLessThan(plain.muzzleZ - SUPPRESSOR_LENGTH_M * 0.9);
    }
  });

  it('the .338 has the longer barrel', () => {
    const a = buildRifleModel('308', false);
    const b = buildRifleModel('338', false);
    expect(BARREL_LENGTH_M['338']).toBeGreaterThan(BARREL_LENGTH_M['308']);
    expect(a.muzzleZ - b.muzzleZ).toBeCloseTo(BARREL_LENGTH_M['338'] - BARREL_LENGTH_M['308'], 6);
    expect(bounds(b.group).min.z).toBeLessThan(bounds(a.group).min.z - 0.1);
  });

  it('the .308 is olive and the .338 sand', () => {
    const stockColour = (id: '308' | '338') => {
      const stock = meshes(buildRifleModel(id, false).group).find((m) => m.name === 'stock');
      return ((stock as THREE.Mesh).material as THREE.MeshStandardMaterial).color.getHex();
    };
    expect(stockColour('308')).not.toBe(stockColour('338'));
  });
});

describe('first-person rifle: muzzle flash', () => {
  it('flashes after a shot and dies out', () => {
    const rifle = new FirstPersonRifle('308', false);
    expect(rifle.flashVisible).toBe(false);
    expect(rifle.flashLightIntensity).toBe(0);
    rifle.fire();
    rifle.update(FRAME_S);
    expect(rifle.flashVisible).toBe(true);
    expect(rifle.flashLightIntensity).toBeGreaterThan(0);
    for (let i = 0; i < 12; i++) rifle.update(FRAME_S); // 0.2 s
    expect(rifle.flashVisible).toBe(false);
    expect(rifle.flashLightIntensity).toBe(0);
  });

  it('shows the first flash frame even when that frame took longer than the flash lasts', () => {
    const rifle = new FirstPersonRifle('308', false);
    rifle.fire();
    rifle.update(0.1); // a slow frame
    expect(rifle.flashVisible).toBe(true);
    rifle.update(0.1);
    expect(rifle.flashVisible).toBe(false);
  });

  it('never flashes when suppressed, and has no light', () => {
    const rifle = new FirstPersonRifle('308', true);
    for (let i = 0; i < 5; i++) {
      rifle.fire();
      rifle.update(FRAME_S);
      expect(rifle.flashVisible).toBe(false);
      expect(rifle.flashLightIntensity).toBe(0);
    }
    const lights: THREE.Light[] = [];
    rifle.scene.traverse((o) => {
      if (o instanceof THREE.PointLight) lights.push(o);
    });
    expect(lights).toEqual([]);
  });

  it('keeps its flash light inside its own scene (the world is lit by nothing of it)', () => {
    const rifle = new FirstPersonRifle('338', false);
    let found = false;
    rifle.scene.traverse((o) => {
      if (o instanceof THREE.PointLight) found = true;
    });
    expect(found).toBe(true);
  });
});

describe('first-person rifle: motion', () => {
  it('kicks back on a shot and settles again', () => {
    const rifle = new FirstPersonRifle('308');
    rifle.update(FRAME_S);
    const rest = rifle.model.position.z;
    const restPitch = rifle.model.rotation.x;
    rifle.fire();
    rifle.update(FRAME_S);
    expect(rifle.model.position.z).toBeGreaterThan(rest + 0.02);
    expect(rifle.model.rotation.x).toBeGreaterThan(restPitch + 0.02); // the muzzle climbs
    for (let i = 0; i < 90; i++) rifle.update(FRAME_S);
    expect(rifle.model.position.z).toBeCloseTo(rest, 3);
    expect(rifle.model.rotation.x).toBeCloseTo(restPitch, 3);
  });

  it('dips during a reload and is back when it is done', () => {
    const rifle = new FirstPersonRifle('308');
    rifle.update(FRAME_S);
    const rest = rifle.model.position.y;
    rifle.reload(RELOAD_TIME_S);
    let lowest = rest;
    const frames = Math.round(RELOAD_TIME_S / FRAME_S);
    for (let i = 0; i < frames / 2; i++) {
      rifle.update(FRAME_S);
      lowest = Math.min(lowest, rifle.model.position.y);
    }
    expect(lowest).toBeLessThan(rest - 0.1);
    for (let i = 0; i < frames; i++) rifle.update(FRAME_S);
    expect(rifle.model.position.y).toBeCloseTo(rest, 2);
  });

  it('works the bolt after a shot with a round left, and not after the last one', () => {
    const cycled = new FirstPersonRifle('308');
    const bolt = cycled.model.getObjectByName('bolt') as THREE.Object3D;
    const restZ = bolt.position.z;
    cycled.fire(true);
    let peakLift = 0;
    let peakSlide = 0;
    for (let t = 0; t < BOLT_TIME_S + 0.1; t += FRAME_S) {
      cycled.update(FRAME_S);
      peakLift = Math.max(peakLift, bolt.rotation.z);
      peakSlide = Math.max(peakSlide, bolt.position.z - restZ);
    }
    expect(peakLift).toBeGreaterThan(0.5);
    expect(peakSlide).toBeGreaterThan(0.02);
    expect(bolt.rotation.z).toBeCloseTo(0, 6);
    expect(bolt.position.z).toBeCloseTo(restZ, 6);

    const last = new FirstPersonRifle('308');
    const lastBolt = last.model.getObjectByName('bolt') as THREE.Object3D;
    last.fire(false);
    for (let i = 0; i < 30; i++) last.update(FRAME_S);
    expect(lastBolt.rotation.z).toBe(0);
  });

  it('the bolt curves start and end at rest, and rise in between', () => {
    expect(boltLift(0)).toBe(0);
    expect(boltLift(1)).toBeCloseTo(0, 9);
    expect(boltSlide(0)).toBe(0);
    expect(boltSlide(1)).toBeCloseTo(0, 9);
    expect(boltLift(0.5)).toBeGreaterThan(0.5);
    expect(boltSlide(0.5)).toBeGreaterThan(0.02);
  });

  it('ignores bad frame times', () => {
    const rifle = new FirstPersonRifle('308');
    rifle.fire();
    rifle.update(Number.NaN);
    rifle.update(-1);
    expect(Number.isFinite(rifle.model.position.z)).toBe(true);
    expect(Number.isFinite(rifle.model.rotation.x)).toBe(true);
  });
});

describe('first-person rifle: camera', () => {
  it('follows the window aspect', () => {
    const rifle = new FirstPersonRifle('308');
    rifle.resize(1280, 720);
    expect(rifle.camera.aspect).toBeCloseTo(16 / 9, 6);
    rifle.resize(800, 800);
    expect(rifle.camera.aspect).toBe(1);
    rifle.resize(0, 0); // a hidden window: keep the last good aspect
    expect(rifle.camera.aspect).toBe(1);
  });
});
