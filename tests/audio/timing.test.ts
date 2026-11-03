import { describe, expect, it } from 'vitest';
import {
  distance,
  distanceCutoffHz,
  distanceGain,
  impactGain,
  impactSoundDelay,
  soundTravelTime,
} from '../../src/audio/timing';

const C = 353.6; // desert speed of sound, m/s
const ORIGIN = { x: 0, y: 0, z: 0 };

describe('soundTravelTime', () => {
  it('takes 800 / 353.6 = 2.2624 s to cover 800 m', () => {
    expect(soundTravelTime(ORIGIN, { x: 0, y: 0, z: -800 }, C)).toBeCloseTo(2.2624, 3);
  });

  it('uses the full 3D distance', () => {
    expect(soundTravelTime(ORIGIN, { x: 300, y: 0, z: -400 }, 100)).toBeCloseTo(5, 12);
    expect(soundTravelTime({ x: 1, y: 2, z: 3 }, { x: 1, y: 2 + 12, z: 3 + 5 }, 13)).toBeCloseTo(1, 12);
  });

  it('is zero for coincident points', () => {
    expect(soundTravelTime(ORIGIN, ORIGIN, C)).toBe(0);
  });
});

describe('impactSoundDelay', () => {
  it('equals the travel time from the impact point to the listener', () => {
    const listener = { x: 0, y: 12.4, z: 0 };
    const impact = { x: 3.5, y: 1.2, z: -812.3 };
    expect(impactSoundDelay(impact, listener, C)).toBe(soundTravelTime(impact, listener, C));
    expect(impactSoundDelay(impact, listener, C)).toBe(soundTravelTime(listener, impact, C));
  });

  it('grows with range: a 1500 m impact is heard later than a 100 m one', () => {
    const near = impactSoundDelay({ x: 0, y: 0, z: -100 }, ORIGIN, C);
    const far = impactSoundDelay({ x: 0, y: 0, z: -1500 }, ORIGIN, C);
    expect(far).toBeGreaterThan(near);
    expect(far).toBeCloseTo(1500 / C, 9);
  });
});

describe('distance', () => {
  it('is the Euclidean distance', () => {
    expect(distance(ORIGIN, { x: 3, y: 4, z: 12 })).toBe(13);
  });
});

describe('distanceGain', () => {
  it('is 1/(1 + d/300) and decreases with range', () => {
    expect(distanceGain(0)).toBe(1);
    expect(distanceGain(300)).toBeCloseTo(0.5, 12);
    expect(distanceGain(100)).toBeGreaterThan(distanceGain(800));
    expect(distanceGain(800)).toBeGreaterThan(distanceGain(1500));
  });

  it('treats a bad distance as 0 m', () => {
    expect(distanceGain(NaN)).toBe(1);
    expect(distanceGain(-50)).toBe(1);
  });
});

describe('distanceCutoffHz', () => {
  it('is 4 kHz at 100 m and 800 Hz at 1500 m, dulling steadily in between', () => {
    expect(distanceCutoffHz(100)).toBeCloseTo(4000, 6);
    expect(distanceCutoffHz(1500)).toBeCloseTo(800, 6);
    expect(distanceCutoffHz(800)).toBeLessThan(distanceCutoffHz(400));
    expect(distanceCutoffHz(800)).toBeGreaterThan(distanceCutoffHz(1200));
  });

  it('clamps outside 100..1500 m', () => {
    expect(distanceCutoffHz(0)).toBeCloseTo(4000, 6);
    expect(distanceCutoffHz(5000)).toBeCloseTo(800, 6);
    expect(distanceCutoffHz(NaN)).toBeCloseTo(4000, 6);
  });
});

describe('impactGain', () => {
  it('is 1 up to 100 m and then follows the distance falloff relative to 100 m', () => {
    expect(impactGain(0)).toBe(1);
    expect(impactGain(100)).toBe(1);
    expect(impactGain(800)).toBeCloseTo(distanceGain(800) / distanceGain(100), 12);
    expect(impactGain(800)).toBeCloseTo(0.3636, 3);
    expect(impactGain(1500)).toBeCloseTo(0.2222, 3);
  });

  it('decreases with range and tolerates garbage', () => {
    expect(impactGain(400)).toBeGreaterThan(impactGain(900));
    expect(impactGain(NaN)).toBe(1);
  });
});
