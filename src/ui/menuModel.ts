import { RIFLES } from '../ballistics/rifles';
import { MISSION_LIMITS, clampMission, encodeMission } from '../mission/config';
import type { Density, MissionConfig } from '../mission/config';
import { THEMES } from '../mission/themes';
import type { ThemeId } from '../mission/themes';

// Pure helpers of the start menu (no DOM, no `three`): range-band linking, labels, wind dial geometry
// and the URL a mission starts from. `src/ui/menu.ts` builds the DOM on top of these.

/** Step of the range sliders, m. */
export const RANGE_STEP_M = 10;
/** Step of the wind speed slider, m/s. */
export const WIND_STEP_MPS = 0.5;
const MPS_TO_MPH = 2.2369362920544;

/** A nearest/farthest distance pair, m. */
export interface RangeBand {
  min: number;
  max: number;
}

/**
 * The band after one slider moved to `value`: the moved end takes the (clamped) value and pushes the
 * other end along when it would cross it, so min <= max always holds. The end that was not touched
 * keeps its exact value.
 */
export function linkRange(band: RangeBand, moved: 'min' | 'max', value: number): RangeBand {
  const { rangeMin: lo, rangeMax: hi } = MISSION_LIMITS;
  const v = Math.min(hi, Math.max(lo, Number.isFinite(value) ? Math.round(value) : band[moved]));
  return moved === 'min' ? { min: v, max: Math.max(v, band.max) } : { min: Math.min(v, band.min), max: v };
}

/** "600–1000 m", or just "800 m" when both ends are equal (every soldier at one range). */
export function rangeLabel(band: RangeBand): string {
  return band.min === band.max ? `${band.min} m` : `${band.min}–${band.max} m`;
}

export function mpsToMph(mps: number): number {
  return mps * MPS_TO_MPH;
}

/** "4.5 m/s · 10 mph". */
export function windSpeedLabel(mps: number): string {
  return `${mps.toFixed(1)} m/s · ${Math.round(mpsToMph(mps))} mph`;
}

/** "−15 °C · dense air": the line under a theme card. */
export function themeBlurb(id: ThemeId): string {
  const t = THEMES[id];
  const temp = `${t.airTempC < 0 ? '−' : ''}${Math.abs(t.airTempC)} °C`;
  const air = { desert: 'thin air', arctic: 'dense air', valley: `${t.airPressureHPa} hPa` }[id];
  return `${temp} · ${air}`;
}

/** "G7 BC 0.243 · 790 m/s": the line under the rifle toggle. */
export function rifleNote(rifle: MissionConfig['rifle']): string {
  const r = RIFLES[rifle];
  return `G7 BC ${r.bcG7} · ${r.muzzleVelocity} m/s`;
}

/** How many buildings / scenery vehicles a density gives (spec A.4; the layout draws a count in this range). */
const PROP_COUNT_TEXT = {
  buildings: { none: 'no buildings', few: '3–5 buildings', many: '8–12 buildings' },
  vehicles: { none: 'no vehicles', few: '2–3 vehicles', many: '5–7 vehicles' },
} as const;

export function densityNote(kind: 'buildings' | 'vehicles', density: Density): string {
  return PROP_COUNT_TEXT[kind][density];
}

// --- Wind dial -------------------------------------------------------------------------------
// Seen from above with downrange up: 12 o'clock is at the top, 3 on the right. Screen coordinates
// (x right, y down), the shooter at the centre.

/** Round away floating-point dust (and -0) so 90 deg gives exactly 1 and 0. */
function tidy(v: number): number {
  return Math.round(v * 1e6) / 1e6 + 0;
}

/** Where a clock position sits on a circle of `radius` around the centre of the dial. */
export function clockPoint(clock: number, radius: number): { x: number; y: number } {
  const theta = (clock * 30 * Math.PI) / 180;
  return { x: tidy(radius * Math.sin(theta)), y: tidy(-radius * Math.cos(theta)) };
}

/**
 * Unit vector, on the dial, along which the wind blows when it comes from `clock`: from that position
 * toward the centre and past it. Equals (x, z) of `windVector` (z points toward the shooter, so down on the dial).
 */
export function windArrowDir(clock: number): { x: number; y: number } {
  const theta = (clock * 30 * Math.PI) / 180;
  return { x: tidy(-Math.sin(theta)), y: tidy(Math.cos(theta)) };
}

/** The clock position `delta` steps on (positive = clockwise), wrapped into 1..12. */
export function stepClock(clock: number, delta: number): number {
  return ((((Math.round(clock) + Math.round(delta) - 1) % 12) + 12) % 12) + 1;
}

// --- Starting -------------------------------------------------------------------------------

/** The seed of a new mission from 32 random bits: never 0 (0 is not a seed worth showing in a URL). */
export function seedFromBits(bits: number): number {
  return (bits >>> 0) || 1;
}

/** `location.search` that starts the mission with this seed, keeping `debug=1` when the menu had it. */
export function startSearch(config: Partial<MissionConfig>, seed: number, debug: boolean): string {
  return `?m=${encodeMission(clampMission({ ...config, seed }))}${debug ? '&debug=1' : ''}`;
}
