import * as THREE from 'three';
import { step } from '../ballistics/integrator';
import type { Atmosphere, Rifle, WindField } from '../ballistics/types';
import { muzzleLaunch } from './aim';

/** Preview uses the same drag, wind and gravity as live projectiles. */
export function predict(eye: THREE.Vector3, forward: THREE.Vector3, rifle: Rifle, atmo: Atmosphere, wind: WindField, zero: number, range: number) {
  const right = forward.clone().cross(new THREE.Vector3(0, 1, 0)).normalize();
  const up = right.cross(forward).normalize();
  const launch = muzzleLaunch(eye, forward, up, rifle, zero);
  let s = { pos: launch.origin, vel: launch.velocity, t: 0 };
  const points = [new THREE.Vector3(s.pos.x, s.pos.y, s.pos.z)];
  if (forward.z >= -0.05) return { points, impact: null, time: 0 };
  for (let i = 0; i < 3000; i++) {
    const prev = s;
    s = step(s, 0.01, rifle.bcG7, atmo, wind);
    if (s.pos.z <= -range) {
      const f = (-range - prev.pos.z) / (s.pos.z - prev.pos.z);
      const impact = new THREE.Vector3(prev.pos.x, prev.pos.y, prev.pos.z).lerp(new THREE.Vector3(s.pos.x, s.pos.y, s.pos.z), f);
      points.push(impact);
      return { points, impact, time: prev.t + f * 0.01 };
    }
    if (i % 3 === 0) points.push(new THREE.Vector3(s.pos.x, s.pos.y, s.pos.z));
  }
  return { points, impact: null, time: 0 };
}

export function solveAim(eye: THREE.Vector3, target: THREE.Vector3, rifle: Rifle, atmo: Atmosphere, wind: WindField, zero: number) {
  const aim = target.clone();
  for (let i = 0; i < 8; i++) {
    const p = predict(eye, aim.clone().sub(eye).normalize(), rifle, atmo, wind, zero, -target.z);
    if (!p.impact) return null;
    const error = target.clone().sub(p.impact);
    if (error.length() < 0.01) return aim;
    aim.add(error);
  }
  return null;
}
