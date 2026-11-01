import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/game/config';

const DEFAULTS = { range: 800, windFromLeftMps: 4.4704, rifle: '308', air: 'desert' };

describe('parseConfig', () => {
  it('returns the defaults for an empty query', () => {
    expect(parseConfig('')).toEqual(DEFAULTS);
    expect(parseConfig('?')).toEqual(DEFAULTS);
  });

  it('reads range, wind, rifle and air from the query (with or without the leading ?)', () => {
    expect(parseConfig('?range=1200&wind=-3.5&rifle=338&air=standard')).toEqual({
      range: 1200,
      windFromLeftMps: -3.5,
      rifle: '338',
      air: 'standard',
    });
    expect(parseConfig('range=450&wind=0')).toEqual({ ...DEFAULTS, range: 450, windFromLeftMps: 0 });
  });

  it('clamps the range to 100..1500', () => {
    expect(parseConfig('?range=5000').range).toBe(1500);
    expect(parseConfig('?range=1500').range).toBe(1500);
    expect(parseConfig('?range=100').range).toBe(100);
    expect(parseConfig('?range=3').range).toBe(100);
    expect(parseConfig('?range=-400').range).toBe(100);
  });

  it('falls back to the defaults for garbage values', () => {
    expect(parseConfig('?range=abc&wind=xyz&rifle=300&air=arctic')).toEqual(DEFAULTS);
    expect(parseConfig('?range=&wind=')).toEqual(DEFAULTS);
    expect(parseConfig('?range=NaN&wind=Infinity')).toEqual(DEFAULTS);
    expect(parseConfig('?range=Infinity').range).toBe(800);
  });

  it('ignores unknown parameters', () => {
    expect(parseConfig('?debug=1&foo=bar')).toEqual(DEFAULTS);
  });
});
