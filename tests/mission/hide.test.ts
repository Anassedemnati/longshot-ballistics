import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/ballistics/types';
import {
  HIDE,
  apartScore,
  backdropScore,
  coverScore,
  flankScore,
  heightScore,
  nearestCoverGap,
  pickHide,
  scoreHide,
} from '../../src/mission/hide';
import type { HideChoice, HideTerms } from '../../src/mission/hide';
import { propFootprintRadius } from '../../src/mission/props';
import { createRng } from '../../src/mission/random';

const EYE: Vec3 = { x: 0, y: 12.4, z: 0 };
const flat = (y: number) => ({ height: () => y });

describe('the numbers', () => {
  it('are the documented ones', () => {
    expect(HIDE).toMatchObject({
      heightRefM: 20,
      backdropFromM: 20,
      backdropToM: 400,
      backdropStepM: 20,
      coverNearM: 3,
      coverFarM: 12,
      apartFullM: 40,
      pickFrom: 4,
      pickFloor: 0.25,
    });
    expect(HIDE.flankFullRad).toBeCloseTo((8 * Math.PI) / 180, 12);
    expect(HIDE.site.roof).toBeGreaterThan(HIDE.site.ridge);
    expect(HIDE.site.ridge).toBeGreaterThan(HIDE.site.open);
  });
});

describe('heightScore', () => {
  it('is 0 at the eye, +1 from 20 m above and -1 from 20 m below, and linear between', () => {
    expect(heightScore(0)).toBe(0);
    expect(heightScore(10)).toBeCloseTo(0.5, 12);
    expect(heightScore(-10)).toBeCloseTo(-0.5, 12);
    expect(heightScore(20)).toBe(1);
    expect(heightScore(500)).toBe(1);
    expect(heightScore(-500)).toBe(-1);
  });
});

describe('backdropScore', () => {
  const head: Vec3 = { x: 0, y: 3, z: -300 };

  it('is -1 for a sniper on a crest: ground that falls away behind him never meets the line, it is sky from the eye', () => {
    // Level eye 12.4 m, head at 3 m: the line descends 9.4 m over 300 m (about 0.03 per metre). Ground at -30 m stays below it.
    expect(backdropScore(flat(-30), EYE, head)).toBe(-1);
  });

  it('is +1 for a sniper against a hillside: ground that already stands above the line 20 m behind him', () => {
    expect(backdropScore(flat(40), EYE, head)).toBe(1);
  });

  it('falls with the distance to the first ground: 20 m is +1, 220 m about 0, 400 m is -1', () => {
    // The ground is sampled every 20 m: the first sample at or beyond `meetsAt` is where the hill starts.
    const behind = (meetsAt: number) => ({ height: (_x: number, z: number) => (z <= -300 - meetsAt + 1e-9 ? 40 : -30) });
    expect(backdropScore(behind(20), EYE, head)).toBe(1);
    expect(backdropScore(behind(60), EYE, head)).toBeCloseTo(1 - 2 * (40 / 380), 12);
    expect(backdropScore(behind(220), EYE, head)).toBeCloseTo(1 - 2 * (200 / 380), 12);
    expect(backdropScore(behind(400), EYE, head)).toBeCloseTo(-1, 12);
    expect(backdropScore(behind(500), EYE, head)).toBe(-1);
    // Monotone: the sooner the ground comes, the better.
    let last = Infinity;
    for (const m of [20, 40, 80, 160, 320, 400]) {
      const v = backdropScore(behind(m), EYE, head);
      expect(v).toBeLessThanOrEqual(last);
      last = v;
    }
  });

  it('compares with the eye -> head line, not with the height of his head: from a high mountain looking down, ground below his head still backs him', () => {
    // The shooter is 85 m up, the sniper at 0.4 m, 300 m out: the line falls 85 m over 300 m. Ground at -5 m, 5 m below his head, is
    // already above the line 20 m behind him (about -5.3 m, then falling away), so he is backed at once.
    const mountain: Vec3 = { x: 0, y: 85.4, z: 0 };
    const low: Vec3 = { x: 0, y: 0.4, z: -300 };
    expect(backdropScore({ height: () => -5 }, mountain, low)).toBeGreaterThan(0.8);
    // The same ground seen from a level eye is well below the line: sky behind him.
    expect(backdropScore({ height: () => -5 }, { x: 0, y: 0.4, z: 0 }, low)).toBe(-1);
  });

  it('gives a roof on a plain, seen from a ridge, a middling score: the line from the eye meets the plain some way behind it', () => {
    const ridge: Vec3 = { x: 0, y: 12.4, z: 0 };
    const roofHead: Vec3 = { x: 0, y: 4, z: -500 };
    const score = backdropScore(flat(0), ridge, roofHead); // the line reaches the ground (0 m) 4 / (8.4 / 500) = 238 m behind the roof
    expect(score).toBeGreaterThan(-0.5);
    expect(score).toBeLessThan(0.1);
  });

  it('is 0 for a degenerate shooter on top of the sniper', () => {
    expect(backdropScore(flat(0), EYE, { ...EYE })).toBe(0);
  });

  it('samples the ground along the line from the eye, 20 to 400 m beyond him', () => {
    const seen: number[] = [];
    backdropScore(
      {
        height: (x, z) => {
          seen.push(Math.hypot(x - head.x, z - head.z));
          return -100;
        },
      },
      EYE,
      head,
    );
    expect(seen.map((d) => Math.round(d))).toEqual(Array.from({ length: 20 }, (_, i) => 20 * (i + 1)));
  });
});

describe('coverScore', () => {
  it('is full from 3 to 12 m, half when right beside him, 0 on a roof and with none', () => {
    expect(coverScore(3)).toBe(1);
    expect(coverScore(7)).toBe(1);
    expect(coverScore(12)).toBe(1);
    expect(coverScore(1)).toBe(HIDE.coverTooCloseScore);
    expect(coverScore(0)).toBe(HIDE.coverTooCloseScore);
    expect(coverScore(-2)).toBe(0); // lying on it
    expect(coverScore(Infinity)).toBe(0);
    expect(coverScore(Number.NaN)).toBe(0);
  });

  it('fades to nothing between 12 and 25 m', () => {
    expect(coverScore(18.5)).toBeCloseTo(0.5, 12);
    expect(coverScore(25)).toBe(0);
    expect(coverScore(300)).toBe(0);
  });
});

describe('apartScore and flankScore', () => {
  it('apartScore: on top of the group 0, 40 m or more 1, none at all 1', () => {
    expect(apartScore(0)).toBe(0);
    expect(apartScore(20)).toBeCloseTo(0.5, 12);
    expect(apartScore(40)).toBe(1);
    expect(apartScore(400)).toBe(1);
    expect(apartScore(Infinity)).toBe(1);
  });

  it('flankScore: the centre line 0, 8 degrees or more 1, the same either side', () => {
    const deg = Math.PI / 180;
    expect(flankScore(0)).toBe(0);
    expect(flankScore(4 * deg)).toBeCloseTo(0.5, 12);
    expect(flankScore(8 * deg)).toBe(1);
    expect(flankScore(11 * deg)).toBe(1);
    expect(flankScore(-4 * deg)).toBe(flankScore(4 * deg));
  });
});

describe('nearestCoverGap', () => {
  it('measures to the nearest edge of hard cover (the footprint circle), and ignores nothing but non-cover', () => {
    const props = [
      { kind: 'wall' as const, x: 10, z: 0 },
      { kind: 'house' as const, x: 0, z: 40 },
    ];
    expect(nearestCoverGap(0, 0, props)).toBeCloseTo(10 - propFootprintRadius('wall'), 12);
    expect(nearestCoverGap(0, 0, [])).toBe(Infinity);
  });

  it('is negative inside a footprint (on a roof)', () => {
    expect(nearestCoverGap(1, 1, [{ kind: 'house', x: 0, z: 0 }])).toBeLessThan(0);
  });

  it('counts walls, trucks, jeeps, sheds and houses alike', () => {
    for (const kind of ['wall', 'truck', 'jeep', 'shed', 'house'] as const) {
      expect(nearestCoverGap(0, 0, [{ kind, x: 20, z: 0 }]), kind).toBeCloseTo(20 - propFootprintRadius(kind), 12);
    }
  });
});

describe('scoreHide', () => {
  const plain: HideTerms = { headAboveEyeM: 0, backdrop: 0, coverGapM: Infinity, nearestSoldierM: 0, bearingRad: 0, site: 'open' };

  it('is 0 for a hide with nothing going for it', () => {
    expect(scoreHide(plain)).toBe(0);
  });

  it('adds every term with its weight', () => {
    const w = HIDE.weights;
    expect(scoreHide({ ...plain, headAboveEyeM: 20 })).toBeCloseTo(w.height, 12);
    expect(scoreHide({ ...plain, backdrop: 1 })).toBeCloseTo(w.backdrop, 12);
    expect(scoreHide({ ...plain, coverGapM: 5 })).toBeCloseTo(w.cover, 12);
    expect(scoreHide({ ...plain, nearestSoldierM: 40 })).toBeCloseTo(w.apart, 12);
    expect(scoreHide({ ...plain, bearingRad: Math.PI / 6 })).toBeCloseTo(w.flank, 12);
    expect(scoreHide({ ...plain, site: 'roof' })).toBeCloseTo(HIDE.site.roof, 12);
  });

  it('prefers a backdrop to a skyline, cover to none, distance to the group, and a roof to bare ground, other things equal', () => {
    const base: HideTerms = { ...plain, backdrop: 0.2, coverGapM: 20, nearestSoldierM: 15, headAboveEyeM: -5, bearingRad: 0.1 };
    expect(scoreHide({ ...base, backdrop: 0.8 })).toBeGreaterThan(scoreHide({ ...base, backdrop: -1 }));
    expect(scoreHide({ ...base, coverGapM: 6 })).toBeGreaterThan(scoreHide({ ...base, coverGapM: Infinity }));
    expect(scoreHide({ ...base, nearestSoldierM: 60 })).toBeGreaterThan(scoreHide({ ...base, nearestSoldierM: 8 }));
    expect(scoreHide({ ...base, site: 'roof' })).toBeGreaterThan(scoreHide({ ...base, site: 'open' }));
    expect(scoreHide({ ...base, headAboveEyeM: 10 })).toBeGreaterThan(scoreHide({ ...base, headAboveEyeM: -10 }));
    expect(scoreHide({ ...base, bearingRad: 0.15 })).toBeGreaterThan(scoreHide({ ...base, bearingRad: 0.02 }));
  });

  it('a roof is not automatically better: a ridge spot with a backdrop and cover beats a roof on a skyline', () => {
    const roofOnSkyline: HideTerms = { headAboveEyeM: 3, backdrop: -1, coverGapM: -2, nearestSoldierM: 10, bearingRad: 0.02, site: 'roof' };
    const ridgeWithBackdrop: HideTerms = { headAboveEyeM: 3, backdrop: 0.8, coverGapM: 6, nearestSoldierM: 80, bearingRad: 0.19, site: 'ridge' };
    expect(scoreHide(ridgeWithBackdrop)).toBeGreaterThan(scoreHide(roofOnSkyline));
    // ... and the roof still beats the same ground spot when the rest is equal.
    expect(scoreHide({ ...ridgeWithBackdrop, site: 'roof' })).toBeGreaterThan(scoreHide(ridgeWithBackdrop));
  });
});

describe('pickHide', () => {
  /** Hides of one kind of site, with these scores. */
  const scores = (...s: number[]): HideChoice[] => s.map((score) => ({ score, site: 'open' as const }));
  const count = (list: HideChoice[], seed: number, n: number): number[] => {
    const rng = createRng(seed);
    const counts = list.map(() => 0);
    for (let i = 0; i < n; i++) counts[pickHide(list, rng)]++;
    return counts;
  };

  it('returns -1 for nothing, and the only entry for one', () => {
    expect(pickHide([], createRng(1))).toBe(-1);
    expect(pickHide(scores(0.3), createRng(1))).toBe(0);
  });

  it('draws once from the rng', () => {
    let draws = 0;
    pickHide(scores(1, 2, 3, 4, 5), () => {
      draws++;
      return 0.5;
    });
    expect(draws).toBe(1);
  });

  it('of one kind of site only ever picks one of the best four', () => {
    const list = scores(0.1, 3, 2.8, 2.6, 0.2, 2.4, 0.3); // the best four are the entries 1, 2, 3, 5
    const seen = new Set<number>();
    const rng = createRng(7);
    for (let i = 0; i < 2000; i++) seen.add(pickHide(list, rng));
    expect([...seen].sort()).toEqual([1, 2, 3, 5]);
  });

  it('favours the better hides, gives near-equal ones about equal chances, and gives a clearly worse one its floor', () => {
    const counts = count(scores(3, 2.9, 1, 0), 11, 20000);
    expect(counts[1] / counts[0]).toBeGreaterThan(0.75); // 0.1 apart: nearly as likely
    expect(counts[1] / counts[0]).toBeLessThan(1.05);
    expect(counts[0]).toBeGreaterThan(counts[2] * 3); // 1.0 and 3.0 apart: only the floor
    expect(counts[2] / counts[3]).toBeGreaterThan(0.85); // both at the floor
    expect(counts[2] / counts[3]).toBeLessThan(1.15);
    const floor = HIDE.pickFloor / (1 + Math.exp(-0.1 / HIDE.pickTemperature) + 2 * HIDE.pickFloor);
    expect(counts[2] / 20000).toBeCloseTo(floor, 1);
  });

  it('matches the stated chances: exp((score - best) / temperature), normalised, and never below the floor', () => {
    const w = [1, Math.exp(-0.5 / HIDE.pickTemperature)];
    expect(count(scores(1, 0.5), 5, 40000)[0] / 40000).toBeCloseTo(w[0] / (w[0] + w[1]), 1);
    // A hide 15 points worse still has the floor: 0.15 / 1.15.
    expect(count(scores(5, -10), 6, 40000)[1] / 40000).toBeCloseTo(HIDE.pickFloor / (1 + HIDE.pickFloor), 1);
  });

  it('puts the best of every kind of site in the pool, however much worse it scores: a roof is never automatic, nor ruled out', () => {
    const list: HideChoice[] = [
      { score: 3.8, site: 'roof' },
      { score: 3.7, site: 'roof' },
      { score: 3.6, site: 'roof' },
      { score: 3.5, site: 'roof' },
      { score: 2.3, site: 'ridge' },
      { score: 2.2, site: 'open' },
      { score: 2.1, site: 'open' },
    ];
    const counts = count(list, 3, 20000);
    // The pool is the best roof, the best ridge, the best open and the next best roof: entries 0, 4, 5 and 1.
    expect(counts.map((n, i) => (n > 0 ? i : -1)).filter((i) => i >= 0)).toEqual([0, 1, 4, 5]);
    // The two other kinds are not shut out: at least the floor's share between them.
    const ground = counts[4] + counts[5];
    expect(ground / 20000).toBeGreaterThan(0.1);
    expect(ground / 20000).toBeLessThan(0.25);
  });

  it('is deterministic for an rng, and breaks ties by position', () => {
    const list = scores(1, 1, 1);
    expect(pickHide(list, () => 0)).toBe(0);
    expect(pickHide(list, () => 0.999)).toBe(2);
    expect(pickHide(list, createRng(3))).toBe(pickHide(list, createRng(3)));
  });
});
