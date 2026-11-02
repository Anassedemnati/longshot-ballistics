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
  return { engine, created, buffers, rates };
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
