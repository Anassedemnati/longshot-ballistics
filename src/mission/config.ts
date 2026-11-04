import { RIFLES as RIFLE_DATA } from '../ballistics/rifles';
import type { RifleId, Vec3 } from '../ballistics/types';
import { randInt } from './random';
import type { Rng } from './random';
import type { ThemeId } from './themes';

export type Density = 'none' | 'few' | 'many';

/** Where the shooter lies (spec B.2): the valley floor, a rocky ridge or a mountain overlook. */
export type FiringPosition = 'valley' | 'ridge' | 'mountain';

/** What the mission asks: take down every target (`clear`), or one high-value target, an officer with his bodyguards, before he gets away (`hvt`). */
export type Objective = 'clear' | 'hvt';

/** A military base in the target area (mission/basePlan.ts): none, a small outpost (40 m across) or a full base (80 m across). */
export type BaseOption = 'none' | 'outpost' | 'base';

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
  rifle: RifleId;
  buildings: Density;
  vehicles: Density;
  /** Unsigned 32-bit integer; the same config + seed gives the same layout. */
  seed: number;
  /** Where the shooter lies. */
  position: FiringPosition;
  /** A suppressor on the rifle: quieter shots, no flash, slower detection. */
  suppressed: boolean;
  /** Enemy snipers that fight back, 0 (training, no incoming fire) to 3. */
  enemySnipers: number;
  /** Aim assists (trajectory preview, aim marker, spotter calls) are available. */
  assists: boolean;
  /** Ghillie suit: the enemy can't pick the player out until he fires (see game/encounter.ts); his sleeves wear the theme's camouflage. */
  camo: boolean;
  /**
   * The soldiers fight back (game/squad.ts): once a shot is heard they take cover, change position, find the player a little more with
   * every shot and open fire, and call mortars. Off: the soldiers stand where they were placed, as they always did.
   */
  soldiersFightBack: boolean;
  /** What the mission asks of the player (see `Objective`). */
  objective: Objective;
  /** A military base in the range band, manned by guards who count as targets (see `BaseOption`). */
  base: BaseOption;
}

export const MISSION_LIMITS = {
  rangeMin: 100,
  rangeMax: 1500,
  soldiersMin: 1,
  soldiersMax: 10,
  vehicleTargetsMax: 3,
  windMaxMps: 12,
  enemySnipers: { min: 0, max: 3 },
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
  position: 'ridge',
  suppressed: false,
  enemySnipers: 1,
  assists: false,
  camo: false,
  soldiersFightBack: true,
  objective: 'clear',
  base: 'none',
};

const THEME_IDS: readonly ThemeId[] = ['desert', 'arctic', 'valley'];
const RIFLES: readonly RifleId[] = Object.keys(RIFLE_DATA) as RifleId[];
const DENSITIES: readonly Density[] = ['none', 'few', 'many'];
const POSITIONS: readonly FiringPosition[] = ['valley', 'ridge', 'mountain'];
const OBJECTIVES: readonly Objective[] = ['clear', 'hvt'];
const BASES: readonly BaseOption[] = ['none', 'outpost', 'base'];

/** The value if it is a finite number, otherwise the fallback. */
function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** The value if it is one of the allowed options, otherwise the fallback. */
function oneOf<T extends string>(v: unknown, options: readonly T[], fallback: T): T {
  return options.find((o) => o === v) ?? fallback;
}

/** The value if it is a boolean, otherwise the fallback. */
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/** Wrap any integer clock position into 1..12. */
function wrapClock(n: number): number {
  return ((((n - 1) % 12) + 12) % 12) + 1;
}

/** The farthest a target band may reach with this rifle, m: the menu's limit, or the rifle's own when it is shorter. */
export function rifleMaxRange(rifle: RifleId): number {
  return Math.min(MISSION_LIMITS.rangeMax, RIFLE_DATA[rifle].maxRangeM);
}

/**
 * Fill defaults, clamp to the menu limits and quantise (integer metres and counts, 0.1 m/s wind,
 * integer clock wrapped into 1..12, uint32 seed, 0..3 enemy snipers). Bad values fall back to the defaults, never NaN.
 * The rifle has its say: the band ends at its `maxRangeM`, and one with an integral suppressor is always suppressed.
 * Idempotent: clampMission(clampMission(x)) equals clampMission(x).
 */
export function clampMission(c: Partial<MissionConfig>): MissionConfig {
  const d = DEFAULT_MISSION;
  const L = MISSION_LIMITS;

  let lo = Math.round(num(c.rangeMin, d.rangeMin));
  let hi = Math.round(num(c.rangeMax, d.rangeMax));
  if (lo > hi) [lo, hi] = [hi, lo];
  const rifle = oneOf(c.rifle, RIFLES, d.rifle);
  // The band's far end is the rifle's own limit too (the subsonic 12.7x55 stops at 250 m, see `Rifle.maxRangeM`); both ends are
  // clamped to it, so a band beyond it collapses onto it and min <= max still holds.
  const farthest = rifleMaxRange(rifle);

  return {
    theme: oneOf(c.theme, THEME_IDS, d.theme),
    rangeMin: Math.min(farthest, Math.max(L.rangeMin, lo)),
    rangeMax: Math.min(farthest, Math.max(L.rangeMin, hi)),
    soldiers: Math.min(L.soldiersMax, Math.max(L.soldiersMin, Math.round(num(c.soldiers, d.soldiers)))),
    vehicleTargets: Math.min(L.vehicleTargetsMax, Math.max(0, Math.round(num(c.vehicleTargets, d.vehicleTargets)))),
    windSpeedMps: Math.min(L.windMaxMps, Math.max(0, Math.round(num(c.windSpeedMps, d.windSpeedMps) * 10) / 10)),
    windClock: wrapClock(Math.round(num(c.windClock, d.windClock))),
    rifle,
    buildings: oneOf(c.buildings, DENSITIES, d.buildings),
    vehicles: oneOf(c.vehicles, DENSITIES, d.vehicles),
    seed: Math.floor(num(c.seed, d.seed)) >>> 0,
    position: oneOf(c.position, POSITIONS, d.position),
    // A rifle built round its suppressor (the 12.7x55) is always suppressed, whatever the link or the switch says.
    suppressed: RIFLE_DATA[rifle].integralSuppressor || bool(c.suppressed, d.suppressed),
    enemySnipers: Math.min(
      L.enemySnipers.max,
      Math.max(L.enemySnipers.min, Math.round(num(c.enemySnipers, d.enemySnipers))),
    ),
    assists: bool(c.assists, d.assists),
    camo: bool(c.camo, d.camo),
    soldiersFightBack: bool(c.soldiersFightBack, d.soldiersFightBack),
    objective: oneOf(c.objective, OBJECTIVES, d.objective),
    base: oneOf(c.base, BASES, d.base),
  };
}

// --- URL codec -------------------------------------------------------------------------------
// Format: `v6.<theme>.<rangeMin>.<rangeMax>.<soldiers>.<vehicleTargets>.<windTenths>.<clock>.<rifle>.<buildings>.<vehicles>.<seed>.<position>.<suppressed>.<snipers>.<assists>.<camo>.<fightBack>.<objective>.<base>`
// e.g. `v6.d.600.1000.3.0.45.9.308.f.f.1.r.0.1.0.0.1.c.n`. Letters, digits and dots only, so it is safe in a URL unescaped.
// Older links still decode: `v5.` (the first eighteen fields: no base), `v4.` (the first seventeen fields: clear the area), `v3.` (the first sixteen fields: no fight back), `v2.` (the first fifteen fields, no ghillie suit) and `v1.` (the
// first eleven fields only: ridge, unsuppressed, no enemy snipers, no assists, no ghillie suit). In every older link the soldiers stand still,
// as they did when it was made, whatever the menu's default is today.

const CODEC_VERSION = 'v6';
const V5_CODEC_VERSION = 'v5';
const V4_CODEC_VERSION = 'v4';
const V3_CODEC_VERSION = 'v3';
const V2_CODEC_VERSION = 'v2';
const V1_CODEC_VERSION = 'v1';
const THEME_CODE: Record<ThemeId, string> = { desert: 'd', arctic: 'a', valley: 'v' };
const DENSITY_CODE: Record<Density, string> = { none: 'n', few: 'f', many: 'm' };
const POSITION_CODE: Record<FiringPosition, string> = { valley: 'v', ridge: 'r', mountain: 'm' };
const OBJECTIVE_CODE: Record<Objective, string> = { clear: 'c', hvt: 'h' };
const BASE_CODE: Record<BaseOption, string> = { none: 'n', outpost: 'o', base: 'b' };
/** Fields after the version in a v1 link; a v2 link adds four more, a v3 link one more (the ghillie suit), a v4 link one more again (fight back), a v5 link the objective, a v6 link the base. */
const V1_FIELD_COUNT = 11;
const V2_FIELD_COUNT = 15;
const V3_FIELD_COUNT = 16;
const V4_FIELD_COUNT = 17;
const V5_FIELD_COUNT = 18;
const V6_FIELD_COUNT = 19;

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

/** A 0/1 flag from a field, or undefined for anything else. */
function flag(raw: string): boolean | undefined {
  return raw === '1' ? true : raw === '0' ? false : undefined;
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
    POSITION_CODE[m.position],
    m.suppressed ? 1 : 0,
    m.enemySnipers,
    m.assists ? 1 : 0,
    m.camo ? 1 : 0,
    m.soldiersFightBack ? 1 : 0,
    OBJECTIVE_CODE[m.objective],
    BASE_CODE[m.base],
  ].join('.');
}

/**
 * The mission an `encodeMission` string describes (clamped), or null if it cannot be read. Never throws.
 * Reads the current `v6.` codec and the older `v5.` (no base), `v4.` (clear the area), `v3.` (no fight back), `v2.` (no ghillie suit) and `v1.` (no position, suppressor, snipers,
 * assists or ghillie suit) ones.
 */
export function decodeMission(s: string): MissionConfig | null {
  if (typeof s !== 'string') return null;
  const parts = s.split('.');
  const version = parts[0];
  const fields =
    version === V1_CODEC_VERSION
      ? V1_FIELD_COUNT
      : version === V2_CODEC_VERSION
        ? V2_FIELD_COUNT
        : version === V3_CODEC_VERSION
          ? V3_FIELD_COUNT
          : version === V4_CODEC_VERSION
            ? V4_FIELD_COUNT
            : version === V5_CODEC_VERSION
              ? V5_FIELD_COUNT
              : version === CODEC_VERSION
                ? V6_FIELD_COUNT
                : -1;
  if (fields < 0 || parts.length !== fields + 1) return null;
  const [, theme, rangeMin, rangeMax, soldiers, vehicleTargets, windTenths, clock, rifle, buildings, vehicles, seed, position, suppressed, snipers, assists, camo, fightBack, objective, base] =
    parts as [string, string, string, string, string, string, string, string, string, string, string, string, string?, string?, string?, string?, string?, string?, string?, string?];

  const wind = field(windTenths);
  const common: Partial<MissionConfig> = {
    theme: fromCode(THEME_CODE, theme),
    rangeMin: field(rangeMin),
    rangeMax: field(rangeMax),
    soldiers: field(soldiers),
    vehicleTargets: field(vehicleTargets),
    windSpeedMps: wind === undefined ? undefined : wind / 10,
    windClock: field(clock),
    rifle: RIFLES.find((id) => id === rifle),
    buildings: fromCode(DENSITY_CODE, buildings),
    vehicles: fromCode(DENSITY_CODE, vehicles),
    seed: field(seed),
  };
  if (version === V1_CODEC_VERSION) {
    // A v1 link predates the new options: they are off, whatever today's menu defaults are.
    return clampMission({ ...common, position: 'ridge', suppressed: false, enemySnipers: 0, assists: false, camo: false, soldiersFightBack: false, objective: 'clear', base: 'none' });
  }
  const v4OrLater = version === CODEC_VERSION || version === V5_CODEC_VERSION || version === V4_CODEC_VERSION;
  return clampMission({
    ...common,
    position: fromCode(POSITION_CODE, position ?? ''),
    suppressed: flag(suppressed ?? ''),
    enemySnipers: field(snipers ?? ''),
    assists: flag(assists ?? ''),
    // A v2 link has no ghillie field: no suit.
    camo: v4OrLater || version === V3_CODEC_VERSION ? flag(camo ?? '') : false,
    // A v2 or v3 link has no fight back field: the soldiers stand still, as they did.
    soldiersFightBack: v4OrLater ? flag(fightBack ?? '') : false,
    // Before v5 every mission was "clear the area".
    objective: version === CODEC_VERSION || version === V5_CODEC_VERSION ? fromCode(OBJECTIVE_CODE, objective ?? '') : 'clear',
    // Before v6 no mission had a base.
    base: version === CODEC_VERSION ? fromCode(BASE_CODE, base ?? '') : 'none',
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
    // Drawn after the older fields, so a given rng still yields the same first eleven.
    position: POSITIONS[randInt(rng, 0, POSITIONS.length - 1)],
    suppressed: randInt(rng, 0, 1) === 1,
    enemySnipers: randInt(rng, MISSION_LIMITS.enemySnipers.min, MISSION_LIMITS.enemySnipers.max),
    assists: randInt(rng, 0, 1) === 1,
    // Drawn last again, so a given rng still yields the same first fifteen fields.
    camo: randInt(rng, 0, 1) === 1,
    // And the newest field after that, so a given rng still yields the same first sixteen.
    soldiersFightBack: randInt(rng, 0, 1) === 1,
    // And the objective last of all, so a given rng still yields the same first seventeen.
    objective: OBJECTIVES[randInt(rng, 0, OBJECTIVES.length - 1)],
    // And the base after it, so a given rng still yields the same first eighteen.
    base: BASES[randInt(rng, 0, BASES.length - 1)],
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

/** The mission a legacy `?range=&wind=&rifle=&air=` URL stands for: one soldier, no props, desert, ridge, no snipers, no assists, no ghillie suit, no fight back. */
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
    rifle: rifle === '308' || rifle === '338' ? rifle : DEFAULT_MISSION.rifle, // the practice range only ever had these two
    buildings: 'none',
    vehicles: 'none',
    seed: 1,
    position: 'ridge',
    suppressed: false,
    enemySnipers: 0,
    assists: false,
    camo: false,
    soldiersFightBack: false, // the practice range's dummy stands and falls, as ever
    objective: 'clear',
    base: 'none',
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
