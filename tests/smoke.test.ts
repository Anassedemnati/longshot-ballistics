import { describe, expect, it } from 'vitest';
import reference from './fixtures/reference.json';
import { G7_TABLE } from '../src/ballistics/g7';

describe('scaffold smoke', () => {
  it('reference fixture has 8 cases x 15 samples', () => {
    expect(reference.cases).toHaveLength(8);
    for (const c of reference.cases) {
      expect(c.samples).toHaveLength(15);
    }
  });

  it('G7 table has 84 rows starting at Mach 0', () => {
    expect(G7_TABLE.length).toBe(84);
    expect(G7_TABLE[0]).toEqual({ mach: 0, cd: 0.1198 });
  });
});
