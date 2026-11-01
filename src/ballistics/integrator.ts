import { dragFactor, g7Cd } from './drag';
import type { Atmosphere, BulletState, Vec3, WindField } from './types';

/** Default integration time step, s. */
export const DEFAULT_DT = 0.001;

/** Gravity, m/s^2 (acts along -Y). */
export const GRAVITY = 9.80665;

/**
 * Acceleration of a point-mass bullet at (pos, vel, t):
 * gravity plus G7 drag against the air velocity relative to the bullet,
 * a = -densityRatio * dragFactor(bc) * g7Cd(M) * |v_rel| * v_rel,  v_rel = vel - wind.
 */
function acceleration(
  pos: Vec3,
  vel: Vec3,
  t: number,
  k0: number,
  atmo: Atmosphere,
  wind: WindField,
): Vec3 {
  const w = wind(pos, t);
  const rx = vel.x - w.x;
  const ry = vel.y - w.y;
  const rz = vel.z - w.z;
  const speed = Math.sqrt(rx * rx + ry * ry + rz * rz);
  const k = atmo.densityRatio * k0 * g7Cd(speed / atmo.speedOfSound) * speed;
  return { x: -k * rx, y: -k * ry - GRAVITY, z: -k * rz };
}

/**
 * Advance a bullet by one RK4 step of size dt. Pure: returns a new state.
 * This is the single stepping function shared by validation, in-game flight and the bullet cam.
 */
export function step(
  s: BulletState,
  dt: number,
  bcG7: number,
  atmo: Atmosphere,
  wind: WindField,
): BulletState {
  const k0 = dragFactor(bcG7);
  const { pos, vel, t } = s;
  const h2 = dt / 2;

  // Stage 1
  const a1 = acceleration(pos, vel, t, k0, atmo, wind);
  const v1 = vel;

  // Stage 2
  const p2: Vec3 = { x: pos.x + v1.x * h2, y: pos.y + v1.y * h2, z: pos.z + v1.z * h2 };
  const v2: Vec3 = { x: vel.x + a1.x * h2, y: vel.y + a1.y * h2, z: vel.z + a1.z * h2 };
  const a2 = acceleration(p2, v2, t + h2, k0, atmo, wind);

  // Stage 3
  const p3: Vec3 = { x: pos.x + v2.x * h2, y: pos.y + v2.y * h2, z: pos.z + v2.z * h2 };
  const v3: Vec3 = { x: vel.x + a2.x * h2, y: vel.y + a2.y * h2, z: vel.z + a2.z * h2 };
  const a3 = acceleration(p3, v3, t + h2, k0, atmo, wind);

  // Stage 4
  const p4: Vec3 = { x: pos.x + v3.x * dt, y: pos.y + v3.y * dt, z: pos.z + v3.z * dt };
  const v4: Vec3 = { x: vel.x + a3.x * dt, y: vel.y + a3.y * dt, z: vel.z + a3.z * dt };
  const a4 = acceleration(p4, v4, t + dt, k0, atmo, wind);

  const d6 = dt / 6;
  return {
    pos: {
      x: pos.x + d6 * (v1.x + 2 * v2.x + 2 * v3.x + v4.x),
      y: pos.y + d6 * (v1.y + 2 * v2.y + 2 * v3.y + v4.y),
      z: pos.z + d6 * (v1.z + 2 * v2.z + 2 * v3.z + v4.z),
    },
    vel: {
      x: vel.x + d6 * (a1.x + 2 * a2.x + 2 * a3.x + a4.x),
      y: vel.y + d6 * (a1.y + 2 * a2.y + 2 * a3.y + a4.y),
      z: vel.z + d6 * (a1.z + 2 * a2.z + 2 * a3.z + a4.z),
    },
    t: t + dt,
  };
}
