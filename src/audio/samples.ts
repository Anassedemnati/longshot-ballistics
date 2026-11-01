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

/**
 * The recorded sounds from public/sounds/, each fetched and decoded once. A file that cannot be
 * loaded or decoded logs one warning and stays missing, so its sound falls back to the synthesised
 * recipe (`get` returns null until a clip is ready, and for ever if it failed).
 */
export class ClipBank {
  private readonly clips = new Map<ClipId, Clip>();

  /** Fetch and decode every recording (in parallel). Never rejects. `baseUrl` ends with a slash. */
  async load(ctx: BaseAudioContext, baseUrl: string): Promise<void> {
    const ids = Object.keys(CLIP_FILES) as ClipId[];
    await Promise.all(ids.map((id) => this.loadOne(ctx, `${baseUrl}sounds/${CLIP_FILES[id]}`, id)));
  }

  get(id: ClipId): Clip | null {
    return this.clips.get(id) ?? null;
  }

  private async loadOne(ctx: BaseAudioContext, url: string, id: ClipId): Promise<void> {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = await ctx.decodeAudioData(await response.arrayBuffer());
      const range = audibleRange(buffer.getChannelData(0), buffer.sampleRate);
      this.clips.set(id, { buffer, start: range?.start ?? 0, length: range?.length ?? buffer.duration });
    } catch (error) {
      console.warn(`Sound ${url} unavailable, using the synthesised ${id} instead:`, error);
    }
  }
}
