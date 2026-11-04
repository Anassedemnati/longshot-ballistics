import { describe, expect, it } from 'vitest';
import { CLIP_FILES, audibleRange, fitRate, jitterRate, shotClipId } from '../../src/audio/clips';

describe('shotClipId', () => {
  it('picks the Tikka recording for the .308 and the Mosin-Nagant for the .338', () => {
    expect(shotClipId('308')).toBe('shot_308');
    expect(shotClipId('338')).toBe('shot_338');
    for (const id of ['300', '408', '50', '127'] as const) expect(shotClipId(id)).toBe('shot_338');
    expect(shotClipId('127s')).toBe('shot_308');
  });
});

describe('CLIP_FILES', () => {
  it('names one mp3 per clip id', () => {
    expect(CLIP_FILES).toEqual({
      shot_308: 'shot_308.mp3',
      shot_338: 'shot_338.mp3',
      impact_hit: 'impact_hit.mp3',
      impact_dust: 'impact_dust.mp3',
      bolt_cycle: 'bolt_cycle.mp3',
      reload: 'reload.mp3',
      dry_fire: 'dry_fire.mp3',
    });
  });
});

describe('jitterRate', () => {
  it('spreads symmetrically around 1', () => {
    expect(jitterRate(0.03, () => 0)).toBeCloseTo(0.97, 12);
    expect(jitterRate(0.03, () => 0.5)).toBeCloseTo(1, 12);
    expect(jitterRate(0.05, () => 1)).toBeCloseTo(1.05, 12);
  });

  it('stays within +-spread for the real random source', () => {
    for (let i = 0; i < 200; i++) {
      const rate = jitterRate(0.05);
      expect(rate).toBeGreaterThanOrEqual(0.95);
      expect(rate).toBeLessThanOrEqual(1.05);
    }
  });

  it('is exactly 1 without spread', () => {
    expect(jitterRate(0, () => 0.9)).toBe(1);
  });
});

describe('fitRate', () => {
  it('plays a clip at the rate that makes it last the target time', () => {
    expect(fitRate(1.65, 1.5)).toBeCloseTo(1.1, 12);
    expect(fitRate(1.5, 1.5)).toBe(1);
  });

  it('is limited to 0.8 .. 1.25 so the clip never sounds chipmunk or sluggish', () => {
    expect(fitRate(3, 1.5)).toBe(1.25);
    expect(fitRate(0.5, 1.5)).toBe(0.8);
  });

  it('falls back to normal speed for nonsense input', () => {
    expect(fitRate(NaN, 1.5)).toBe(1);
    expect(fitRate(1.5, 0)).toBe(1);
    expect(fitRate(-1, 1.5)).toBe(1);
  });
});

describe('audibleRange', () => {
  const sampleRate = 1000; // 1 ms per sample keeps the numbers readable

  function clip(seconds: number, bursts: Array<[number, number, number]>): Float32Array {
    const samples = new Float32Array(Math.round(seconds * sampleRate));
    for (const [from, to, amp] of bursts) for (let i = Math.round(from * sampleRate); i < to * sampleRate; i++) samples[i] = amp;
    return samples;
  }

  it('finds where the sound starts (with 3 ms of lead-in) and how long it is audible', () => {
    const samples = clip(2, [[0.25, 1.0, 0.5]]);
    const range = audibleRange(samples, sampleRate);
    expect(range).not.toBeNull();
    expect(range!.start).toBeCloseTo(0.247, 6);
    // last loud sample ends at 1.0 s; 20 ms tail is kept
    expect(range!.start + range!.length).toBeCloseTo(1.02, 6);
  });

  it('ignores a noise floor below the threshold', () => {
    const samples = clip(1, [[0, 1, 0.004], [0.4, 0.5, 0.3]]);
    const range = audibleRange(samples, sampleRate);
    expect(range!.start).toBeCloseTo(0.397, 6);
    expect(range!.start + range!.length).toBeCloseTo(0.52, 6);
  });

  it('never starts before 0 or ends after the clip', () => {
    const range = audibleRange(clip(1, [[0, 1, 0.5]]), sampleRate);
    expect(range!.start).toBe(0);
    expect(range!.start + range!.length).toBeCloseTo(1, 12);
  });

  it('returns null for silence or an empty clip', () => {
    expect(audibleRange(new Float32Array(500), sampleRate)).toBeNull();
    expect(audibleRange(new Float32Array(0), sampleRate)).toBeNull();
  });
});
