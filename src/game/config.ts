/** Stage setup, read from the URL query: `?range=800&wind=4.47&rifle=308&air=desert`. */
export interface StageConfig {
  /** Distance from the shooter to the target, m. */
  range: number;
  /** Wind speed from the shooter's left (blowing toward +X), m/s. Negative blows from the right. */
  windFromLeftMps: number;
  rifle: '308' | '338';
  air: 'standard' | 'desert';
}

export const RANGE_MIN = 100;
export const RANGE_MAX = 1500;

export const DEFAULT_CONFIG: StageConfig = {
  range: 800,
  windFromLeftMps: 4.4704, // 10 mph
  rifle: '308',
  air: 'desert',
};

/** A finite number from a query value, or null for missing, blank or non-numeric text. */
function finiteNumber(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Parse a `location.search` string. Missing or invalid values fall back to the defaults. */
export function parseConfig(search: string): StageConfig {
  const params = new URLSearchParams(search);

  const range = finiteNumber(params.get('range'));
  const wind = finiteNumber(params.get('wind'));
  const rifle = params.get('rifle');
  const air = params.get('air');

  return {
    range:
      range === null
        ? DEFAULT_CONFIG.range
        : Math.min(RANGE_MAX, Math.max(RANGE_MIN, range)),
    windFromLeftMps: wind ?? DEFAULT_CONFIG.windFromLeftMps,
    rifle: rifle === '308' || rifle === '338' ? rifle : DEFAULT_CONFIG.rifle,
    air: air === 'standard' || air === 'desert' ? air : DEFAULT_CONFIG.air,
  };
}
