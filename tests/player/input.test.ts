import { describe, expect, it } from 'vitest';
import { InputState } from '../../src/player/input';

const DEG = Math.PI / 180;

describe('InputState', () => {
  it('starts unlocked at yaw 0, pitch 0', () => {
    const input = new InputState();
    expect(input.locked).toBe(false);
    expect(input.yaw).toBe(0);
    expect(input.pitch).toBe(0);
  });

  it('while unlocked a click requests pointer lock and mouse moves do nothing', () => {
    const input = new InputState();
    expect(input.onMouseDown(0)).toBe('requestLock');
    input.onMouseMove(200, -150, 0.002);
    expect(input.yaw).toBe(0);
    expect(input.pitch).toBe(0);
  });

  it('after the lock is granted the first left click fires and the right click toggles the scope', () => {
    const input = new InputState();
    input.onMouseDown(0); // the click that asked for the lock
    input.onLockChange(true);
    expect(input.locked).toBe(true);
    expect(input.onMouseDown(0)).toBe('fire');
    expect(input.onMouseDown(2)).toBe('toggleScope');
    expect(input.onMouseDown(1)).toBeNull();
  });

  it('losing the lock (Esc) makes the next click request it again', () => {
    const input = new InputState();
    input.onLockChange(true);
    expect(input.onMouseDown(0)).toBe('fire');
    input.onLockChange(false);
    expect(input.locked).toBe(false);
    expect(input.onMouseDown(0)).toBe('requestLock');
    input.onMouseMove(50, 50, 0.002); // ignored again
    expect(input.yaw).toBe(0);
    expect(input.pitch).toBe(0);
  });

  it('mouse right turns right and mouse up looks up, scaled by the sensitivity', () => {
    const input = new InputState();
    input.onLockChange(true);
    input.onMouseMove(100, 0, 0.002);
    expect(input.yaw).toBeCloseTo(-0.2, 12); // turning right is negative yaw about +Y
    input.onMouseMove(0, -50, 0.001);
    expect(input.pitch).toBeCloseTo(0.05, 12);
    input.onMouseMove(-100, 0, 0.002);
    expect(input.yaw).toBeCloseTo(0, 12);
  });

  it('clamps pitch to +-80 degrees', () => {
    const input = new InputState();
    input.onLockChange(true);
    input.onMouseMove(0, -1e6, 0.01);
    expect(input.pitch).toBeCloseTo(80 * DEG, 12);
    input.onMouseMove(0, 1e6, 0.01);
    expect(input.pitch).toBeCloseTo(-80 * DEG, 12);
  });

  it('ignores non-finite mouse deltas and sensitivities', () => {
    const input = new InputState();
    input.onLockChange(true);
    input.onMouseMove(Number.NaN, 10, 0.002);
    input.onMouseMove(10, 10, Number.NaN);
    expect(Number.isFinite(input.yaw)).toBe(true);
    expect(Number.isFinite(input.pitch)).toBe(true);
  });
});
