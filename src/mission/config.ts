import type { Vec3 } from '../ballistics/types';
import { randInt } from './random';
import type { Rng } from './random';
import type { ThemeId } from './themes';

export type Density = 'none' | 'few' | 'many';

/** Everything the start menu configures for one mission (spec A.2), plus the layout seed. */
export interface MissionConfig {
  theme: ThemeId;
  /** Nearest target distance, m. */
  rangeMin: number;
  /** Farthest target distance, m. */
  rangeMax: number;
  soldiers: number;
  vehicleTargets: number;
  /** m/s, 0.1 steps. */
  windSpeedMps: number;
  /** Clock position the wind blows from, 1..12 (12 = headwind, 3 = from the right, 9 = from the left). */
  windClock: number;
  rifle: '308' | '338';
  buildings: Density;
  vehicles: Density;
  /** Unsigned 32-bit integer; the same config + seed gives the same layout. */
  seed: number;
}

export const MISSION_LIMITS = {
  rangeMin: 100,
  rangeMax: 1500,
  soldiersMin: 1,
  soldiersMax: 10,
  vehicleTargetsMax: 3,
  windMaxMps: 12,
} as const;

export const DEFAULT_MISSION: MissionConfig = {
  theme: 'desert',
  rangeMin: 600,
  rangeMax: 1000,
  soldiers: 3,
  vehicleTargets: 0,
  windSpeedMps: 4.5,
  windClock: 9,
  rifle: '308',
  buildings: 'few',
  vehicles: 'few',
  seed: 1,
};

const THEME_IDS: readonly ThemeId[] = ['desert', 'arctic', 'valley'];
const RIFLES: readonly MissionConfig['rifle'][] = ['308', '338'];
const DENSITIES: readonly Density[] = ['none', 'few', 'many'];

/** The value if it is a finite number, otherwise the fallback. */
function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** The value if it is one of the allowed options, otherwise the fallback. */
function oneOf<T extends string>(v: unknown, options: readonly T[], fallback: T): T {
  return options.find((o) => o === v) ?? fallback;
}

/** Wrap any integer clock position into 1..12. */
function wrapClock(n: number): number {
  return ((((n - 1) % 12) + 12) % 12) + 1;
}

/**
 * Fill defaults, clamp to the menu limits and quantise (integer metres and counts, 0.1 m/s wind,
 * integer clock wrapped into 1..12, uint32 seed). Bad values fall back to the defaults, never NaN.
 * Idempotent: clampMission(clampMission(x)) equals clampMission(x).
 */
export function clampMission(c: Partial<MissionConfig>): MissionConfig {
  const d = DEFAULT_MISSION;
  const L = MISSION_LIMITS;

  let lo = Math.round(num(c.rangeMin, d.rangeMin));
  let hi = Math.round(num(c.rangeMax, d.rangeMax));
  if (lo > hi) [lo, hi] = [hi, lo];

  return {
    theme: oneOf(c.theme, THEME_IDS, d.theme),
    rangeMin: Math.min(L.rangeMax, Math.max(L.rangeMin, lo)),
    rangeMax: Math.min(L.rangeMax, Math.max(L.rangeMin, hi)),
    soldiers: Math.min(L.soldiersMax, Math.max(L.soldiersMin, Math.round(num(c.soldiers, d.soldiers)))),
    vehicleTargets: Math.min(L.vehicleTargetsMax, Math.max(0, Math.round(num(c.vehicleTargets, d.vehicleTargets)))),
    windSpeedMps: Math.min(L.windMaxMps, Math.max(0, Math.round(num(c.windSpeedMps, d.windSpeedMps) * 10) / 10)),
    windClock: wrapClock(Math.round(num(c.windClock, d.windClock))),
    rifle: oneOf(c.rifle, RIFLES, d.rifle),
    buildings: oneOf(c.buildings, DENSITIES, d.buildings),
    vehicles: oneOf(c.vehicles, DENSITIES, d.vehicles),
    seed: Math.floor(num(c.seed, d.seed)) >>> 0,
  };
}

// --- URL codec -------------------------------------------------------------------------------
// Format: `v1.<theme>.<rangeMin>.<rangeMax>.<soldiers>.<vehicleTargets>.<windTenths>.<clock>.<rifle>.<buildings>.<vehicles>.<seed>`
// e.g. `v1.d.600.1000.3.0.45.9.308.f.f.1`. Letters, digits and dots only, so it is safe in a URL unescaped.

const CODEC_VERSION = 'v1';
const THEME_CODE: Record<ThemeId, string> = { desert: 'd', arctic: 'a', valley: 'v' };
const DENSITY_CODE: Record<Density, string> = { none: 'n', few: 'f', many: 'm' };
const FIELD_COUNT = 11;

/** Reverse lookup of a one-letter code; undefined for anything unknown. */
function fromCode<T extends string>(table: Record<T, string>, code: string): T | undefined {
  return (Object.keys(table) as T[]).find((k) => table[k] === code);
}

/** A finite number from a field, or undefined for an empty or non-numeric field. */
function field(raw: string): number | undefined {
  if (raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Compact, URL-safe, versioned text for a mission. */
export function encodeMission(c: MissionConfig): string {
  const m = clampMission(c);
  return [
    CODEC_VERSION,
    THEME_CODE[m.theme],
    m.rangeMin,
    m.rangeMax,
    m.soldiers,
    m.vehicleTargets,
    Math.round(m.windSpeedMps * 10),
    m.windClock,
    m.rifle,
    DENSITY_CODE[m.buildings],
    DENSITY_CODE[m.vehicles],
    m.seed,
  ].join('.');
}

/** The mission an `encodeMission` string describes (clamped), or null if it cannot be read. Never throws. */
export function decodeMission(s: string): MissionConfig | null {
  if (typeof s !== 'string') return null;
  const parts = s.split('.');
  if (parts.length !== FIELD_COUNT + 1 || parts[0] !== CODEC_VERSION) return null;
  const [, theme, rangeMin, rangeMax, soldiers, vehicleTargets, windTenths, clock, rifle, buildings, vehicles, seed] =
    parts as [string, string, string, string, string, string, string, string, string, string, string, string];

  const wind = field(windTenths);
  return clampMission({
    theme: fromCode(THEME_CODE, theme),
    rangeMin: field(rangeMin),
    rangeMax: field(rangeMax),
    soldiers: field(soldiers),
    vehicleTargets: field(vehicleTargets),
    windSpeedMps: wind === undefined ? undefined : wind / 10,
    windClock: field(clock),
    rifle: rifle === '308' || rifle === '338' ? rifle : undefined,
    buildings: fromCode(DENSITY_CODE, buildings),
    vehicles: fromCode(DENSITY_CODE, vehicles),
    seed: field(seed),
  });
}

/** A fully random mission (new seed included), drawn only from `rng`. */
export function randomMission(rng: Rng): MissionConfig {
  const a = randInt(rng, MISSION_LIMITS.rangeMin, MISSION_LIMITS.rangeMax);
  const b = randInt(rng, MISSION_LIMITS.rangeMin, MISSION_LIMITS.rangeMax);
  return clampMission({
    theme: THEME_IDS[randInt(rng, 0, THEME_IDS.length - 1)],
    rangeMin: Math.min(a, b),
    rangeMax: Math.max(a, b),
    soldiers: randInt(rng, MISSION_LIMITS.soldiersMin, MISSION_LIMITS.soldiersMax),
    vehicleTargets: randInt(rng, 0, MISSION_LIMITS.vehicleTargetsMax),
    windSpeedMps: randInt(rng, 0, MISSION_LIMITS.windMaxMps * 10) / 10,
    windClock: randInt(rng, 1, 12),
    rifle: RIFLES[randInt(rng, 0, RIFLES.length - 1)],
    buildings: DENSITIES[randInt(rng, 0, DENSITIES.length - 1)],
    vehicles: DENSITIES[randInt(rng, 0, DENSITIES.length - 1)],
    seed: randInt(rng, 1, 0xffffffff),
  });
}

// --- Wind clock ------------------------------------------------------------------------------

/**
 * Air velocity (world frame, m/s) for wind blowing from a clock position: 12 = from downrange
 * (air moves toward +Z), 3 = from the right (toward -X), 6 = from behind (toward -Z),
 * 9 = from the left (toward +X). Vector = speed * (-sin t, 0, cos t), t = clock * 30 deg.
 */
export function windVector(speedMps: number, clock: number): Vec3 {
  const theta = (clock * 30 * Math.PI) / 180;
  return { x: -speedMps * Math.sin(theta), y: 0, z: speedMps * Math.cos(theta) };
}

const CLOCK_SIDE = [
  'downrange', // 12
  'front right', // 1
  'front right', // 2
  'right', // 3
  'rear right', // 4
  'rear right', // 5
  'behind', // 6
  'rear left', // 7
  'rear left', // 8
  'left', // 9
  'front left', // 10
  'front left', // 11
] as const;

/** Human label for a clock position, e.g. "from 9 o'clock (left)". Out-of-range values wrap. */
export function windClockLabel(clock: number): string {
  const c = wrapClock(Math.round(clock));
  return `from ${c} o'clock (${CLOCK_SIDE[c % 12]})`;
}

// --- Routing ---------------------------------------------------------------------------------

export type Route =
  | { kind: 'menu'; last: MissionConfig | null }
  | { kind: 'mission'; config: MissionConfig; legacy: boolean; debug: boolean };

/** Wind from the old `?wind=` (m/s, positive = from the left) when absent or unreadable: 10 mph. */
const LEGACY_WIND_MPS = 4.4704;
const LEGACY_RANGE_M = 800;

/** The mission a legacy `?range=&wind=&rifle=&air=` URL stands for: one soldier, no props, desert. */
function legacyMission(params: URLSearchParams): MissionConfig {
  const range = field(params.get('range') ?? '') ?? LEGACY_RANGE_M;
  const wind = field(params.get('wind') ?? '') ?? LEGACY_WIND_MPS;
  const rifle = params.get('rifle');
  return clampMission({
    theme: 'desert', // the legacy scene is the desert, desert air included: a legacy `?air=` stays ignored by ruling and does not select a theme
    rangeMin: range,
    rangeMax: range,
    soldiers: 1,
    vehicleTargets: 0,
    windSpeedMps: Math.abs(wind),
    windClock: wind < 0 ? 3 : 9,
    rifle: rifle === '308' || rifle === '338' ? rifle : DEFAULT_MISSION.rifle,
    buildings: 'none',
    vehicles: 'none',
    seed: 1,
  });
}

/** Decide between the menu and a mission from `location.search`. Never throws. */
export function routeFromSearch(search: string): Route {
  const params = new URLSearchParams(search);
  const debug = params.get('debug') === '1';

  const m = decodeMission(params.get('m') ?? '');
  if (m) return { kind: 'mission', config: m, legacy: false, debug };

  if (params.has('range')) return { kind: 'mission', config: legacyMission(params), legacy: true, debug };

  return { kind: 'menu', last: decodeMission(params.get('last') ?? '') };
}
