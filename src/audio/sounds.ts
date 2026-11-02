import type { Rifle } from '../ballistics/types';
import { fitRate, jitterRate, shotClipId } from './clips';
import type { ClipId } from './clips';
import type { AudioEngine } from './engine';
import type { Clip } from './samples';
import { distanceCutoffHz, distanceGain, impactGain } from './timing';

// Every sound plays a recording (public/sounds, CC0, see samples.ts) through its own gain into the
// master chain. If a recording FAILED to load or decode, the same sound is synthesised instead from
// noise bursts, sine/triangle sweeps, filters and envelopes (the `synth...` fallbacks below). While a
// recording is merely not decoded yet the sound is skipped: a synth sound that then gives way to the
// real one would make the first shot sound different from all the others.
// Everything is scheduled on the audio clock, never with timers. Each public function returns
// silently when there is no running context (no user gesture yet) or the engine is muted.

/**
 * Relative loudness of the recordings (all are loudness-normalised, so these set the mix). The shot
 * is the loudest sound. `impactHit` is the level at 100 m, `impactGain` lowers it further out. Tune
 * by ear. The wind has its own `WIND_MAKEUP`.
 */
const LEVELS = {
  shot: 1.0,
  bolt: 0.5,
  reload: 0.5,
  dryFire: 0.6,
  impactHit: 0.8,
  impactDust: 0.6,
  impactMetal: 0.7,
};
/** Playback-rate factor that turns the impact recording into a bright metallic ping (vehicle bodies, engines). */
const METAL_PITCH = 1.8;
/** Random playback-rate spread of a shot (+-3 %) and of an impact (+-5 %), so repeats differ. */
const SHOT_RATE_SPREAD = 0.03;
const IMPACT_RATE_SPREAD = 0.05;
/** Fade at the end of a clip that has to be cut short, s. */
const CUT_FADE_S = 0.06;

/** Envelope floor: an exponential ramp cannot reach 0, and -80 dB is inaudible. */
const SILENCE = 1e-4;
/** Seconds after a shot before the bolt is worked: the muzzle blast has passed. */
const BOLT_DELAY_S = 0.25;
/** Bolt cycle length when the caller does not give one, s (see `BOLT_TIME_S` in game/weapon.ts). */
const DEFAULT_BOLT_CYCLE_S = 1.2;
/** Gap between the two bolt clicks, s. */
const BOLT_CLICK_GAP_S = 0.25;
/** Level of a synthesised impact heard from right next to it (distanceGain = 1); real impacts are quieter. */
const IMPACT_LEVEL = 2;
/** Wind loop makeup: bandpassed noise is quiet, and the wind must stay under the effects. */
const WIND_MAKEUP = 0.3;

/** What a sound needs from the engine once there is a running context. */
interface Stage {
  ctx: AudioContext;
  out: AudioNode;
  noise: AudioBuffer;
  /** Start time on the audio clock, s. */
  t: number;
}

interface FilterSpec {
  type: BiquadFilterType;
  freq: number;
  q?: number;
  gainDb?: number;
}

function stage(e: AudioEngine, delaySec = 0): Stage | null {
  const { ctx, bus, noise } = e;
  if (!ctx || !bus || !noise || e.muted || ctx.state !== 'running') return null;
  const delay = Number.isFinite(delaySec) ? Math.max(0, delaySec) : 0;
  return { ctx, out: bus, noise, t: ctx.currentTime + delay };
}

/**
 * Play the recording `id` if it is ready, the synth recipe if it failed to load, and nothing at all
 * while it is still being decoded.
 */
function recordingOrSynth(e: AudioEngine, id: ClipId, play: (clip: Clip) => void, synth: () => void): void {
  const clip = e.clip(id);
  if (clip) play(clip);
  else if (e.clipFailed(id)) synth();
}

interface ClipOptions {
  /** Gain, see LEVELS. */
  level: number;
  /** Playback rate, default 1. */
  rate?: number;
  /** Low-pass cutoff, Hz: duller sound for distant impacts. */
  cutoff?: number;
  /** Cut the clip off after this many seconds (with a short fade). */
  maxSec?: number;
}

/** Play a recording from its first audible sample at `s.t`: [low-pass] -> gain -> master chain. */
function playClip(s: Stage, clip: Clip, options: ClipOptions): void {
  const { level, rate = 1, cutoff, maxSec } = options;
  const source = s.ctx.createBufferSource();
  source.buffer = clip.buffer;
  source.playbackRate.value = rate;
  let tail: AudioNode = source;
  if (cutoff !== undefined) {
    const lowpass = s.ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = cutoff;
    lowpass.Q.value = 0.5; // no resonant bump
    tail.connect(lowpass);
    tail = lowpass;
  }
  const gain = s.ctx.createGain();
  gain.gain.value = level;
  if (maxSec !== undefined) {
    gain.gain.setValueAtTime(level, s.t + Math.max(0, maxSec - CUT_FADE_S));
    gain.gain.linearRampToValueAtTime(0, s.t + maxSec);
  }
  tail.connect(gain);
  gain.connect(s.out);
  source.start(s.t, clip.start);
  if (maxSec !== undefined) source.stop(s.t + maxSec); // after start(): stop() before start() throws
}

/** Fast attack to `peak`, then an exponential fall to silence over `decay` s. */
function envelope(param: AudioParam, t: number, peak: number, attack: number, decay: number): void {
  param.setValueAtTime(SILENCE, t);
  param.linearRampToValueAtTime(Math.max(peak, 2 * SILENCE), t + attack);
  param.exponentialRampToValueAtTime(SILENCE, t + attack + decay);
}

/** White noise from a random slice of the shared buffer, through `filters`, shaped by an envelope. */
function noiseBurst(s: Stage, t: number, filters: FilterSpec[], peak: number, attack: number, decay: number): void {
  const duration = attack + decay + 0.02;
  const source = s.ctx.createBufferSource();
  source.buffer = s.noise;
  let tail: AudioNode = source;
  for (const spec of filters) {
    const filter = s.ctx.createBiquadFilter();
    filter.type = spec.type;
    filter.frequency.value = spec.freq;
    if (spec.q !== undefined) filter.Q.value = spec.q;
    if (spec.gainDb !== undefined) filter.gain.value = spec.gainDb;
    tail.connect(filter);
    tail = filter;
  }
  const gain = s.ctx.createGain();
  envelope(gain.gain, t, peak, attack, decay);
  tail.connect(gain);
  gain.connect(s.out);
  source.start(t, Math.random() * (s.noise.duration - duration), duration);
}

/** An oscillator gliding exponentially from `from` to `to` Hz over `sweep` s, shaped by an envelope. */
function tone(
  s: Stage,
  type: OscillatorType,
  t: number,
  from: number,
  to: number,
  sweep: number,
  peak: number,
  attack: number,
  decay: number,
): void {
  const osc = s.ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(from, t);
  osc.frequency.exponentialRampToValueAtTime(to, t + sweep);
  const gain = s.ctx.createGain();
  envelope(gain.gain, t, peak, attack, decay);
  osc.connect(gain);
  gain.connect(s.out);
  osc.start(t);
  osc.stop(t + attack + decay + 0.02);
}

/** Desert valley echoes of a shot: delay after the shot s, level, low-pass cutoff Hz (duller each time). */
const SHOT_ECHOES: ReadonlyArray<{ delay: number; level: number; cutoff: number }> = [
  { delay: 0.28, level: 0.3, cutoff: 2600 },
  { delay: 0.55, level: 0.2, cutoff: 1500 },
  { delay: 0.9, level: 0.11, cutoff: 900 },
];

/** One echo: a soft, low-passed rumble with a slow attack, nothing like the sharp original. */
function echo(s: Stage, t: number, level: number, cutoff: number): void {
  noiseBurst(s, t, [{ type: 'lowpass', freq: cutoff }], level * 2, 0.025, 0.3);
  tone(s, 'sine', t, 80, 45, 0.3, level * 0.8, 0.03, 0.3);
}

/** Fallback shot: sharp muzzle blast (crack, noisy body with a boosted low end, low boom) and a ~1.2 s echo tail. */
function synthShot(s: Stage): void {
  const t = s.t;
  noiseBurst(s, t, [{ type: 'highpass', freq: 1800 }], 0.6, 0.002, 0.035); // crack
  noiseBurst(
    s,
    t,
    [
      { type: 'lowshelf', freq: 400, gainDb: 12 },
      { type: 'lowpass', freq: 7000 },
    ],
    1.2,
    0.005,
    0.12,
  ); // body
  tone(s, 'sine', t, 120, 40, 0.25, 1, 0.004, 0.25); // boom
  tone(s, 'triangle', t, 200, 70, 0.1, 0.35, 0.002, 0.1); // punch
  for (const reflection of SHOT_ECHOES) echo(s, t + reflection.delay, reflection.level, reflection.cutoff);
}

/** The shot of `rifleId` (a real rifle with its own outdoor echo tail), pitch varied a little each time. */
export function playShot(e: AudioEngine, rifleId: Rifle['id'] = '308'): void {
  const s = stage(e);
  if (!s) return;
  recordingOrSynth(
    e,
    shotClipId(rifleId),
    (clip) => playClip(s, clip, { level: LEVELS.shot, rate: jitterRate(SHOT_RATE_SPREAD) }),
    () => synthShot(s),
  );
}

/** Fallback hit: dull thwack of a bullet striking the target, `distanceM` away. */
function synthImpactHit(s: Stage, distanceM: number): void {
  const level = IMPACT_LEVEL * distanceGain(distanceM);
  const cutoff = distanceCutoffHz(distanceM);
  noiseBurst(
    s,
    s.t,
    [
      { type: 'bandpass', freq: 520, q: 0.7 },
      { type: 'lowpass', freq: cutoff },
    ],
    level,
    0.002,
    0.16,
  );
  tone(s, 'sine', s.t, 150, 65, 0.14, level * 0.25, 0.002, 0.18);
}

/** Bullet striking the target `distanceM` away, heard `delaySec` later: quieter and duller with range. */
export function playImpactHit(e: AudioEngine, delaySec: number, distanceM: number): void {
  const s = stage(e, delaySec);
  if (!s) return;
  recordingOrSynth(
    e,
    'impact_hit',
    (clip) =>
      playClip(s, clip, {
        level: LEVELS.impactHit * impactGain(distanceM),
        rate: jitterRate(IMPACT_RATE_SPREAD),
        cutoff: distanceCutoffHz(distanceM),
      }),
    () => synthImpactHit(s, distanceM),
  );
}

/** Fallback dust: soft airy thud of a bullet striking sand, `distanceM` away, no sharp edge. */
function synthImpactDust(s: Stage, distanceM: number): void {
  const level = IMPACT_LEVEL * distanceGain(distanceM) * 0.5;
  const cutoff = Math.min(1600, distanceCutoffHz(distanceM));
  noiseBurst(
    s,
    s.t,
    [
      { type: 'bandpass', freq: 380, q: 0.5 },
      { type: 'lowpass', freq: cutoff },
    ],
    level,
    0.012,
    0.3,
  );
  tone(s, 'sine', s.t, 90, 50, 0.2, level * 0.12, 0.01, 0.22);
}

/** Bullet striking the ground `distanceM` away, heard `delaySec` later: softer than a hit, same distance treatment. */
export function playImpactDust(e: AudioEngine, delaySec: number, distanceM: number): void {
  const s = stage(e, delaySec);
  if (!s) return;
  recordingOrSynth(
    e,
    'impact_dust',
    (clip) =>
      playClip(s, clip, {
        level: LEVELS.impactDust * impactGain(distanceM),
        rate: jitterRate(IMPACT_RATE_SPREAD),
        cutoff: distanceCutoffHz(distanceM),
      }),
    () => synthImpactDust(s, distanceM),
  );
}

/** Fallback metal ping: a bright click and a short ringing tone, `distanceM` away. */
function synthImpactMetal(s: Stage, distanceM: number): void {
  const level = distanceGain(distanceM) * IMPACT_LEVEL * 0.25;
  metalClick(s, s.t, 2300, level);
  tone(s, 'sine', s.t, 1500, 1350, 0.12, level * 0.5, 0.001, 0.14);
}

/**
 * Bullet striking metal (a vehicle body or engine) `distanceM` away, heard `delaySec` later: the hit
 * recording pitched up into a ping (no extra recording), with the same distance treatment as the others.
 */
export function playImpactMetal(e: AudioEngine, delaySec: number, distanceM: number): void {
  const s = stage(e, delaySec);
  if (!s) return;
  recordingOrSynth(
    e,
    'impact_hit',
    (clip) =>
      playClip(s, clip, {
        level: LEVELS.impactMetal * impactGain(distanceM),
        rate: METAL_PITCH * jitterRate(IMPACT_RATE_SPREAD),
        cutoff: Math.min(8000, distanceCutoffHz(distanceM) * 1.5),
      }),
    () => synthImpactMetal(s, distanceM),
  );
}

/** A small metallic click: a short burst of bright noise plus a faint resonant ping at `pitch` Hz. */
function metalClick(s: Stage, t: number, pitch: number, level: number): void {
  noiseBurst(
    s,
    t,
    [
      { type: 'highpass', freq: 1200 },
      { type: 'bandpass', freq: pitch * 1.5, q: 2.5 },
    ],
    level * 3,
    0.001,
    0.015,
  );
  tone(s, 'sine', t, pitch, pitch * 0.97, 0.08, level * 0.35, 0.001, 0.08);
}

/** A dull low knock, for the heavier parts of the action (magazine seating, bolt closing). */
function knock(s: Stage, t: number, level: number): void {
  noiseBurst(s, t, [{ type: 'lowpass', freq: 900 }], level * 1.5, 0.001, 0.03);
  tone(s, 'sine', t, 220, 110, 0.05, level * 0.6, 0.001, 0.06);
}

/** Fallback bolt: lift-and-pull click, then a slightly lower push-and-close click 0.25 s later. */
function synthBoltCycle(s: Stage): void {
  metalClick(s, s.t, 2600, 0.16);
  metalClick(s, s.t + BOLT_CLICK_GAP_S, 1900, 0.22);
  knock(s, s.t + BOLT_CLICK_GAP_S, 0.1);
}

/**
 * Working the bolt (real bolt-action clicks), starting 0.25 s after the call, i.e. just after the shot's
 * blast. `cycleSec` is how long after the call the rifle is ready again (the bolt lockout): the
 * ~1.7 s recording is sped up (at most 1.25x) and faded out so it ends then, never over the next shot.
 */
export function playBoltCycle(e: AudioEngine, cycleSec = DEFAULT_BOLT_CYCLE_S): void {
  const s = stage(e, BOLT_DELAY_S);
  if (!s) return;
  const cycle = Number.isFinite(cycleSec) ? cycleSec : DEFAULT_BOLT_CYCLE_S;
  const span = Math.max(0.1, cycle - BOLT_DELAY_S);
  recordingOrSynth(
    e,
    'bolt_cycle',
    (clip) => playClip(s, clip, { level: LEVELS.bolt, rate: fitRate(clip.length, span), maxSec: span }),
    () => synthBoltCycle(s),
  );
}

/** Fallback reload: magazine out, magazine in, bolt: four clicks spread over `span` s. */
function synthReload(s: Stage, span: number): void {
  metalClick(s, s.t + 0.03 * span, 1500, 0.18); // release catch
  knock(s, s.t + 0.25 * span, 0.09); // magazine drops out
  knock(s, s.t + 0.62 * span, 0.14); // new magazine seats
  metalClick(s, s.t + 0.63 * span, 2100, 0.14);
  metalClick(s, s.t + 0.88 * span, 2400, 0.18); // bolt closes
}

/**
 * Magazine out, magazine in, bolt, fitted to the reload (`durationSec`, default 1.5 s): the recording
 * is sped up or slowed down a little to last that long, and cut off with a short fade if still longer.
 */
export function playReload(e: AudioEngine, durationSec = 1.5): void {
  const s = stage(e);
  if (!s) return;
  const span = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 1.5;
  recordingOrSynth(
    e,
    'reload',
    (clip) => playClip(s, clip, { level: LEVELS.reload, rate: fitRate(clip.length, span), maxSec: span }),
    () => synthReload(s, span),
  );
}

/** Fallback dry fire: the dull click of pulling the trigger on an empty magazine. */
function synthDryFire(s: Stage): void {
  noiseBurst(
    s,
    s.t,
    [
      { type: 'highpass', freq: 400 },
      { type: 'lowpass', freq: 1800 },
    ],
    0.5,
    0.001,
    0.02,
  );
  tone(s, 'sine', s.t, 200, 120, 0.03, 0.15, 0.001, 0.04);
}

/** The click of pulling the trigger on an empty magazine. */
export function playDryFire(e: AudioEngine): void {
  const s = stage(e);
  if (!s) return;
  recordingOrSynth(
    e,
    'dry_fire',
    (clip) => playClip(s, clip, { level: LEVELS.dryFire }),
    () => synthDryFire(s),
  );
}

/**
 * Looping wind: shared noise through band and low-pass filters, with a slow swell on its level and a
 * slow drift of its pitch. `gain` is 0..1 (see `windAmbienceGain`); calling again just changes the
 * level. It keeps running while muted (the master gain silences it) so unmuting brings it back.
 */
export function startWindAmbience(e: AudioEngine, gain: number): void {
  const { ctx, bus, noise } = e;
  if (!ctx || !bus || !noise) return;
  const level = Number.isFinite(gain) ? Math.min(1, Math.max(0, gain)) * WIND_MAKEUP : 0;
  if (e.windLevel) {
    e.windLevel.gain.setTargetAtTime(level, ctx.currentTime, 0.3);
    return;
  }
  if (level <= 0) return;

  const source = ctx.createBufferSource();
  source.buffer = noise;
  source.loop = true;
  source.playbackRate.value = 0.85;

  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = 400;
  band.Q.value = 0.6;
  const soften = ctx.createBiquadFilter();
  soften.type = 'lowpass';
  soften.frequency.value = 900;

  // swell: 0.65 + 0.3 * sine(0.17 Hz); levelNode scales the whole thing.
  const swell = ctx.createGain();
  swell.gain.value = 0.65;
  const swellLfo = ctx.createOscillator();
  swellLfo.frequency.value = 0.17;
  const swellDepth = ctx.createGain();
  swellDepth.gain.value = 0.3;
  swellLfo.connect(swellDepth);
  swellDepth.connect(swell.gain);

  // drift: the band's centre wanders +-150 Hz at 0.11 Hz.
  const driftLfo = ctx.createOscillator();
  driftLfo.frequency.value = 0.11;
  const driftDepth = ctx.createGain();
  driftDepth.gain.value = 150;
  driftLfo.connect(driftDepth);
  driftDepth.connect(band.frequency);

  const levelNode = ctx.createGain();
  levelNode.gain.value = level;

  source.connect(band);
  band.connect(soften);
  soften.connect(swell);
  swell.connect(levelNode);
  levelNode.connect(bus);

  source.start(0, Math.random() * noise.duration);
  swellLfo.start();
  driftLfo.start();
  e.windLevel = levelNode;
}
