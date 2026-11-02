import type { PostQuality } from './postfx';

// Render quality (pure logic, no three.js, so it runs and is tested in Node):
//   - the levels `high`, `medium` and `low`, what each switches on (post chain, antialiasing, shadow map, vegetation density, pixel
//     ratio ceiling), chosen with `?quality=auto|high|medium|low` (default `auto`; the older `?post=high|low|off` maps onto it);
//   - the frame governor: watches the time between frames and scales the render resolution down, in a few steps with hysteresis, when
//     the GPU cannot hold 60 fps, and tries a step back up now and then (a vsynced display shows no headroom, so it has to probe).
// `auto` starts at `medium` and never goes up by itself (on a vsynced display a fast machine and a just-fast-enough one look the same); it
// goes down to `low` when the first seconds at full resolution are far too slow.

export type QualityLevel = 'high' | 'medium' | 'low';
export type QualityChoice = QualityLevel | 'auto';

export interface QualitySettings {
  level: QualityLevel;
  /** The post chain: `high` = bloom + grade, `low` = grade only (no bloom), `off` = no chain at all (the world is drawn onto the canvas). */
  post: PostQuality;
  /** Multisampling of the chain's target (0 = none): it costs about a quarter of the frame at 720p on an integrated GPU. */
  samples: number;
  /** FXAA after the grade (where there is no multisampling). */
  fxaa: boolean;
  /** The render pixel ratio never exceeds this (nor the display's own): a retina screen is 4x the pixels of a plain one, far more than this class of GPU holds. */
  pixelRatioCap: number;
  /** Side of the sun's shadow map, texels, and how often it is redrawn (1 = every frame, 2 = every other frame). */
  shadowMapSize: number;
  shadowEvery: number;
  /** Share of the planned trees, shrubs, boulders and grass that is drawn (the plan is shuffled, so any share is an even thinning). */
  vegetationScale: number;
  /** Share of the ground-detail pebbles and tufts drawn. */
  detailScale: number;
}

export const QUALITY: Readonly<Record<QualityLevel, QualitySettings>> = {
  high: { level: 'high', post: 'high', samples: 2, fxaa: false, pixelRatioCap: 1.5, shadowMapSize: 2048, shadowEvery: 1, vegetationScale: 1, detailScale: 1 },
  medium: { level: 'medium', post: 'high', samples: 0, fxaa: true, pixelRatioCap: 1, shadowMapSize: 1024, shadowEvery: 1, vegetationScale: 0.8, detailScale: 0.8 },
  low: { level: 'low', post: 'low', samples: 0, fxaa: false, pixelRatioCap: 1, shadowMapSize: 1024, shadowEvery: 2, vegetationScale: 0.5, detailScale: 0.5 },
};

export interface QualityRequest {
  choice: QualityChoice;
  /** An explicit `?post=` (it overrides the level's post chain), or null. */
  post: PostQuality | null;
}

/**
 * `?quality=auto|high|medium|low` picks the level. The older `?post=high|low|off` still works: alone it picks `high` / `low` (and
 * `off` = no post chain at all, on the low level's other settings); next to `?quality=` it overrides only the post chain.
 */
export function qualityFromSearch(search: string): QualityRequest {
  const params = new URLSearchParams(search);
  const q = params.get('quality');
  const p = params.get('post');
  const post: PostQuality | null = p === 'high' || p === 'low' || p === 'off' ? p : null;
  if (q === 'high' || q === 'medium' || q === 'low' || q === 'auto') return { choice: q, post };
  if (post === 'high') return { choice: 'high', post };
  if (post === 'low' || post === 'off') return { choice: 'low', post };
  return { choice: 'auto', post: null };
}

/** The settings of a level, with the request's explicit post chain applied (and FXAA only where there is a chain to antialias). */
export function settingsFor(level: QualityLevel, post: PostQuality | null = null): QualitySettings {
  const base = QUALITY[level];
  if (post === null || post === base.post) return base;
  return { ...base, post, fxaa: post === 'off' ? false : base.fxaa };
}

/** The render scales the governor steps through, as shares of the level's pixel ratio. */
export const SCALE_STEPS: ReadonlyArray<number> = [1, 0.85, 0.72, 0.6];

/** The pixel ratio to render at: the display's, capped by the level, times the governor's scale. */
export function pixelRatioFor(settings: QualitySettings, devicePixelRatio: number, scale: number): number {
  const base = Math.min(Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1, settings.pixelRatioCap);
  return Math.max(0.3, base * scale);
}

export interface GovernorOptions {
  /** Frame time above which resolution goes down, ms (60 fps is 16.7). */
  slowMs?: number;
  /** Frames ignored at the start (shader compiles, texture uploads), and per scale change (the targets are reallocated). */
  warmupFrames?: number;
  /** ... and at least this many seconds at the start, whatever the frame count (the textures, the glTF models and the shader recompiles arrive in the first seconds). */
  warmupS?: number;
  /** Time between two changes, s, and before the first probe upward. */
  holdS?: number;
  probeAfterS?: number;
  /** In `auto`, the frame time at full resolution, ms, above which the level drops to `low` after the warm-up. */
  hopelessMs?: number;
}

export type GovernorAction = { kind: 'scale'; scale: number; index: number } | { kind: 'level'; level: QualityLevel };

/**
 * Watches frame times (ms between frames; a gap over `STALL_MS` is a stall - hidden tab, compile - and ignored) and answers with
 * the action to take, if any. Down when the smoothed frame time is over `slowMs`; one step up now and then to see if there is
 * room (a vsynced display never shows headroom), taken back at once if it was not, and then probed less often.
 */
export class FrameGovernor {
  static readonly STALL_MS = 250;
  private readonly slowMs: number;
  private readonly warmupFrames: number;
  private startupS: number;
  private readonly holdS: number;
  private readonly hopelessMs: number;
  private probeIntervalS: number;
  private readonly probeBaseS: number;
  private index = 0;
  private smoothed = 0;
  private seen = 0;
  private warm = 0;
  private sinceChange = 0;
  private probing = false;
  private autoPending: boolean;

  constructor(
    /** `true` in `auto`: the first seconds may drop the level to `low`. */
    auto: boolean,
    options: GovernorOptions = {},
  ) {
    this.slowMs = options.slowMs ?? 18.5;
    this.warmupFrames = options.warmupFrames ?? 40;
    this.startupS = options.warmupS ?? 4;
    this.holdS = options.holdS ?? 1.5;
    this.probeBaseS = options.probeAfterS ?? 10;
    this.probeIntervalS = this.probeBaseS;
    this.hopelessMs = options.hopelessMs ?? 30;
    this.autoPending = auto;
    this.warm = this.warmupFrames;
  }

  get scaleIndex(): number {
    return this.index;
  }

  get scale(): number {
    return SCALE_STEPS[this.index];
  }

  /** The smoothed frame time, ms (0 before the first frame counted). */
  get frameMs(): number {
    return this.smoothed;
  }

  /** Feed one frame's duration (ms); returns what to do now, or null. */
  frame(dtMs: number): GovernorAction | null {
    if (!(dtMs > 0) || dtMs > FrameGovernor.STALL_MS) return null;
    this.sinceChange += dtMs / 1000;
    this.startupS -= dtMs / 1000;
    if (this.warm > 0 || this.startupS > 0) {
      this.warm = Math.max(0, this.warm - 1);
      this.smoothed = 0;
      this.seen = 0;
      return null;
    }
    this.seen++;
    // One long frame (a compile, a texture upload) must not decide: a sample counts for at most twice the slow threshold.
    const sample = Math.min(dtMs, this.slowMs * 2);
    this.smoothed = this.seen === 1 ? sample : this.smoothed + (sample - this.smoothed) * 0.08;
    if (this.seen < 20) return null; // the average needs a few frames behind it

    // The first measured frames in `auto`: hopelessly slow at full resolution means the low level, once (before any step down).
    if (this.autoPending) {
      this.autoPending = false;
      if (this.smoothed > this.hopelessMs && this.index === 0) {
        this.restart();
        return { kind: 'level', level: 'low' };
      }
    }

    if (this.smoothed > this.slowMs && this.sinceChange >= this.holdS && this.index < SCALE_STEPS.length - 1) {
      if (this.probing) this.probeIntervalS = Math.min(120, this.probeIntervalS * 2); // that step up was too much: ask again later
      this.probing = false;
      this.index++;
      this.restart();
      return { kind: 'scale', scale: this.scale, index: this.index };
    }
    if (this.probing && this.sinceChange > 3) {
      this.probing = false; // it held: keep it, and ask the same again after the usual time
      this.probeIntervalS = this.probeBaseS;
    }
    if (!this.probing && this.index > 0 && this.sinceChange >= this.probeIntervalS) {
      this.probing = true;
      this.index--;
      this.restart();
      return { kind: 'scale', scale: this.scale, index: this.index };
    }
    return null;
  }

  /** A change reallocates targets and recompiles: skip the next frames and start the averaging over. */
  private restart(): void {
    this.sinceChange = 0;
    this.warm = Math.max(10, Math.floor(this.warmupFrames / 2));
    this.seen = 0;
    this.smoothed = 0;
  }
}
