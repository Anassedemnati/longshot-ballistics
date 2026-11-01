import { describe, expect, it } from 'vitest';
import reference from '../fixtures/reference.json';
import { DESERT_ATMO, STANDARD_ATMO } from '../../src/ballistics/atmosphere';
import { RIFLES } from '../../src/ballistics/rifles';
import { findZeroElevation, simulateToRanges } from '../../src/ballistics/trajectory';
import type { Atmosphere, WindField } from '../../src/ballistics/types';

const ATMOS: Record<string, Atmosphere> = { standard: STANDARD_ATMO, desert: DESERT_ATMO };

type Field = 'height' | 'windage' | 'time' | 'velocity';

interface Worst {
  /** Largest |error| / tolerance seen (1.0 = exactly at the limit). */
  ratio: number;
  /** Absolute error at that point. */
  abs: number;
  range: number;
  ours: number;
  ref: number;
}

function tolerance(field: Field, ref: number): number {
  switch (field) {
    case 'height':
    case 'windage':
      return Math.max(0.02 * Math.abs(ref), 0.01);
    case 'time':
    case 'velocity':
      return 0.01 * Math.abs(ref);
  }
}

describe('validation against js-ballistics reference', () => {
  const failures: string[] = [];
  const summary: Record<string, Record<Field, string>> = {};

  for (const c of reference.cases) {
    const label = `${c.rifle}/${c.air}/wind${c.windFromLeftMps}`;
    it(`matches the reference for ${label}`, () => {
      const rifle = RIFLES[c.rifle as '308' | '338'];
      const atmo = ATMOS[c.air];
      expect(atmo, `unknown air ${c.air}`).toBeDefined();
      const wind: WindField = () => ({ x: c.windFromLeftMps, y: 0, z: 0 });

      const elevation = findZeroElevation(rifle, atmo);
      const ranges = c.samples.map((s) => s.range);
      const ours = simulateToRanges(rifle, atmo, wind, elevation, ranges);
      expect(ours.map((s) => s.range)).toEqual(ranges);

      const worst = {} as Record<Field, Worst>;
      const fields: Field[] = ['height', 'windage', 'time', 'velocity'];
      const caseFailures: string[] = [];
      c.samples.forEach((ref, i) => {
        const got = ours[i];
        for (const f of fields) {
          const tol = tolerance(f, ref[f]);
          const err = Math.abs(got[f] - ref[f]);
          const ratio = err / tol;
          if (!worst[f] || ratio > worst[f].ratio) {
            worst[f] = { ratio, abs: err, range: ref.range, ours: got[f], ref: ref[f] };
          }
          if (!(err <= tol)) {
            caseFailures.push(
              `${label} @ ${ref.range} m ${f}: ours=${got[f]} ref=${ref[f]} |err|=${err} tol=${tol}`,
            );
          }
        }
      });
      failures.push(...caseFailures);

      summary[label] = Object.fromEntries(
        fields.map((f) => [
          f,
          `${(worst[f].ratio * 100).toFixed(1)}% of tol (abs ${worst[f].abs.toExponential(2)}) @${worst[f].range}m`,
        ]),
      ) as Record<Field, string>;

      expect(caseFailures).toEqual([]);
    });
  }

  it('prints the worst-case error per case', () => {
    console.table(summary);
    expect(failures).toEqual([]);
  });
});

describe('zeroing', () => {
  for (const id of ['308', '338'] as const) {
    for (const [airName, atmo] of Object.entries(ATMOS)) {
      it(`${id}/${airName}: bullet crosses the line of sight at the zero range (within 0.1 mm)`, () => {
        const rifle = RIFLES[id];
        const elevation = findZeroElevation(rifle, atmo);
        expect(elevation).toBeGreaterThan(0);
        expect(elevation).toBeLessThan(0.01);
        const [s] = simulateToRanges(rifle, atmo, () => ({ x: 0, y: 0, z: 0 }), elevation, [rifle.zeroRange]);
        expect(Math.abs(s.height)).toBeLessThanOrEqual(1e-4);
      });
    }
  }

  it('simulateToRanges omits ranges the bullet never reaches and returns ascending samples', () => {
    const rifle = RIFLES['308'];
    const el = findZeroElevation(rifle, STANDARD_ATMO);
    const out = simulateToRanges(rifle, STANDARD_ATMO, () => ({ x: 0, y: 0, z: 0 }), el, [300, 100, 1e7]);
    expect(out.map((s) => s.range)).toEqual([100, 300]);
  });
});
