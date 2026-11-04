import { describe, expect, it } from 'vitest';
import type { AudioEngine } from '../../src/audio/engine';
import type { Clip } from '../../src/audio/samples';
import {
  playBoltCycle,
  playDryFire,
  playImpactDust,
  playImpactHit,
  playImpactMetal,
  playReload,
  playShot,
} from '../../src/audio/sounds';

type ClipStatus = 'pending' | 'ready' | 'failed';

const CLIP: Clip = { buffer: { duration: 1.9 } as AudioBuffer, start: 0.1, length: 1.7 };

/** A running fake engine that records which Web Audio nodes the sounds create. */
function fakeEngine(status: ClipStatus) {
  const created: string[] = [];
  const buffers: unknown[] = [];
  const rates: Array<{ value: number }> = [];
  const filters: Array<{ type: string; frequency: { value: number } }> = [];
  const gains: Array<{ value: number }> = [];
  const param = () => ({
    value: 0,
    setValueAtTime: () => undefined,
    linearRampToValueAtTime: () => undefined,
    exponentialRampToValueAtTime: () => undefined,
    setTargetAtTime: () => undefined,
  });
  const node = (kind: string) => {
    created.push(kind);
    const n = {
      connect: () => undefined,
      start: () => undefined,
      stop: () => undefined,
      frequency: param(),
      gain: param(),
      Q: param(),
      playbackRate: param(),
      set buffer(b: unknown) {
        buffers.push(b);
      },
    };
    if (kind === 'source') rates.push(n.playbackRate);
    if (kind === 'filter') filters.push(n as unknown as (typeof filters)[number]);
    if (kind === 'gain') gains.push(n.gain);
    return n;
  };
  const ctx = {
    state: 'running',
    currentTime: 1,
    createBufferSource: () => node('source'),
    createBiquadFilter: () => node('filter'),
    createGain: () => node('gain'),
    createOscillator: () => node('osc'),
  };
  const engine = {
    ctx,
    bus: {},
    noise: { duration: 3 },
    muted: false,
    clip: () => (status === 'ready' ? CLIP : null),
    clipFailed: () => status === 'failed',
  } as unknown as AudioEngine;
  return { engine, created, buffers, rates, filters, gains };
}

const SOUNDS: Array<[string, (e: AudioEngine) => void]> = [
  ['shot (.308)', (e) => playShot(e, '308')],
  ['shot (.338)', (e) => playShot(e, '338')],
  ['impact on the target', (e) => playImpactHit(e, 0.5, 800)],
  ['impact in the dust', (e) => playImpactDust(e, 0.5, 800)],
  ['impact on metal', (e) => playImpactMetal(e, 0.5, 800)],
  ['bolt cycle', (e) => playBoltCycle(e)],
  ['reload', (e) => playReload(e)],
  ['dry fire', (e) => playDryFire(e)],
];

describe('recording or synthesised sound', () => {
  for (const [name, play] of SOUNDS) {
    describe(name, () => {
      it('is skipped while its recording is not decoded yet (no synth sound)', () => {
        const { engine, created } = fakeEngine('pending');
        play(engine);
        expect(created).toEqual([]);
      });

      it('plays the recording once it is ready, and nothing synthesised', () => {
        const { engine, created, buffers } = fakeEngine('ready');
        play(engine);
        expect(buffers).toEqual([CLIP.buffer]);
        expect(created).not.toContain('osc');
      });

      it('is synthesised when its recording failed to load', () => {
        const { engine, created, buffers } = fakeEngine('failed');
        play(engine);
        expect(created.length).toBeGreaterThan(0);
        expect(created).toContain('osc');
        expect(buffers).not.toContain(CLIP.buffer);
      });
    });
  }
});

describe('metal ping', () => {
  it('is the hit recording pitched well above the normal hit', () => {
    const metal = fakeEngine('ready');
    playImpactMetal(metal.engine, 0, 300);
    const hit = fakeEngine('ready');
    playImpactHit(hit.engine, 0, 300);
    expect(metal.buffers).toEqual(hit.buffers);
    expect(metal.rates[0].value).toBeGreaterThan(1.5);
    expect(hit.rates[0].value).toBeLessThan(1.1);
  });
});

describe('suppressed shot', () => {
  it('is much quieter than the open shot and low-passed at 1400 Hz', () => {
    const open = fakeEngine('ready');
    playShot(open.engine, '308');
    const quiet = fakeEngine('ready');
    playShot(quiet.engine, '308', true);
    expect(open.filters).toEqual([]); // the open shot is not filtered
    expect(quiet.filters.map((f) => [f.type, f.frequency.value])).toEqual([['lowpass', 1400]]);
    expect(quiet.gains[0].value).toBeCloseTo(0.22 * open.gains[0].value, 9);
  });

  it('uses the same recording per rifle as the open shot', () => {
    for (const id of ['308', '338'] as const) {
      const open = fakeEngine('ready');
      playShot(open.engine, id);
      const quiet = fakeEngine('ready');
      playShot(quiet.engine, id, true);
      expect(quiet.buffers).toEqual(open.buffers);
    }
  });

  it('is skipped while its recording is decoding', () => {
    const { engine, created } = fakeEngine('pending');
    playShot(engine, '308', true);
    expect(created).toEqual([]);
  });

  it('has a low-passed synthesised fallback', () => {
    const { engine, created, filters } = fakeEngine('failed');
    playShot(engine, '308', true);
    expect(created.length).toBeGreaterThan(0);
    expect(filters.length).toBeGreaterThan(0);
    for (const f of filters) expect(f.type === 'lowpass' && f.frequency.value === 1400).toBe(true);
  });
});

describe('each rifle has its own report', () => {
  const shot = (id: Parameters<typeof playShot>[1], suppressed = false) => {
    const f = fakeEngine('ready');
    playShot(f.engine, id, suppressed);
    return f;
  };

  it('heavier calibres play deeper and louder, with a low-shelf boost', () => {
    const light = shot('308');
    for (const id of ['408', '50', '127'] as const) {
      const heavy = shot(id);
      expect(heavy.rates[0].value).toBeLessThan(light.rates[0].value * 0.95);
      expect(heavy.gains[0].value).toBeGreaterThan(light.gains[0].value);
      expect(heavy.filters.some((f) => f.type === 'lowshelf')).toBe(true);
    }
    expect(shot('50').rates[0].value).toBeLessThan(shot('408').rates[0].value);
  });

  it('the 12.7 mm rifles add a slowed, low-passed boom layer under the report; the suppressed shot does not', () => {
    for (const id of ['50', '127'] as const) {
      const open = shot(id);
      expect(open.created.filter((k) => k === 'source')).toHaveLength(2);
      expect(open.rates[1].value).toBeLessThan(0.6);
      expect(open.filters.some((f) => f.type === 'lowpass' && f.frequency.value <= 400)).toBe(true);
      expect(shot(id, true).created.filter((k) => k === 'source')).toHaveLength(1);
    }
    expect(shot('308').created.filter((k) => k === 'source')).toHaveLength(1);
  });

  it("the 12.7x55's integral can is a quiet low thup: quieter and duller than a suppressed .308", () => {
    const thup = shot('127s', true);
    const can = shot('308', true);
    expect(thup.gains[0].value).toBeLessThan(can.gains[0].value);
    const cutoff = thup.filters.find((f) => f.type === 'lowpass')?.frequency.value ?? Infinity;
    expect(cutoff).toBeLessThan(600);
    expect(thup.rates[0].value).toBeLessThan(0.6);
  });
});
