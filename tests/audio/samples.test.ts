import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIP_FILES } from '../../src/audio/clips';
import type { ClipId } from '../../src/audio/clips';
import { ClipBank } from '../../src/audio/samples';

const IDS = Object.keys(CLIP_FILES) as ClipId[];
const BASE = '/game/';

/** A decoded clip whose sound starts at 0.1 s. */
function fakeBuffer(): AudioBuffer {
  const data = new Float32Array(100);
  data.fill(0.5, 10, 20);
  return { sampleRate: 100, duration: 1, getChannelData: () => data } as unknown as AudioBuffer;
}

/** A context whose decodeAudioData consumes (detaches) the ArrayBuffer it is given, like the real one. */
function fakeContext(failFor: ReadonlySet<number> = new Set()) {
  const decodeAudioData = vi.fn(async (bytes: ArrayBuffer) => {
    if (bytes.byteLength === 0) throw new Error('already detached');
    const tag = new Uint8Array(bytes)[0];
    structuredClone(bytes, { transfer: [bytes] }); // detach, as the browser does
    if (failFor.has(tag)) throw new DOMException('Unable to decode audio data', 'EncodingError');
    return fakeBuffer();
  });
  return { ctx: { decodeAudioData } as unknown as BaseAudioContext, decodeAudioData };
}

function okResponse(tag: number): Response {
  return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([tag, 1, 2, 3]).buffer } as Response;
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  warn.mockRestore();
});

describe('ClipBank', () => {
  it('prefetch requests every file at once, with no audio context', () => {
    const fetchMock = vi.fn(async (_url: string) => okResponse(1));
    vi.stubGlobal('fetch', fetchMock);
    new ClipBank().prefetch(BASE);
    expect(fetchMock.mock.calls.map((c) => c[0]).sort()).toEqual(
      IDS.map((id) => `${BASE}sounds/${CLIP_FILES[id]}`).sort(),
    );
  });

  it('is pending, with no clip, until it has been decoded', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(1)));
    const bank = new ClipBank();
    bank.prefetch(BASE);
    await Promise.resolve();
    for (const id of IDS) {
      expect(bank.state(id)).toBe('pending');
      expect(bank.get(id)).toBeNull();
    }
  });

  it('decode turns the prefetched bytes into ready clips without fetching again', async () => {
    const fetchMock = vi.fn(async (_url: string) => okResponse(1));
    vi.stubGlobal('fetch', fetchMock);
    const bank = new ClipBank();
    bank.prefetch(BASE);
    const { ctx, decodeAudioData } = fakeContext();
    await bank.decode(ctx);
    expect(fetchMock).toHaveBeenCalledTimes(IDS.length);
    expect(decodeAudioData).toHaveBeenCalledTimes(IDS.length);
    for (const id of IDS) {
      expect(bank.state(id)).toBe('ready');
      const clip = bank.get(id);
      expect(clip?.start).toBeCloseTo(0.097, 9);
      expect(clip?.length).toBeCloseTo(0.1 + 0.003 + 0.02, 9);
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('decode waits for a fetch that is still in flight (the first click can come early)', async () => {
    const resolvers: Array<(r: Response) => void> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => resolvers.push(resolve))),
    );
    const bank = new ClipBank();
    bank.prefetch(BASE);
    const done = bank.decode(fakeContext().ctx);
    await new Promise((r) => setTimeout(r, 0));
    expect(bank.state('shot_308')).toBe('pending');
    expect(bank.get('shot_308')).toBeNull();
    for (const resolve of resolvers) resolve(okResponse(1));
    await done;
    expect(bank.state('shot_308')).toBe('ready');
  });

  it('decoding twice does not detach and re-decode: no clip is marked failed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(1)));
    const bank = new ClipBank();
    bank.prefetch(BASE);
    const { ctx, decodeAudioData } = fakeContext();
    await Promise.all([bank.decode(ctx), bank.decode(ctx)]);
    await bank.decode(ctx);
    expect(decodeAudioData).toHaveBeenCalledTimes(IDS.length);
    for (const id of IDS) expect(bank.state(id)).toBe('ready');
    expect(warn).not.toHaveBeenCalled();
  });

  it('a file that cannot be fetched fails at once, with one warning, and the others still load', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('reload.mp3') ? ({ ok: false, status: 404 } as Response) : okResponse(1),
      ),
    );
    const bank = new ClipBank();
    bank.prefetch(BASE);
    await new Promise((r) => setTimeout(r, 0));
    expect(bank.state('reload')).toBe('failed');
    expect(warn).toHaveBeenCalledTimes(1);
    await bank.decode(fakeContext().ctx);
    expect(bank.state('reload')).toBe('failed');
    expect(bank.get('reload')).toBeNull();
    expect(bank.state('shot_308')).toBe('ready');
    expect(warn).toHaveBeenCalledTimes(1); // decode does not warn about it a second time
  });

  it('a network error counts as a failed fetch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    const bank = new ClipBank();
    bank.prefetch(BASE);
    await bank.decode(fakeContext().ctx);
    for (const id of IDS) expect(bank.state(id)).toBe('failed');
    expect(warn).toHaveBeenCalledTimes(IDS.length);
  });

  it('a file that cannot be decoded fails with one warning', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => okResponse(n++))); // byte 0 of each file = its index
    const bank = new ClipBank();
    bank.prefetch(BASE);
    const { ctx } = fakeContext(new Set([2]));
    await bank.decode(ctx);
    const states = IDS.map((id) => bank.state(id));
    expect(states.filter((s) => s === 'failed')).toHaveLength(1);
    expect(states.filter((s) => s === 'ready')).toHaveLength(IDS.length - 1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('decode without a prefetch fails the clips instead of throwing', async () => {
    const bank = new ClipBank();
    await expect(bank.decode(fakeContext().ctx)).resolves.toBeUndefined();
    for (const id of IDS) expect(bank.state(id)).toBe('failed');
  });
});
