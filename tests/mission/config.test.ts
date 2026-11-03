import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MISSION,
  MISSION_LIMITS,
  clampMission,
  decodeMission,
  encodeMission,
  randomMission,
  routeFromSearch,
  windClockLabel,
  windVector,
} from '../../src/mission/config';
import type { MissionConfig, Route } from '../../src/mission/config';
import { createRng } from '../../src/mission/random';

function missionRoute(r: Route): Extract<Route, { kind: 'mission' }> {
  if (r.kind !== 'mission') throw new Error(`expected a mission route, got ${r.kind}`);
  return r;
}

function menuRoute(r: Route): Extract<Route, { kind: 'menu' }> {
  if (r.kind !== 'menu') throw new Error(`expected a menu route, got ${r.kind}`);
  return r;
}

describe('DEFAULT_MISSION', () => {
  it('has the spec A.2 defaults and seed 1', () => {
    expect(DEFAULT_MISSION).toEqual({
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
    });
  });

  it('allows 0 to 3 enemy snipers', () => {
    expect(MISSION_LIMITS.enemySnipers).toEqual({ min: 0, max: 3 });
  });
});

describe('windVector', () => {
  it('points the air the way the clock says', () => {
    const cases: Array<[number, [number, number, number]]> = [
      [3, [-5, 0, 0]], // from the right -> toward -X
      [9, [5, 0, 0]], // from the left -> toward +X
      [12, [0, 0, 5]], // headwind -> toward +Z
      [6, [0, 0, -5]], // from behind -> toward -Z
    ];
    for (const [clock, [x, y, z]] of cases) {
      const v = windVector(5, clock);
      expect(v.x).toBeCloseTo(x, 9);
      expect(v.y).toBeCloseTo(y, 9);
      expect(v.z).toBeCloseTo(z, 9);
    }
  });

  it('scales with speed and is zero at zero speed', () => {
    const v = windVector(0, 4);
    expect(Math.hypot(v.x, v.y, v.z)).toBeCloseTo(0, 12);
    const w = windVector(7, 1);
    expect(Math.hypot(w.x, w.y, w.z)).toBeCloseTo(7, 9);
    expect(w.y).toBe(0);
  });
});

describe('windClockLabel', () => {
  it('names the clock position and where the wind comes from', () => {
    expect(windClockLabel(9)).toBe("from 9 o'clock (left)");
    expect(windClockLabel(3)).toBe("from 3 o'clock (right)");
    expect(windClockLabel(12)).toBe("from 12 o'clock (downrange)");
    expect(windClockLabel(6)).toBe("from 6 o'clock (behind)");
  });

  it('labels every clock position and wraps out-of-range values', () => {
    for (let c = 1; c <= 12; c++) expect(windClockLabel(c)).toContain(`from ${c} o'clock`);
    expect(windClockLabel(0)).toBe(windClockLabel(12));
    expect(windClockLabel(13)).toBe(windClockLabel(1));
  });
});

describe('clampMission', () => {
  it('returns the defaults for an empty object', () => {
    expect(clampMission({})).toEqual(DEFAULT_MISSION);
  });

  it('swaps a reversed range band, then clamps it to 100..1500', () => {
    const c = clampMission({ rangeMin: 2000, rangeMax: 50, soldiers: 99, windSpeedMps: -3, windClock: 13 });
    expect(c.rangeMin).toBe(100);
    expect(c.rangeMax).toBe(1500);
    expect(c.soldiers).toBe(10);
    expect(c.windSpeedMps).toBe(0);
    expect(c.windClock).toBe(1);
  });

  it('keeps min <= max for a band with equal ends', () => {
    const c = clampMission({ rangeMin: 800, rangeMax: 800 });
    expect(c.rangeMin).toBe(800);
    expect(c.rangeMax).toBe(800);
  });

  it('quantises wind to 0.1 m/s and ranges to integer metres', () => {
    expect(clampMission({ windSpeedMps: 4.4704 }).windSpeedMps).toBe(4.5);
    expect(clampMission({ windSpeedMps: 99 }).windSpeedMps).toBe(12);
    const c = clampMission({ rangeMin: 612.6, rangeMax: 1000.4 });
    expect(c.rangeMin).toBe(613);
    expect(c.rangeMax).toBe(1000);
  });

  it('wraps the wind clock into 1..12', () => {
    expect(clampMission({ windClock: 0 }).windClock).toBe(12);
    expect(clampMission({ windClock: 13 }).windClock).toBe(1);
    expect(clampMission({ windClock: -1 }).windClock).toBe(11);
    expect(clampMission({ windClock: 12 }).windClock).toBe(12);
    expect(clampMission({ windClock: 3.6 }).windClock).toBe(4);
  });

  it('clamps and rounds the target counts', () => {
    expect(clampMission({ soldiers: 0 }).soldiers).toBe(1);
    expect(clampMission({ soldiers: 4.6 }).soldiers).toBe(5);
    expect(clampMission({ vehicleTargets: 9 }).vehicleTargets).toBe(3);
    expect(clampMission({ vehicleTargets: -2 }).vehicleTargets).toBe(0);
  });

  it('clamps the enemy snipers to 0..3 and rounds them', () => {
    expect(clampMission({ enemySnipers: -1 }).enemySnipers).toBe(0);
    expect(clampMission({ enemySnipers: 9 }).enemySnipers).toBe(3);
    expect(clampMission({ enemySnipers: 0 }).enemySnipers).toBe(0);
    expect(clampMission({ enemySnipers: 3 }).enemySnipers).toBe(3);
    expect(clampMission({ enemySnipers: 1.6 }).enemySnipers).toBe(2);
    expect(clampMission({ enemySnipers: NaN }).enemySnipers).toBe(DEFAULT_MISSION.enemySnipers);
    expect(clampMission({ enemySnipers: Infinity }).enemySnipers).toBe(DEFAULT_MISSION.enemySnipers);
    expect(Object.is(clampMission({ enemySnipers: -0.3 }).enemySnipers, 0)).toBe(true);
  });

  it('keeps the position, suppressor, ghillie suit and assists, and falls back to their defaults for bad values', () => {
    const c = clampMission({ position: 'mountain', suppressed: true, assists: true, camo: true });
    expect(c.position).toBe('mountain');
    expect(c.suppressed).toBe(true);
    expect(c.assists).toBe(true);
    expect(c.camo).toBe(true);
    const bad = clampMission({ position: 'moon', suppressed: 'yes', assists: 1, camo: 'yes' } as unknown as Partial<MissionConfig>);
    expect(bad.position).toBe('ridge');
    expect(bad.suppressed).toBe(false);
    expect(bad.assists).toBe(false);
    expect(bad.camo).toBe(false);
    expect(clampMission({}).camo).toBe(false);
  });

  it('makes the seed an unsigned 32-bit integer', () => {
    expect(clampMission({ seed: 12345.9 }).seed).toBe(12345);
    expect(clampMission({ seed: -1 }).seed).toBe(0xffffffff);
    expect(clampMission({ seed: 0xffffffff }).seed).toBe(0xffffffff);
  });

  it('never produces negative zero or NaN from bad numbers', () => {
    const c = clampMission({
      windSpeedMps: -0.3,
      soldiers: NaN,
      vehicleTargets: Infinity,
      windClock: NaN,
      rangeMin: NaN,
      rangeMax: -Infinity,
      seed: NaN,
    });
    expect(Object.is(c.windSpeedMps, 0)).toBe(true);
    expect(c.soldiers).toBe(DEFAULT_MISSION.soldiers);
    expect(c.vehicleTargets).toBe(DEFAULT_MISSION.vehicleTargets);
    expect(c.windClock).toBe(DEFAULT_MISSION.windClock);
    expect(c.rangeMin).toBe(DEFAULT_MISSION.rangeMin);
    expect(c.rangeMax).toBe(DEFAULT_MISSION.rangeMax);
    expect(c.seed).toBe(DEFAULT_MISSION.seed);
  });

  it('falls back to the defaults for unknown enum values and wrong types', () => {
    const bad = {
      theme: 'moon',
      rifle: '556',
      buildings: 'lots',
      vehicles: 7,
      soldiers: '5',
    } as unknown as Partial<MissionConfig>;
    const c = clampMission(bad);
    expect(c.theme).toBe('desert');
    expect(c.rifle).toBe('308');
    expect(c.buildings).toBe('few');
    expect(c.vehicles).toBe('few');
    expect(c.soldiers).toBe(3);
  });

  it('is idempotent', () => {
    const rng = createRng(11);
    for (let i = 0; i < 50; i++) {
      const c = randomMission(rng);
      expect(clampMission(c)).toEqual(c);
    }
    const messy = clampMission({ rangeMin: 2000, rangeMax: 50, windSpeedMps: 4.4704, windClock: 0, seed: -5 });
    expect(clampMission(messy)).toEqual(messy);
  });
});

describe('encodeMission / decodeMission', () => {
  it('round-trips DEFAULT_MISSION', () => {
    expect(decodeMission(encodeMission(DEFAULT_MISSION))).toEqual(DEFAULT_MISSION);
  });

  it('writes the v4 code: the v1 fields, then position, suppressor, snipers, assists, the ghillie suit and fight back', () => {
    expect(encodeMission(DEFAULT_MISSION)).toBe('v4.d.600.1000.3.0.45.9.308.f.f.1.r.0.1.0.0.1');
    const c: MissionConfig = {
      ...DEFAULT_MISSION,
      theme: 'arctic',
      position: 'mountain',
      suppressed: true,
      enemySnipers: 3,
      assists: true,
      camo: true,
      soldiersFightBack: false,
      seed: 77,
    };
    expect(encodeMission(c)).toBe('v4.a.600.1000.3.0.45.9.308.f.f.77.m.1.3.1.1.0');
    expect(decodeMission('v4.a.600.1000.3.0.45.9.308.f.f.77.m.1.3.1.1.0')).toEqual(c);
    expect(decodeMission('v4.d.600.1000.3.0.45.9.308.f.f.1.v.0.0.0.0.1')).toEqual({
      ...DEFAULT_MISSION,
      position: 'valley',
      enemySnipers: 0,
    });
    // The ghillie flag and the fight-back flag are the last two fields and nothing else.
    expect(encodeMission({ ...DEFAULT_MISSION, camo: true })).toBe('v4.d.600.1000.3.0.45.9.308.f.f.1.r.0.1.0.1.1');
    expect(encodeMission({ ...DEFAULT_MISSION, soldiersFightBack: false })).toBe('v4.d.600.1000.3.0.45.9.308.f.f.1.r.0.1.0.0.0');
  });

  it('still decodes a v3 link (sixteen fields) with the soldiers standing still', () => {
    expect(decodeMission('v3.d.600.1000.3.0.45.9.308.f.f.1.r.0.1.0.0')).toEqual({ ...DEFAULT_MISSION, soldiersFightBack: false });
    expect(decodeMission('v3.a.600.1000.3.0.45.9.308.f.f.77.m.1.3.1.1')).toEqual({
      ...DEFAULT_MISSION,
      theme: 'arctic',
      position: 'mountain',
      suppressed: true,
      enemySnipers: 3,
      assists: true,
      camo: true,
      seed: 77,
      soldiersFightBack: false,
    });
    // An old link becomes a v4 code with fight back OFF: the encoder writes the new version, and the soldiers stay as they were.
    const c = decodeMission('v3.d.300.300.3.0.0.9.308.n.n.1.r.0.0.0.0');
    expect(encodeMission(c as MissionConfig)).toBe('v4.d.300.300.3.0.0.9.308.n.n.1.r.0.0.0.0.0');
  });

  it('reads the fight-back flag of a v4 link, and defaults one that is not 0/1 to the menu default (on)', () => {
    expect(decodeMission('v4.d.600.1000.3.0.45.9.308.f.f.1.r.0.1.0.0.0')?.soldiersFightBack).toBe(false);
    expect(decodeMission('v4.d.600.1000.3.0.45.9.308.f.f.1.r.0.1.0.0.1')?.soldiersFightBack).toBe(true);
    expect(decodeMission('v4.d.600.1000.3.0.45.9.308.f.f.1.r.0.1.0.0.x')?.soldiersFightBack).toBe(true);
  });

  it('still decodes a v2 link (fifteen fields) with no ghillie suit', () => {
    expect(decodeMission('v2.d.600.1000.3.0.45.9.308.f.f.1.r.0.1.0')).toEqual({ ...DEFAULT_MISSION, soldiersFightBack: false });
    expect(decodeMission('v2.a.600.1000.3.0.45.9.308.f.f.77.m.1.3.1')).toEqual({
      ...DEFAULT_MISSION,
      theme: 'arctic',
      position: 'mountain',
      suppressed: true,
      enemySnipers: 3,
      assists: true,
      seed: 77,
      camo: false,
      soldiersFightBack: false,
    });
    // A v2 code does not become a v4 one by accident: the encoder always writes the new version.
    const c = decodeMission('v2.d.300.300.3.0.0.9.308.n.n.1.r.0.0.0');
    expect(encodeMission(c as MissionConfig)).toBe('v4.d.300.300.3.0.0.9.308.n.n.1.r.0.0.0.0.0');
  });

  it('reads the ghillie flag of a v3 link, and defaults a flag that is not 0/1 to off', () => {
    expect(decodeMission('v3.d.600.1000.3.0.45.9.308.f.f.1.r.0.1.0.1')?.camo).toBe(true);
    expect(decodeMission('v3.d.600.1000.3.0.45.9.308.f.f.1.r.0.1.0.0')?.camo).toBe(false);
    expect(decodeMission('v3.d.600.1000.3.0.45.9.308.f.f.1.r.0.1.0.x')?.camo).toBe(false);
    expect(decodeMission('v3.d.600.1000.3.0.45.9.308.f.f.1.r.0.1.0.')?.camo).toBe(false);
  });

  it('round-trips 50 random missions', () => {
    const rng = createRng(2024);
    for (let i = 0; i < 50; i++) {
      const c = randomMission(rng);
      expect(decodeMission(encodeMission(c))).toEqual(c);
    }
  });

  it('round-trips extreme values', () => {
    const c: MissionConfig = {
      theme: 'valley',
      rangeMin: 100,
      rangeMax: 1500,
      soldiers: 10,
      vehicleTargets: 3,
      windSpeedMps: 12,
      windClock: 12,
      rifle: '338',
      buildings: 'many',
      vehicles: 'none',
      seed: 0xffffffff,
      position: 'mountain',
      suppressed: true,
      enemySnipers: 3,
      assists: true,
      camo: true,
      soldiersFightBack: false,
    };
    expect(decodeMission(encodeMission(c))).toEqual(c);
  });

  it('is versioned, compact and safe to paste into a URL without escaping', () => {
    const rng = createRng(5);
    for (let i = 0; i < 50; i++) {
      const s = encodeMission(randomMission(rng));
      expect(s.startsWith('v4.')).toBe(true);
      expect(s).toMatch(/^[A-Za-z0-9._-]+$/);
      expect(s.length).toBeLessThan(64);
    }
  });

  it('survives a trip through URLSearchParams unescaped', () => {
    const s = encodeMission(DEFAULT_MISSION);
    expect(new URLSearchParams('?m=' + s).get('m')).toBe(s);
  });

  it('returns null for undecodable input and never throws', () => {
    const junk = [
      'garbage',
      '',
      'v1',
      'v1.',
      'v1.d.600',
      'v2.d.600.1000.3.0.45.9.308.f.f.1', // v2 needs the four new fields too
      'v2.d.600.1000.3.0.45.9.308.f.f.1.r.0.1', // one short
      'v2.d.600.1000.3.0.45.9.308.f.f.1.r.0.1.0.extra',
      'v2.d.600.1000.3.0.45.9.308.f.f.1.r.0.1.0.0', // v2 never had the ghillie field
      'v1.d.600.1000.3.0.45.9.308.f.f.1.r.0.1.0', // v1 never had the new fields
      'v1.d.600.1000.3.0.45.9.308.f.f.1.extra',
      'v3.d.600.1000.3.0.45.9.308.f.f.1.r.0.1.0', // v3 needs the ghillie field too
      'v3.d.600.1000.3.0.45.9.308.f.f.1.r.0.1.0.0.extra',
      'v4.d.600.1000.3.0.45.9.308.f.f.1.r.0.1.0.0', // v4 needs the fight-back field too
      'v4.d.600.1000.3.0.45.9.308.f.f.1.r.0.1.0.0.1.extra',
      '%%%',
      '....',
      'null',
      '{"theme":"desert"}',
    ];
    for (const s of junk) expect(decodeMission(s)).toBeNull();
    expect(() => decodeMission(undefined as unknown as string)).not.toThrow();
    expect(decodeMission(undefined as unknown as string)).toBeNull();
  });

  it('clamps a structurally valid encoding with out-of-range numbers', () => {
    const c = decodeMission('v1.a.5000.20.99.9.999.25.338.m.n.7');
    expect(c).toEqual({
      theme: 'arctic',
      rangeMin: 100,
      rangeMax: 1500,
      soldiers: 10,
      vehicleTargets: 3,
      windSpeedMps: 12,
      windClock: 1,
      rifle: '338',
      buildings: 'many',
      vehicles: 'none',
      seed: 7,
      position: 'ridge',
      suppressed: false,
      enemySnipers: 0,
      assists: false,
      camo: false,
      soldiersFightBack: false,
    });
  });

  it('clamps the enemy snipers of a v4 code (-1 to 0, 9 to 3)', () => {
    expect(decodeMission('v4.d.600.1000.3.0.45.9.308.f.f.1.r.0.-1.0.0.1')?.enemySnipers).toBe(0);
    expect(decodeMission('v4.d.600.1000.3.0.45.9.308.f.f.1.r.0.9.0.0.1')?.enemySnipers).toBe(3);
    expect(decodeMission('v4.d.600.1000.3.0.45.9.308.f.f.1.r.0.2.0.0.1')?.enemySnipers).toBe(2);
  });

  it('decodes a known v1 link with the new options off (ridge, unsuppressed, no snipers, no assists)', () => {
    expect(decodeMission('v1.d.600.1000.3.0.45.9.308.f.f.1')).toEqual({ ...DEFAULT_MISSION, enemySnipers: 0, soldiersFightBack: false });
    expect(decodeMission('v1.v.400.800.4.1.75.3.338.m.n.77')).toEqual({
      theme: 'valley',
      rangeMin: 400,
      rangeMax: 800,
      soldiers: 4,
      vehicleTargets: 1,
      windSpeedMps: 7.5,
      windClock: 3,
      rifle: '338',
      buildings: 'many',
      vehicles: 'none',
      seed: 77,
      position: 'ridge',
      suppressed: false,
      enemySnipers: 0,
      assists: false,
      camo: false,
      soldiersFightBack: false,
    });
  });

  it('turns a v1 link into a v4 code', () => {
    const c = decodeMission('v1.d.300.300.3.0.0.9.308.n.n.1');
    expect(c).not.toBeNull();
    expect(encodeMission(c as MissionConfig)).toBe('v4.d.300.300.3.0.0.9.308.n.n.1.r.0.0.0.0.0');
  });

  it('uses the default for a missing or unrecognised field', () => {
    // Unknown theme, empty min range / soldiers / seed, non-numeric wind, unknown rifle and densities.
    // A v1 code has no snipers: its new options are off, not the menu defaults.
    const c = decodeMission('v1.x..900..0.abc.9.999.q.z.');
    expect(c).toEqual({ ...DEFAULT_MISSION, rangeMax: 900, enemySnipers: 0, soldiersFightBack: false });
    // The same for a v4 code, with an unknown position, flags that are not 0/1 and a sniper count out of range.
    const d = decodeMission('v4.x..900..0.abc.9.999.q.z..q.x.9.2.y.z');
    expect(d).toEqual({ ...DEFAULT_MISSION, rangeMax: 900, enemySnipers: 3 });
    // Empty new fields fall back to the defaults.
    expect(decodeMission('v4.d.600.1000.3.0.45.9.308.f.f.1......')).toEqual(DEFAULT_MISSION);
  });
});

describe('randomMission', () => {
  it('is deterministic for a given rng', () => {
    expect(randomMission(createRng(77))).toEqual(randomMission(createRng(77)));
  });

  it('covers every theme, rifle, density and clock position within limits', () => {
    const rng = createRng(123);
    const themes = new Set<string>();
    const rifles = new Set<string>();
    const buildings = new Set<string>();
    const vehicles = new Set<string>();
    const clocks = new Set<number>();
    const soldiers = new Set<number>();
    const vehicleTargets = new Set<number>();
    const seeds = new Set<number>();
    const positions = new Set<string>();
    const suppressed = new Set<boolean>();
    const snipers = new Set<number>();
    const assists = new Set<boolean>();
    const camo = new Set<boolean>();
    const fightBack = new Set<boolean>();
    for (let i = 0; i < 1000; i++) {
      const c = randomMission(rng);
      themes.add(c.theme);
      rifles.add(c.rifle);
      buildings.add(c.buildings);
      vehicles.add(c.vehicles);
      clocks.add(c.windClock);
      soldiers.add(c.soldiers);
      vehicleTargets.add(c.vehicleTargets);
      seeds.add(c.seed);
      positions.add(c.position);
      suppressed.add(c.suppressed);
      snipers.add(c.enemySnipers);
      assists.add(c.assists);
      camo.add(c.camo);
      fightBack.add(c.soldiersFightBack);

      expect(c.enemySnipers).toBeGreaterThanOrEqual(0);
      expect(c.enemySnipers).toBeLessThanOrEqual(3);
      expect(c.rangeMin).toBeGreaterThanOrEqual(100);
      expect(c.rangeMax).toBeLessThanOrEqual(1500);
      expect(c.rangeMin).toBeLessThanOrEqual(c.rangeMax);
      expect(c.soldiers).toBeGreaterThanOrEqual(1);
      expect(c.soldiers).toBeLessThanOrEqual(10);
      expect(c.vehicleTargets).toBeGreaterThanOrEqual(0);
      expect(c.vehicleTargets).toBeLessThanOrEqual(3);
      expect(c.windSpeedMps).toBeGreaterThanOrEqual(0);
      expect(c.windSpeedMps).toBeLessThanOrEqual(12);
      expect(clampMission(c)).toEqual(c);
    }
    expect([...themes].sort()).toEqual(['arctic', 'desert', 'valley']);
    expect([...rifles].sort()).toEqual(['308', '338']);
    expect([...buildings].sort()).toEqual(['few', 'many', 'none']);
    expect([...vehicles].sort()).toEqual(['few', 'many', 'none']);
    expect([...clocks].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(soldiers.size).toBe(10);
    expect(vehicleTargets.size).toBe(4);
    expect(seeds.size).toBeGreaterThan(990);
    expect([...positions].sort()).toEqual(['mountain', 'ridge', 'valley']);
    expect([...suppressed].sort()).toEqual([false, true]);
    expect([...snipers].sort()).toEqual([0, 1, 2, 3]);
    expect([...assists].sort()).toEqual([false, true]);
    expect([...camo].sort()).toEqual([false, true]);
    expect([...fightBack].sort()).toEqual([false, true]);
  });

  it('draws the ghillie flag last: the first fifteen fields are what they were before the flag existed', () => {
    // Golden values from before the flag: its draw comes after every other one, so a fresh rng still yields them.
    const { camo, soldiersFightBack, ...earlier } = randomMission(createRng(31));
    expect(earlier).toEqual({
      theme: 'valley',
      rangeMin: 1041,
      rangeMax: 1271,
      soldiers: 1,
      vehicleTargets: 1,
      windSpeedMps: 4.1,
      windClock: 1,
      rifle: '338',
      buildings: 'many',
      vehicles: 'few',
      seed: 1376210325,
      position: 'mountain',
      suppressed: true,
      enemySnipers: 1,
      assists: true,
    });
    expect(typeof camo).toBe('boolean');
    expect(typeof soldiersFightBack).toBe('boolean');
  });

  it('draws a fresh seed each time', () => {
    const rng = createRng(1);
    expect(randomMission(rng).seed).not.toBe(randomMission(rng).seed);
  });
});

describe('routeFromSearch', () => {
  it('routes ?m= to a mission (with debug)', () => {
    const r = missionRoute(routeFromSearch('?m=' + encodeMission(DEFAULT_MISSION) + '&debug=1'));
    expect(r.config).toEqual(DEFAULT_MISSION);
    expect(r.debug).toBe(true);
    expect(r.legacy).toBe(false);
  });

  it('routes ?m= without debug to a non-debug, non-legacy mission', () => {
    const r = missionRoute(routeFromSearch('?m=' + encodeMission(DEFAULT_MISSION)));
    expect(r.config).toEqual(DEFAULT_MISSION);
    expect(r.debug).toBe(false);
    expect(r.legacy).toBe(false);
  });

  it('routes a v1 link to a mission with the new options off', () => {
    const r = missionRoute(routeFromSearch('?m=v1.d.600.1000.3.0.45.9.308.f.f.1'));
    expect(r.config).toEqual({ ...DEFAULT_MISSION, enemySnipers: 0, soldiersFightBack: false });
    expect(r.legacy).toBe(false);
    const menu = menuRoute(routeFromSearch('?last=v1.d.600.1000.3.0.45.9.308.f.f.1'));
    expect(menu.last).toEqual({ ...DEFAULT_MISSION, enemySnipers: 0, soldiersFightBack: false });
  });

  it('accepts the query without a leading ?', () => {
    expect(routeFromSearch('m=' + encodeMission(DEFAULT_MISSION)).kind).toBe('mission');
  });

  it('shows the menu with no query', () => {
    expect(routeFromSearch('')).toEqual({ kind: 'menu', last: null });
    expect(routeFromSearch('?')).toEqual({ kind: 'menu', last: null });
    expect(routeFromSearch('?debug=1')).toEqual({ kind: 'menu', last: null });
  });

  it('shows the menu for an undecodable ?m=', () => {
    expect(routeFromSearch('?m=garbage')).toEqual({ kind: 'menu', last: null });
    expect(routeFromSearch('?m=')).toEqual({ kind: 'menu', last: null });
  });

  it('pre-fills the menu from ?last=', () => {
    const last = { ...DEFAULT_MISSION, theme: 'arctic' as const, soldiers: 7, seed: 99 };
    const r = menuRoute(routeFromSearch('?last=' + encodeMission(last)));
    expect(r.last).toEqual(last);
  });

  it('ignores an undecodable ?last=', () => {
    expect(routeFromSearch('?last=garbage')).toEqual({ kind: 'menu', last: null });
  });

  it('maps the legacy ?range= URL to a one-soldier desert mission', () => {
    const r = missionRoute(routeFromSearch('?range=800&debug=1'));
    expect(r.legacy).toBe(true);
    expect(r.debug).toBe(true);
    expect(r.config).toEqual({
      theme: 'desert',
      rangeMin: 800,
      rangeMax: 800,
      soldiers: 1,
      vehicleTargets: 0,
      windSpeedMps: 4.5,
      windClock: 9,
      rifle: '308',
      buildings: 'none',
      vehicles: 'none',
      seed: 1,
      position: 'ridge',
      suppressed: false,
      enemySnipers: 0,
      assists: false,
      camo: false,
      soldiersFightBack: false,
    });
  });

  it('maps legacy wind sign to clock 9 (from the left) or 3 (from the right)', () => {
    const left = missionRoute(routeFromSearch('?range=500&wind=6')).config;
    expect(left.windClock).toBe(9);
    expect(left.windSpeedMps).toBe(6);
    const right = missionRoute(routeFromSearch('?range=500&wind=-3.5')).config;
    expect(right.windClock).toBe(3);
    expect(right.windSpeedMps).toBe(3.5);
    const none = missionRoute(routeFromSearch('?range=500&wind=0')).config;
    expect(none.windClock).toBe(9);
    expect(none.windSpeedMps).toBe(0);
  });

  it('keeps the legacy wind vector direction (positive wind blows toward +X)', () => {
    const c = missionRoute(routeFromSearch('?range=500&wind=4')).config;
    const v = windVector(c.windSpeedMps, c.windClock);
    expect(v.x).toBeCloseTo(4, 9);
    const c2 = missionRoute(routeFromSearch('?range=500&wind=-4')).config;
    const v2 = windVector(c2.windSpeedMps, c2.windClock);
    expect(v2.x).toBeCloseTo(-4, 9);
  });

  it('maps the legacy rifle and ignores the air preset (always desert)', () => {
    const c = missionRoute(routeFromSearch('?range=500&rifle=338&air=standard')).config;
    expect(c.rifle).toBe('338');
    expect(c.theme).toBe('desert');
    expect(missionRoute(routeFromSearch('?range=500&rifle=junk')).config.rifle).toBe('308');
  });

  it('clamps legacy range and wind, and defaults them when garbage', () => {
    expect(missionRoute(routeFromSearch('?range=5000')).config.rangeMax).toBe(1500);
    expect(missionRoute(routeFromSearch('?range=3')).config.rangeMin).toBe(100);
    expect(missionRoute(routeFromSearch('?range=abc')).config.rangeMin).toBe(800);
    expect(missionRoute(routeFromSearch('?range=800&wind=99')).config.windSpeedMps).toBe(12);
    const c = missionRoute(routeFromSearch('?range=800&wind=abc')).config;
    expect(c.windSpeedMps).toBe(4.5);
    expect(c.windClock).toBe(9);
  });

  it('prefers a valid ?m= over legacy params', () => {
    const r = missionRoute(routeFromSearch('?range=300&m=' + encodeMission(DEFAULT_MISSION)));
    expect(r.legacy).toBe(false);
    expect(r.config).toEqual(DEFAULT_MISSION);
  });

  it('falls back to the legacy mission when ?m= is garbage but ?range= is present', () => {
    const r = missionRoute(routeFromSearch('?m=garbage&range=300'));
    expect(r.legacy).toBe(true);
    expect(r.config.rangeMin).toBe(300);
  });
});
