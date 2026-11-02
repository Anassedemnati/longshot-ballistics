import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { FLASH_HDR_GAIN, FirstPersonRifle } from '../../src/player/rifle';
import { SKY_LOOKS, SKY_OBJECT_NAMES, createSky } from '../../src/scene/sky';

/** A world scene as `applyHdriSky` leaves it: sky objects by name, an environment texture, its yaw, per-theme light. */
function hdriWorld(theme: 'desert' | 'arctic' | 'valley', yaw = 0.7): { scene: THREE.Scene; environment: THREE.Texture } {
  const scene = new THREE.Scene();
  createSky(scene, theme);
  const look = SKY_LOOKS[theme].hdri;
  (scene.getObjectByName(SKY_OBJECT_NAMES.sun) as THREE.DirectionalLight).intensity = look.sunIntensity;
  (scene.getObjectByName(SKY_OBJECT_NAMES.hemisphere) as THREE.HemisphereLight).intensity = look.hemisphereIntensity;
  const environment = new THREE.Texture();
  scene.environment = environment;
  scene.environmentIntensity = look.environmentIntensity;
  scene.environmentRotation.set(0, yaw, 0);
  return { scene, environment };
}

const lights = (rifle: FirstPersonRifle) => {
  const found: THREE.Light[] = [];
  rifle.scene.traverse((o) => {
    if (o instanceof THREE.Light) found.push(o);
  });
  return found;
};

describe('the rifle lit by the world', () => {
  it('without an environment in the world it keeps its own light (nothing changes)', () => {
    const rifle = new FirstPersonRifle('308');
    const bare = new THREE.Scene();
    expect(rifle.lightFrom(bare)).toBe(false);
    expect(rifle.litByWorld).toBe(false);
    expect(rifle.scene.environment).toBeNull();
    expect(rifle.flashGain).toBe(1);
    rifle.orient(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 1)); // a no-op
    expect(rifle.scene.environmentRotation.y).toBe(0);
  });

  for (const theme of ['desert', 'arctic', 'valley'] as const) {
    it(`${theme}: takes the world's environment (shared, not copied), its intensity, the sun's colour and strength, the hemisphere's`, () => {
      const rifle = new FirstPersonRifle('338');
      const { scene, environment } = hdriWorld(theme);
      expect(rifle.lightFrom(scene)).toBe(true);
      expect(rifle.litByWorld).toBe(true);
      expect(rifle.scene.environment).toBe(environment);
      expect(rifle.scene.environmentIntensity).toBe(SKY_LOOKS[theme].hdri.environmentIntensity);
      const key = lights(rifle).find((l): l is THREE.DirectionalLight => l instanceof THREE.DirectionalLight && l.intensity > 1);
      expect(key?.intensity).toBe(SKY_LOOKS[theme].hdri.sunIntensity);
      expect(key?.color.getHex()).toBe(new THREE.Color(SKY_LOOKS[theme].sunColor).getHex());
      const hemisphere = lights(rifle).find((l): l is THREE.HemisphereLight => l instanceof THREE.HemisphereLight);
      expect(hemisphere?.intensity).toBe(SKY_LOOKS[theme].hdri.hemisphereIntensity);
    });
  }

  it('the muzzle flash gets an HDR colour (above the bloom threshold) only when the rifle is lit by the world; a suppressed rifle has no flash and lights fine', () => {
    const rifle = new FirstPersonRifle('308');
    expect(rifle.flashGain).toBe(1); // drawn straight to the canvas a gain above 1 would clip to a white blob
    expect(rifle.lightFrom(hdriWorld('desert').scene)).toBe(true);
    expect(rifle.flashGain).toBe(FLASH_HDR_GAIN);
    expect(FLASH_HDR_GAIN).toBeGreaterThan(3 * 2); // well over the bloom threshold (3) after the texture's own falloff
    const quiet = new FirstPersonRifle('308', true);
    expect(quiet.lightFrom(hdriWorld('valley').scene)).toBe(true);
    expect(quiet.flashGain).toBe(0);
  });

  it('orient turns the sun and the environment against the view: what the world has in direction d, the rifle scene has in q^-1 d', () => {
    const yaw = 0.7;
    const theme = 'desert';
    const rifle = new FirstPersonRifle('308');
    const { scene } = hdriWorld(theme, yaw);
    rifle.lightFrom(scene);
    const sunWorld = (scene.getObjectByName(SKY_OBJECT_NAMES.sun) as THREE.DirectionalLight).position.clone().normalize();
    const key = lights(rifle).find((l): l is THREE.DirectionalLight => l instanceof THREE.DirectionalLight && l.intensity > 1) as THREE.DirectionalLight;
    const yawInverse = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -yaw);
    for (const [pitch, turn] of [[0, 0], [0.2, 1.1], [-0.4, -2.5], [0.1, 3.0]]) {
      const view = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, turn, 0, 'YXZ'));
      rifle.orient(view);
      const inverse = view.clone().invert();
      // the key light shines from the world's sun, seen in the rifle's own (view) frame
      expect(key.position.clone().normalize().distanceTo(sunWorld.clone().applyQuaternion(inverse))).toBeLessThan(1e-6);
      // a rifle-scene direction r is looked up in the HDRI at yaw^-1 q r: the environment's rotation matrix M satisfies M^-1 r = yaw^-1 q r
      const m = new THREE.Matrix4().makeRotationFromEuler(rifle.scene.environmentRotation);
      const mInverse = m.clone().invert();
      for (const r of [new THREE.Vector3(0, 0, -1), new THREE.Vector3(0.3, 0.8, 0.2).normalize(), new THREE.Vector3(-1, 0, 0)]) {
        const expected = r.clone().applyQuaternion(view).applyQuaternion(yawInverse);
        expect(r.clone().applyMatrix4(mInverse).distanceTo(expected), `${pitch}/${turn}`).toBeLessThan(1e-6);
      }
    }
  });
});
