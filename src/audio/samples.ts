import { CLIP_FILES, audibleRange } from './clips';
import type { ClipId } from './clips';

/** A decoded recording and where its audible part lies. */
export interface Clip {
  buffer: AudioBuffer;
  /** Seconds of leading silence to skip when playing, s. */
  start: number;
  /** Length of the audible part from `start`, s (at normal speed). */
  length: number;
}

/** `pending`: still loading or decoding. `ready`: `get` has the clip. `failed`: it will never load. */
export type ClipState = 'pending' | 'ready' | 'failed';

/**
 * The recorded sounds from public/sounds/. The files are fetched as soon as the page starts
 * (`prefetch`: fetching needs no user gesture), and decoded once the audio context exists (`decode`,
 * which needs a context). A clip that is still pending when its sound is wanted is skipped by the
 * caller; only a clip that FAILED (logs one warning) is replaced by the synthesised recipe.
 */
export class ClipBank {
  private readonly clips = new Map<ClipId, Clip>();
  private readonly failed = new Set<ClipId>();
  /** The bytes of each file, or null if it could not be fetched. Each is decoded exactly once. */
  private readonly bytes = new Map<ClipId, Promise<ArrayBuffer | null>>();
  private decoding: Promise<void> | null = null;

  /** Start fetching every recording now. Call once; later calls do nothing. `baseUrl` ends with a slash. */
  prefetch(baseUrl: string): void {
    if (this.bytes.size > 0) return;
    for (const id of Object.keys(CLIP_FILES) as ClipId[]) {
      this.bytes.set(id, this.fetchOne(`${baseUrl}sounds/${CLIP_FILES[id]}`, id));
    }
  }

  /**
   * Decode every prefetched recording with `ctx` (waiting for any fetch still in flight). Never
   * rejects. Decoding detaches the bytes, so it runs once; later calls return the same promise.
   */
  decode(ctx: BaseAudioContext): Promise<void> {
    this.decoding ??= Promise.all((Object.keys(CLIP_FILES) as ClipId[]).map((id) => this.decodeOne(ctx, id))).then(
      () => undefined,
    );
    return this.decoding;
  }

  get(id: ClipId): Clip | null {
    return this.clips.get(id) ?? null;
  }

  state(id: ClipId): ClipState {
    if (this.clips.has(id)) return 'ready';
    return this.failed.has(id) ? 'failed' : 'pending';
  }

  private async fetchOne(url: string, id: ClipId): Promise<ArrayBuffer | null> {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.arrayBuffer();
    } catch (error) {
      this.fail(id, url, error);
      return null;
    }
  }

  private async decodeOne(ctx: BaseAudioContext, id: ClipId): Promise<void> {
    const url = CLIP_FILES[id];
    const bytes = await this.bytes.get(id);
    if (bytes === undefined) return this.fail(id, url, new Error('never fetched'));
    if (bytes === null) return; // the fetch failed and has already said so
    try {
      const buffer = await ctx.decodeAudioData(bytes);
      const range = audibleRange(buffer.getChannelData(0), buffer.sampleRate);
      this.clips.set(id, { buffer, start: range?.start ?? 0, length: range?.length ?? buffer.duration });
    } catch (error) {
      this.fail(id, url, error);
    }
  }

  /** Mark a clip as failed for good and warn, once per clip. */
  private fail(id: ClipId, url: string, error: unknown): void {
    if (this.failed.has(id)) return;
    this.failed.add(id);
    console.warn(`Sound ${url} unavailable, using the synthesised ${id} instead:`, error);
  }
}
