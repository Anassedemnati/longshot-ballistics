import { describe, expect, it } from 'vitest';
import { DEFAULT_MISSION, MISSION_LIMITS, decodeMission, randomMission, routeFromSearch, windVector } from '../../src/mission/config';
import { createRng } from '../../src/mission/random';
import { THEMES } from '../../src/mission/themes';
import type { ThemeId } from '../../src/mission/themes';
import type { FiringPosition } from '../../src/mission/config';
import {
  FIGHT_BACK_NOTE,
  GHILLIE_NOTE,
  SUPPRESSOR_NOTE,
  clockPoint,
  densityNote,
  linkRange,
  menuSearch,
  mpsToMph,
  positionNote,
  rangeLabel,
  RIFLE_ART,
  RIFLE_ART_IMAGE,
  rifleArtStyle,
  rifleNote,
  rifleTitle,
  seedFromBits,
  snipersLabel,
  startSearch,
  stepClock,
  themeBlurb,
  windArrowDir,
  windSpeedLabel,
} from '../../src/ui/menuModel';

describe('linkRange', () => {
  it('moving min below max changes only min', () => {
    expect(linkRange({ min: 600, max: 1000 }, 'min', 300)).toEqual({ min: 300, max: 1000 });
  });

  it('moving min above max pushes max up with it', () => {
    expect(linkRange({ min: 600, max: 1000 }, 'min', 1200)).toEqual({ min: 1200, max: 1200 });
  });

  it('moving max below min pushes min down with it', () => {
    expect(linkRange({ min: 600, max: 1000 }, 'max', 400)).toEqual({ min: 400, max: 400 });
  });

  it('moving max above min changes only max', () => {
    expect(linkRange({ min: 600, max: 1000 }, 'max', 1400)).toEqual({ min: 600, max: 1400 });
  });

  it('clamps to 100-1500 m', () => {
    expect(linkRange({ min: 600, max: 1000 }, 'min', -50)).toEqual({ min: 100, max: 1000 });
    expect(linkRange({ min: 600, max: 1000 }, 'max', 99999)).toEqual({ min: 600, max: 1500 });
    expect(linkRange({ min: 600, max: 1000 }, 'min', 99999)).toEqual({ min: 1500, max: 1500 });
    expect(linkRange({ min: 600, max: 1000 }, 'max', 0)).toEqual({ min: 100, max: 100 });
  });

  it('keeps the end it did not move exactly as it was (off-grid values from a shared link survive)', () => {
    expect(linkRange({ min: 637, max: 1013 }, 'min', 700)).toEqual({ min: 700, max: 1013 });
    expect(linkRange({ min: 637, max: 1013 }, 'max', 900)).toEqual({ min: 637, max: 900 });
  });

  it('ignores a non-number', () => {
    expect(linkRange({ min: 600, max: 1000 }, 'min', Number.NaN)).toEqual({ min: 600, max: 1000 });
  });

  it('min <= max and inside the limits after any sequence of moves', () => {
    const rng = createRng(7);
    let band = { min: 600, max: 1000 };
    for (let i = 0; i < 500; i++) {
      band = linkRange(band, rng() < 0.5 ? 'min' : 'max', Math.floor(rng() * 1800) - 100);
      expect(band.min).toBeLessThanOrEqual(band.max);
      expect(band.min).toBeGreaterThanOrEqual(MISSION_LIMITS.rangeMin);
      expect(band.max).toBeLessThanOrEqual(MISSION_LIMITS.rangeMax);
    }
  });
});

describe('labels', () => {
  it('rangeLabel shows the band, or one distance when both ends are equal', () => {
    expect(rangeLabel({ min: 600, max: 1000 })).toBe('600–1000 m');
    expect(rangeLabel({ min: 800, max: 800 })).toBe('800 m');
  });

  it('converts m/s to mph', () => {
    expect(mpsToMph(0)).toBe(0);
    expect(mpsToMph(4.4704)).toBeCloseTo(10, 4);
    expect(mpsToMph(12)).toBeCloseTo(26.84, 2);
  });

  it('windSpeedLabel shows m/s and whole mph', () => {
    expect(windSpeedLabel(4.5)).toBe('4.5 m/s · 10 mph');
    expect(windSpeedLabel(0)).toBe('0.0 m/s · 0 mph');
    expect(windSpeedLabel(12)).toBe('12.0 m/s · 27 mph');
  });

  it('themeBlurb gives the air of each theme (spec A.3)', () => {
    expect(themeBlurb('desert')).toBe('38 °C · thin air');
    expect(themeBlurb('arctic')).toBe('−15 °C · dense air');
    expect(themeBlurb('valley')).toBe('18 °C · 900 hPa');
  });

  it('rifleNote gives the ballistic coefficient and muzzle velocity of each rifle (spec 5.5)', () => {
    expect(rifleNote('308')).toBe('G7 BC 0.243 · 790 m/s');
    expect(rifleNote('338')).toBe('G7 BC 0.322 · 900 m/s');
  });

  it('densityNote gives the prop counts of spec A.4', () => {
    expect(densityNote('buildings', 'none')).toBe('no buildings');
    expect(densityNote('buildings', 'few')).toBe('3–5 buildings');
    expect(densityNote('buildings', 'many')).toBe('8–12 buildings');
    expect(densityNote('vehicles', 'none')).toBe('no vehicles');
    expect(densityNote('vehicles', 'few')).toBe('2–3 vehicles');
    expect(densityNote('vehicles', 'many')).toBe('5–7 vehicles');
  });

  it('themeBlurb follows the theme definitions', () => {
    for (const id of Object.keys(THEMES) as ThemeId[]) {
      expect(themeBlurb(id)).toContain(`${Math.abs(THEMES[id].airTempC)} °C`);
    }
  });
});

describe('wind dial geometry', () => {
  it('puts 12 at the top, 3 on the right, 6 at the bottom and 9 on the left', () => {
    expect(clockPoint(12, 10)).toEqual({ x: 0, y: -10 });
    expect(clockPoint(3, 10)).toEqual({ x: 10, y: 0 });
    expect(clockPoint(6, 10)).toEqual({ x: 0, y: 10 });
    expect(clockPoint(9, 10)).toEqual({ x: -10, y: 0 });
  });

  it('the 12 positions sit on the circle, 30 degrees apart', () => {
    for (let c = 1; c <= 12; c++) {
      const p = clockPoint(c, 50);
      expect(Math.hypot(p.x, p.y)).toBeCloseTo(50, 5);
    }
    const one = clockPoint(1, 100);
    expect(one.x).toBeCloseTo(50, 5);
    expect(one.y).toBeCloseTo(-86.602540378, 6);
  });

  it('the arrow for 12 points toward the shooter, for 3 left, for 6 downrange, for 9 right', () => {
    expect(windArrowDir(12)).toEqual({ x: 0, y: 1 });
    expect(windArrowDir(3)).toEqual({ x: -1, y: 0 });
    expect(windArrowDir(6)).toEqual({ x: 0, y: -1 });
    expect(windArrowDir(9)).toEqual({ x: 1, y: 0 });
  });

  it('the arrow runs from its clock position toward the centre', () => {
    for (let c = 1; c <= 12; c++) {
      const from = clockPoint(c, 1);
      const dir = windArrowDir(c);
      expect(dir.x).toBeCloseTo(-from.x, 5);
      expect(dir.y).toBeCloseTo(-from.y, 5);
    }
  });

  it('the arrow is the wind vector seen from above (x right, z toward the shooter = down)', () => {
    for (let c = 1; c <= 12; c++) {
      const v = windVector(1, c);
      const dir = windArrowDir(c);
      expect(dir.x).toBeCloseTo(v.x, 5);
      expect(dir.y).toBeCloseTo(v.z, 5);
    }
  });

  it('stepClock wraps around 12', () => {
    expect(stepClock(12, 1)).toBe(1);
    expect(stepClock(1, -1)).toBe(12);
    expect(stepClock(9, 3)).toBe(12);
    expect(stepClock(5, 0)).toBe(5);
    expect(stepClock(3, -15)).toBe(12);
  });
});

describe('starting a mission', () => {
  it('seedFromBits keeps 32-bit values and never gives 0', () => {
    expect(seedFromBits(0)).toBe(1);
    expect(seedFromBits(123456)).toBe(123456);
    expect(seedFromBits(0xffffffff)).toBe(0xffffffff);
    expect(seedFromBits(-1)).toBe(0xffffffff);
  });

  it('startSearch gives a ?m= URL the router reads back as that mission with the new seed', () => {
    const search = startSearch({ ...DEFAULT_MISSION, theme: 'arctic', soldiers: 7 }, 424242, false);
    expect(search.startsWith('?m=v5.')).toBe(true);
    expect(search).not.toContain('debug');
    const route = routeFromSearch(search);
    expect(route.kind).toBe('mission');
    if (route.kind !== 'mission') return;
    expect(route.config).toEqual({ ...DEFAULT_MISSION, theme: 'arctic', soldiers: 7, seed: 424242 });
    expect(route.debug).toBe(false);
    expect(route.legacy).toBe(false);
  });

  it('startSearch carries the ghillie suit through to the mission', () => {
    const route = routeFromSearch(startSearch({ ...DEFAULT_MISSION, camo: true }, 5, false));
    expect(route.kind === 'mission' && route.config.camo).toBe(true);
    const plain = routeFromSearch(startSearch(DEFAULT_MISSION, 5, false));
    expect(plain.kind === 'mission' && plain.config.camo).toBe(false);
  });

  it('startSearch keeps debug=1 when asked', () => {
    const route = routeFromSearch(startSearch(DEFAULT_MISSION, 5, true));
    expect(route.kind === 'mission' && route.debug).toBe(true);
  });

  it('startSearch clamps whatever the controls hold', () => {
    const route = routeFromSearch(startSearch({ ...DEFAULT_MISSION, soldiers: 99, rangeMin: 5, windSpeedMps: 50 }, 3, false));
    expect(route.kind === 'mission' && route.config).toMatchObject({ soldiers: 10, rangeMin: 100, windSpeedMps: 12 });
  });

  it('a random mission survives start and the way back through ?last= unchanged', () => {
    const rng = createRng(2024);
    for (let i = 0; i < 25; i++) {
      const cfg = randomMission(rng);
      const search = startSearch(cfg, 99, false);
      const code = new URLSearchParams(search).get('m') ?? '';
      expect(decodeMission(code)).toEqual({ ...cfg, seed: 99 });
      const back = routeFromSearch(`?last=${code}`);
      expect(back.kind).toBe('menu');
      expect(back.kind === 'menu' && back.last).toEqual({ ...cfg, seed: 99 });
    }
  });

  it('menuSearch gives a ?last= URL the router reads back as the menu holding that mission', () => {
    const cfg = { ...DEFAULT_MISSION, theme: 'valley' as const, soldiers: 8, rangeMin: 250, rangeMax: 250, seed: 777 };
    const search = menuSearch(cfg, false);
    expect(search.startsWith('?last=v5.')).toBe(true);
    expect(search).not.toContain('debug');
    const route = routeFromSearch(search);
    expect(route.kind).toBe('menu');
    expect(route.kind === 'menu' && route.last).toEqual(cfg);
  });

  it('menuSearch keeps debug=1 when asked, and the router still finds the menu', () => {
    const search = menuSearch(DEFAULT_MISSION, true);
    expect(search.endsWith('&debug=1')).toBe(true);
    const route = routeFromSearch(search);
    expect(route.kind === 'menu' && route.last).toEqual(DEFAULT_MISSION);
    expect(new URLSearchParams(search).get('debug')).toBe('1');
  });

  it('menuSearch clamps like every mission, and a random mission survives it unchanged', () => {
    const clamped = routeFromSearch(menuSearch({ ...DEFAULT_MISSION, soldiers: 99, windSpeedMps: 50 }, false));
    expect(clamped.kind === 'menu' && clamped.last).toMatchObject({ soldiers: 10, windSpeedMps: 12 });
    const rng = createRng(31);
    for (let i = 0; i < 25; i++) {
      const cfg = randomMission(rng);
      const back = routeFromSearch(menuSearch(cfg, false));
      expect(back.kind === 'menu' && back.last).toEqual(cfg);
    }
  });
});

describe('firing position, enemy snipers and rifle art labels', () => {
  const POSITIONS: FiringPosition[] = ['valley', 'ridge', 'mountain'];

  it('positionNote gives each firing position its one-sentence description', () => {
    expect(positionNote('ridge')).toBe('Elevated ridge. A clear view into the valley below.');
    expect(positionNote('mountain')).toBe('Steep rocky spur. A pronounced downhill shot into the basin.');
    expect(positionNote('valley')).toMatch(/near-level sightline/);
  });

  it('positionNote is theme-neutral (the position is offered in the desert, arctic and valley themes alike)', () => {
    for (const p of POSITIONS) expect(positionNote(p)).not.toMatch(/sand|wash|dune|snow|desert|arctic|grass/i);
  });

  it('positionNote gives three different descriptions of a similar length (the note box has a fixed height)', () => {
    const notes = POSITIONS.map(positionNote);
    expect(new Set(notes).size).toBe(3);
    for (const n of notes) expect(n.length).toBeLessThanOrEqual(64);
  });

  it('snipersLabel says training for 0 and counts the snipers with the right plural', () => {
    expect(snipersLabel(0)).toMatch(/training/i);
    expect(snipersLabel(1)).toBe('1 sniper');
    expect(snipersLabel(2)).toBe('2 snipers');
    expect(snipersLabel(MISSION_LIMITS.enemySnipers.max)).toBe('3 snipers');
  });

  it('the ghillie suit note says what the suit does and when it stops, in one line of the gear panel (about 33 characters)', () => {
    expect(GHILLIE_NOTE).toMatch(/hard to spot/i);
    expect(GHILLIE_NOTE).toMatch(/until you fire/i);
    expect(GHILLIE_NOTE.length).toBeLessThanOrEqual(33);
    expect(GHILLIE_NOTE).not.toBe(SUPPRESSOR_NOTE);
    // The fight-back note is one line too, and says where the number of soldiers is set.
    expect(FIGHT_BACK_NOTE.length).toBeLessThanOrEqual(33);
    expect(FIGHT_BACK_NOTE).toMatch(/slider/i);
  });

  it('rifleTitle names each rifle as the concept art does', () => {
    expect(rifleTitle('308')).toBe('Compact precision rifle');
    expect(rifleTitle('338')).toBe('Long-range precision rifle');
  });
});

describe('rifle concept art crop', () => {
  const RIFLES = ['308', '338'] as const;

  it('stays inside the picture', () => {
    for (const r of RIFLES) {
      const c = RIFLE_ART[r];
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.x + c.w).toBeLessThanOrEqual(RIFLE_ART_IMAGE.w);
      expect(c.y + c.h).toBeLessThanOrEqual(RIFLE_ART_IMAGE.h);
    }
  });

  it('both crops have the same shape, so the art box keeps its height when the rifle changes', () => {
    const a = RIFLE_ART['308'];
    const b = RIFLE_ART['338'];
    expect(a.w / a.h).toBeCloseTo(b.w / b.h, 1);
  });

  it('the .308 crop shows the upper rifle and the .338 crop the middle one', () => {
    expect(RIFLE_ART['308'].y).toBeLessThan(RIFLE_ART['338'].y);
    expect(RIFLE_ART['308'].y + RIFLE_ART['308'].h).toBeLessThanOrEqual(RIFLE_ART['338'].y + RIFLE_ART['338'].h);
  });

  it('rifleArtStyle of a crop covering the whole picture is 100 % wide, with no offset', () => {
    const whole = { x: 0, y: 0, w: RIFLE_ART_IMAGE.w, h: RIFLE_ART_IMAGE.h };
    expect(rifleArtStyle(whole)).toEqual({ aspect: RIFLE_ART_IMAGE.w / RIFLE_ART_IMAGE.h, widthPct: 100, leftPct: 0, topPct: 0 });
  });

  it('rifleArtStyle scales and shifts the picture so the crop fills the box', () => {
    // A crop one quarter as wide and tall as the picture, in the picture's second half: 4x the box width, shifted left and up by the offset.
    const crop = { x: RIFLE_ART_IMAGE.w / 2, y: RIFLE_ART_IMAGE.h / 4, w: RIFLE_ART_IMAGE.w / 4, h: RIFLE_ART_IMAGE.h / 4 };
    const s = rifleArtStyle(crop);
    expect(s.widthPct).toBeCloseTo(400, 6);
    expect(s.leftPct).toBeCloseTo(-200, 6);
    expect(s.topPct).toBeCloseTo(-100, 6);
    expect(s.aspect).toBeCloseTo(RIFLE_ART_IMAGE.w / RIFLE_ART_IMAGE.h, 6);
  });

  it('a crop never reaches outside the box: the picture covers it on every side', () => {
    for (const r of RIFLES) {
      const s = rifleArtStyle(RIFLE_ART[r]);
      const c = RIFLE_ART[r];
      // The picture (100 * widthPct % of the box wide) must extend left of the box's left edge and right of its right edge...
      expect(s.leftPct).toBeLessThanOrEqual(0);
      expect(s.leftPct + s.widthPct).toBeGreaterThanOrEqual(100 - 1e-9);
      // ...and the same vertically: the picture is widthPct * (imageH / imageW) of the box width tall = that fraction / aspect of the box height.
      const imageHeightPct = (s.widthPct * RIFLE_ART_IMAGE.h) / RIFLE_ART_IMAGE.w * (c.w / c.h);
      expect(s.topPct).toBeLessThanOrEqual(0);
      expect(s.topPct + imageHeightPct).toBeGreaterThanOrEqual(100 - 1e-9);
    }
  });
});

describe('the objective control', () => {
  it('offers both objectives with a one-line note each', async () => {
    const { OBJECTIVE_OPTIONS, objectiveNote } = await import('../../src/ui/menuModel');
    expect(OBJECTIVE_OPTIONS.map((o) => o.value)).toEqual(['clear', 'hvt']);
    expect(OBJECTIVE_OPTIONS.map((o) => o.label)).toEqual(['Clear the area', 'High-value target']);
    for (const o of OBJECTIVE_OPTIONS) {
      expect(objectiveNote(o.value).length).toBeGreaterThan(10);
      expect(objectiveNote(o.value).length).toBeLessThanOrEqual(28); // one line in the panel
    }
  });
});
