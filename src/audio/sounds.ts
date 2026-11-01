import type { AudioEngine } from './engine';
import { distanceCutoffHz, distanceGain } from './timing';

// Synthesis recipes. Every sound is noise bursts, sine/triangle sweeps, filters and envelopes
// scheduled on the audio clock, never with timers. Each public function returns silently when there
// is no running context (no user gesture yet) or the engine is muted.

/** Envelope floor: an exponential ramp cannot reach 0, and -80 dB is inaudible. */
const SILENCE = 1e-4;
/** Seconds after a shot before the bolt is worked. */
const BOLT_DELAY_S = 0.6;
/** Gap between the two bolt clicks, s. */
const BOLT_CLICK_GAP_S = 0.25;
/** Level of an impact heard from right next to it (distanceGain = 1); real impacts are quieter. */
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

/** Sharp muzzle blast (crack, noisy body with a boosted low end, low boom) and a ~1.2 s echo tail. */
export function playShot(e: AudioEngine): void {
  const s = stage(e);
  if (!s) return;
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

/** Dull thwack of a bullet striking the target, `distanceM` away: quieter and duller with range. */
export function playImpactHit(e: AudioEngine, delaySec: number, distanceM: number): void {
  const s = stage(e, delaySec);
  if (!s) return;
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

/** Soft airy thud of a bullet striking sand, `distanceM` away: quieter than a hit, no sharp edge. */
export function playImpactDust(e: AudioEngine, delaySec: number, distanceM: number): void {
  const s = stage(e, delaySec);
  if (!s) return;
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

/** Working the bolt: lift-and-pull click, then a slightly lower push-and-close click 0.25 s later. */
export function playBoltCycle(e: AudioEngine): void {
  const s = stage(e, BOLT_DELAY_S);
  if (!s) return;
  metalClick(s, s.t, 2600, 0.16);
  metalClick(s, s.t + BOLT_CLICK_GAP_S, 1900, 0.22);
  knock(s, s.t + BOLT_CLICK_GAP_S, 0.1);
}

/** Magazine out, magazine in, bolt: four clicks spread over the reload (`durationSec`, default 1.5 s). */
export function playReload(e: AudioEngine, durationSec = 1.5): void {
  const s = stage(e);
  if (!s) return;
  const span = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 1.5;
  metalClick(s, s.t + 0.03 * span, 1500, 0.18); // release catch
  knock(s, s.t + 0.25 * span, 0.09); // magazine drops out
  knock(s, s.t + 0.62 * span, 0.14); // new magazine seats
  metalClick(s, s.t + 0.63 * span, 2100, 0.14);
  metalClick(s, s.t + 0.88 * span, 2400, 0.18); // bolt closes
}

/** The dull click of pulling the trigger on an empty magazine. */
export function playDryFire(e: AudioEngine): void {
  const s = stage(e);
  if (!s) return;
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
