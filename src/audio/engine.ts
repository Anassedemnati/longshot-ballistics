import type { ClipId } from './clips';
import { ClipBank } from './samples';
import type { Clip } from './samples';

/** Length of the shared white-noise buffer, s. Every noisy sound plays a random slice of it. */
const NOISE_SECONDS = 3;
/** Master level after the compressor. */
const MASTER_LEVEL = 0.8;
/** Time constant of the mute fade, s: short enough to feel instant, long enough not to click. */
const MUTE_FADE_S = 0.02;

/** Everything that exists only once the browser has let us start audio. */
interface AudioGraph {
  ctx: AudioContext;
  /** Input bus: sounds connect here. Compressor -> master gain -> speakers. */
  bus: DynamicsCompressorNode;
  master: GainNode;
  noise: AudioBuffer;
}

/**
 * Owns the AudioContext, the master chain (a gentle compressor so a shot never clips, then a master
 * gain that implements mute) and the one shared noise buffer. The context is created on the first
 * `resume()` because browsers only allow audio after a user gesture; until then `ctx` is null and
 * every sound is skipped. The recordings are fetched and decoded as soon as the context exists.
 */
export class AudioEngine {
  private graph: AudioGraph | null = null;
  private isMuted = false;
  private readonly clips = new ClipBank();
  /** True once creating the context failed: do not retry on every click. */
  private unavailable = false;
  /** The wind loop's level node once it is running (see `startWindAmbience`). */
  windLevel: GainNode | null = null;

  /** The context, or null before the first `resume()` (or if the browser has no Web Audio). */
  get ctx(): AudioContext | null {
    return this.graph?.ctx ?? null;
  }

  /** Where sounds connect their output, or null while there is no context. */
  get bus(): AudioNode | null {
    return this.graph?.bus ?? null;
  }

  /** The shared white-noise buffer, or null while there is no context. */
  get noise(): AudioBuffer | null {
    return this.graph?.noise ?? null;
  }

  /** A decoded recording, or null while it is loading or if it failed to load (use the synth recipe). */
  clip(id: ClipId): Clip | null {
    return this.clips.get(id);
  }

  get muted(): boolean {
    return this.isMuted;
  }

  /** Muting fades the master gain to 0, which also silences sounds already scheduled. */
  set muted(value: boolean) {
    this.isMuted = value;
    const graph = this.graph;
    if (graph) graph.master.gain.setTargetAtTime(value ? 0 : MASTER_LEVEL, graph.ctx.currentTime, MUTE_FADE_S);
  }

  toggleMute(): void {
    this.muted = !this.isMuted;
  }

  /**
   * Create the context on first call, and make sure it is running. Call it from a user gesture
   * (a click or a key press); calling it again is harmless.
   */
  resume(): void {
    if (!this.graph && !this.unavailable) {
      this.graph = this.createGraph();
      this.unavailable = this.graph === null;
      if (this.graph) void this.clips.load(this.graph.ctx, import.meta.env.BASE_URL);
    }
    const ctx = this.graph?.ctx;
    if (ctx && ctx.state !== 'running') ctx.resume().catch(() => undefined);
  }

  private createGraph(): AudioGraph | null {
    if (typeof AudioContext === 'undefined') return null;
    try {
      const ctx = new AudioContext({ latencyHint: 'interactive' });

      const bus = ctx.createDynamicsCompressor();
      bus.threshold.value = -12;
      bus.knee.value = 12;
      bus.ratio.value = 4;
      bus.attack.value = 0.003;
      bus.release.value = 0.25;
      const master = ctx.createGain();
      master.gain.value = this.isMuted ? 0 : MASTER_LEVEL;
      bus.connect(master);
      master.connect(ctx.destination);

      const noise = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * NOISE_SECONDS), ctx.sampleRate);
      const samples = noise.getChannelData(0);
      for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;

      // A hidden tab keeps its audio running: stop the wind there.
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) ctx.suspend().catch(() => undefined);
        else ctx.resume().catch(() => undefined);
      });

      return { ctx, bus, master, noise };
    } catch (error) {
      console.warn('Audio unavailable:', error);
      return null;
    }
  }
}
