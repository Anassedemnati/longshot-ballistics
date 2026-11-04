import type { Rifle } from '../ballistics/types';

// Pure helpers for the recorded sounds (no DOM, no Web Audio): which file is which, how to pick the
// shot for a rifle, how to vary and fit playback. Decoding and playing live in samples.ts / sounds.ts.

/** Every recording, by id. */
export type ClipId =
  | 'shot_308'
  | 'shot_338'
  | 'impact_hit'
  | 'impact_dust'
  | 'bolt_cycle'
  | 'reload'
  | 'dry_fire';

/** File name of each recording in public/sounds/. */
export const CLIP_FILES: Readonly<Record<ClipId, string>> = {
  shot_308: 'shot_308.mp3',
  shot_338: 'shot_338.mp3',
  impact_hit: 'impact_hit.mp3',
  impact_dust: 'impact_dust.mp3',
  bolt_cycle: 'bolt_cycle.mp3',
  reload: 'reload.mp3',
  dry_fire: 'dry_fire.mp3',
};

/** Lead-in kept before the first audible sample so the attack is not clipped, s. */
const LEAD_IN_S = 0.003;
/** Tail kept after the last audible sample, s. */
const TAIL_S = 0.02;
/** Amplitude below which a sample counts as silence (-40 dBFS). */
const AUDIBLE_THRESHOLD = 0.01;
/** Slowest and fastest playback `fitRate` will ask for. */
const MIN_FIT_RATE = 0.8;
const MAX_FIT_RATE = 1.25;

/**
 * The recording of a shot from this rifle: the .308's for itself and the subsonic 12.7x55 (a short rifle, its sharp crack all in the
 * can), the .338's deeper magnum report for the .338 and every heavier calibre, which `SHOT_PROFILE` then pitches down and fattens.
 */
export function shotClipId(rifleId: Rifle['id']): ClipId {
  return rifleId === '308' || rifleId === '127s' ? 'shot_308' : 'shot_338';
}

/** A second, slowed and low-passed copy of the report under the first: the deep boom and long rolling tail of a 12.7 mm round. */
export interface BoomLayer {
  /** Playback rate of the layer (well under 1: an octave down is 0.5). */
  rate: number;
  /** Gain, relative to the shot's. */
  level: number;
  /** Low-pass cutoff, Hz. */
  cutoffHz: number;
}

/**
 * How one rifle's report is made from the two shot recordings (no new files): playback rate (under 1 is deeper and longer), gain
 * relative to LEVELS.shot, a low-shelf boost under 250 Hz for the chest thump of a big case, and, for the 12.7 mm rifles, a boom layer.
 * `suppressed` is the shot through a can, where the profile differs from the plain "quieter and duller" (the 12.7x55's integral one).
 */
export interface ShotProfile {
  rate: number;
  level: number;
  lowShelfDb: number;
  boom?: BoomLayer;
  suppressed?: { rate: number; level: number; cutoffHz: number; lowShelfDb: number };
}

/** Every rifle's report: heavier is deeper and louder, the .50 BMG the deepest, with the longest tail. Tuned by ear. */
export const SHOT_PROFILE: Readonly<Record<Rifle['id'], ShotProfile>> = {
  '308': { rate: 1, level: 1, lowShelfDb: 0 },
  '338': { rate: 1, level: 1, lowShelfDb: 0 },
  '300': { rate: 1.06, level: 1, lowShelfDb: 2 }, // a touch sharper than the .338: a smaller case
  '408': { rate: 0.9, level: 1.1, lowShelfDb: 4 },
  '50': { rate: 0.78, level: 1.2, lowShelfDb: 7, boom: { rate: 0.5, level: 0.65, cutoffHz: 350 } },
  '127': { rate: 0.82, level: 1.15, lowShelfDb: 6, boom: { rate: 0.55, level: 0.5, cutoffHz: 400 } },
  // Never heard open (the can is part of the rifle): through it, a quiet, low "thup" - the .308's crack an octave down, all but the
  // lowest part cut away.
  '127s': { rate: 0.85, level: 1, lowShelfDb: 3, suppressed: { rate: 0.55, level: 0.13, cutoffHz: 420, lowShelfDb: 6 } },
};

/** A playback rate within `spread` of 1, so repeats do not sound identical. `random` is in [0, 1). */
export function jitterRate(spread: number, random: () => number = Math.random): number {
  return 1 + (random() * 2 - 1) * spread;
}

/** Playback rate that makes `audibleSec` of sound last about `targetSec`, kept within 0.8 .. 1.25. */
export function fitRate(audibleSec: number, targetSec: number): number {
  if (!(audibleSec > 0) || !(targetSec > 0) || !Number.isFinite(audibleSec) || !Number.isFinite(targetSec)) return 1;
  return Math.min(MAX_FIT_RATE, Math.max(MIN_FIT_RATE, audibleSec / targetSec));
}

/**
 * Where the sound in a decoded clip really is: `start` is the first audible sample (3 ms of lead-in
 * kept) and `length` runs to the last audible sample plus a 20 ms tail, both in seconds. Skipping the
 * silence at the front of a recording makes the sound start the moment it is played. Null for silence.
 */
export function audibleRange(
  samples: Float32Array,
  sampleRate: number,
): { start: number; length: number } | null {
  let first = -1;
  let last = -1;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]) > AUDIBLE_THRESHOLD) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return null;
  const start = Math.max(0, first / sampleRate - LEAD_IN_S);
  const end = Math.min(samples.length / sampleRate, (last + 1) / sampleRate + TAIL_S);
  return { start, length: end - start };
}
