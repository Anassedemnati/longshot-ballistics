import { RIFLES } from '../ballistics/rifles';
import { MISSION_LIMITS, clampMission, encodeMission } from '../mission/config';
import type { Density, FiringPosition, MissionConfig, Objective } from '../mission/config';
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

/** The line under the firing position control: what the player sees from each position (spec B.2). Theme-neutral: it reads the same in every theme. */
const POSITION_NOTE: Record<FiringPosition, string> = {
  valley: 'Valley floor. A near-level sightline downrange.',
  ridge: 'Elevated ridge. A clear view into the valley below.',
  mountain: 'Steep rocky spur. A pronounced downhill shot into the basin.',
};

export function positionNote(position: FiringPosition): string {
  return POSITION_NOTE[position];
}

/** "2 snipers", "1 sniper", or "0 · training" (no incoming fire at all). */
export function snipersLabel(count: number): string {
  if (count === 0) return '0 · training';
  return count === 1 ? '1 sniper' : `${count} snipers`;
}

/** Under the enemy snipers slider: what the bottom of the scale means. */
export const SNIPERS_NOTE = '0 = training, no incoming fire';
/** Under the suppressor switch (spec B.3: quieter, no flash, slower detection). */
export const SUPPRESSOR_NOTE = 'Reduced noise / flash, slower detection';
/** Under the ghillie suit switch (one line: the gear panel has no room for a third two-line note): hidden until the first shot. */
export const GHILLIE_NOTE = 'Hard to spot until you fire.';
/**
 * Under the "Soldiers fight back" switch, which sits right under the Soldiers slider: one line (the targets panel has no room for a second; the
 * menu must still fit 1280x720), and it points at the slider that sets how many of them there are. What they do is in the README.
 */
export const FIGHT_BACK_NOTE = 'Shoot back. Count: slider above.';
/** The objective control's two options, and the one-line note under each (28 characters at most: one line of the panel). */
export const OBJECTIVE_OPTIONS: ReadonlyArray<{ value: Objective; label: string }> = [
  { value: 'clear', label: 'Clear the area' },
  { value: 'hvt', label: 'High-value target' },
];
const OBJECTIVE_NOTE: Record<Objective, string> = {
  clear: 'Take down every target.',
  hvt: 'Officer flees when alarmed.',
};
export function objectiveNote(objective: Objective): string {
  return OBJECTIVE_NOTE[objective];
}

/** Under the aim assists switch (spec B.5). */
export const ASSISTS_NOTE = 'Trajectory, aim marker and spotter — training aid';

/** What each rifle is, as the concept art captions it. */
export function rifleTitle(rifle: MissionConfig['rifle']): string {
  return rifle === '308' ? 'Compact precision rifle' : 'Long-range precision rifle';
}

/** How many buildings / scenery vehicles a density gives (spec A.4; the layout draws a count in this range). */
const PROP_COUNT_TEXT = {
  buildings: { none: 'no buildings', few: '3–5 buildings', many: '8–12 buildings' },
  vehicles: { none: 'no vehicles', few: '2–3 vehicles', many: '5–7 vehicles' },
} as const;

export function densityNote(kind: 'buildings' | 'vehicles', density: Density): string {
  return PROP_COUNT_TEXT[kind][density];
}

// --- Rifle concept art ------------------------------------------------------------------------
// `public/references/rifle-concept.png` shows both rifles side by side (.308 olive on top, .338 sand below it). The
// menu cuts one rifle out of it in the browser: the picture sits in an `overflow: hidden` box and is scaled and
// shifted by percentages, so no second image file is needed.

/** Size of the concept art, px. */
export const RIFLE_ART_IMAGE = { w: 1672, h: 941 } as const;

/** A rectangle of the concept art, px. */
export interface ArtCrop {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where each rifle sits in the art: the stock, receiver and scope of each (the long barrels are cut so the rifle
 * fills the box), picked so the other rifle and the picture's captions stay out. Both are 3.1:1.
 */
export const RIFLE_ART: Record<MissionConfig['rifle'], ArtCrop> = {
  '308': { x: 52, y: 0, w: 790, h: 255 },
  '338': { x: 22, y: 248, w: 900, h: 290 },
  // The heavier calibres have no art of their own yet: they borrow the long rifle's.
  '300': { x: 52, y: 0, w: 790, h: 255 },
  '408': { x: 22, y: 248, w: 900, h: 290 },
  '50': { x: 22, y: 248, w: 900, h: 290 },
  '127': { x: 22, y: 248, w: 900, h: 290 },
  '127s': { x: 52, y: 0, w: 790, h: 255 },
};

/** CSS numbers that make a box of `aspect` (width / height) show only `crop` of the art. Percentages of the box. */
export interface ArtStyle {
  aspect: number;
  /** Width of the whole picture, % of the box width. */
  widthPct: number;
  /** `left` of the picture, % of the box width (<= 0). */
  leftPct: number;
  /** `top` of the picture, % of the box height (<= 0). */
  topPct: number;
}

export function rifleArtStyle(crop: ArtCrop): ArtStyle {
  return {
    aspect: crop.w / crop.h,
    widthPct: (RIFLE_ART_IMAGE.w / crop.w) * 100,
    leftPct: (-crop.x / crop.w) * 100 + 0, // + 0: no -0 for a crop at the edge
    topPct: (-crop.y / crop.h) * 100 + 0,
  };
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

/**
 * `location.search` of the menu pre-filled with `config` (read back through `?last=`), keeping `debug=1`
 * when the page had it. Used wherever the player leaves for the menu without losing the settings:
 * Back from a mission (the menu rewrites its own history entry with it), the results screen's Menu
 * button and the mission HUD's Menu link.
 */
export function menuSearch(config: Partial<MissionConfig>, debug: boolean): string {
  return `?last=${encodeMission(clampMission(config))}${debug ? '&debug=1' : ''}`;
}
