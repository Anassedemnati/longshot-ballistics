import { describe, expect, it } from 'vitest';
import { G7_TABLE } from '../../src/ballistics/g7';
import { dragFactor, g7Cd } from '../../src/ballistics/drag';

describe('g7Cd', () => {
  it('hits every table row exactly at its Mach value', () => {
    for (const row of G7_TABLE) {
      expect(g7Cd(row.mach)).toBe(row.cd);
    }
  });

  it('stays between neighbouring rows mid-way', () => {
    for (let i = 0; i < G7_TABLE.length - 1; i++) {
      const a = G7_TABLE[i];
      const b = G7_TABLE[i + 1];
      const mid = g7Cd((a.mach + b.mach) / 2);
      expect(mid).toBeGreaterThanOrEqual(Math.min(a.cd, b.cd) - 1e-12);
      expect(mid).toBeLessThanOrEqual(Math.max(a.cd, b.cd) + 1e-12);
    }
  });

  it('is strictly between neighbours at a known sloped interval', () => {
    // Mach 1.0 -> 1.025 rises through the transonic drag rise.
    const i = G7_TABLE.findIndex((r) => r.mach === 1);
    const a = G7_TABLE[i];
    const b = G7_TABLE[i + 1];
    expect(b.cd).not.toBe(a.cd);
    const mid = g7Cd((a.mach + b.mach) / 2);
    expect(mid).toBeGreaterThan(Math.min(a.cd, b.cd));
    expect(mid).toBeLessThan(Math.max(a.cd, b.cd));
  });

  it('clamps below Mach 0 and above the last table Mach', () => {
    const first = G7_TABLE[0];
    const last = G7_TABLE[G7_TABLE.length - 1];
    expect(g7Cd(-1)).toBe(first.cd);
    expect(g7Cd(-1e9)).toBe(first.cd);
    expect(g7Cd(last.mach + 0.5)).toBe(last.cd);
    expect(g7Cd(1e9)).toBe(last.cd);
  });

  it('is finite and positive across the whole range', () => {
    for (let m = -0.5; m <= 6; m += 0.0137) {
      const cd = g7Cd(m);
      expect(Number.isFinite(cd)).toBe(true);
      expect(cd).toBeGreaterThan(0);
    }
  });
});

describe('dragFactor', () => {
  it('equals rho0 * pi / (8 * bc * 703.0696)', () => {
    expect(dragFactor(0.243)).toBeCloseTo((1.225 * Math.PI) / (8 * 0.243 * 703.0696), 12);
    expect(dragFactor(0.322)).toBeCloseTo((1.225 * Math.PI) / (8 * 0.322 * 703.0696), 12);
  });

  it('is inversely proportional to the ballistic coefficient', () => {
    expect(dragFactor(0.2) / dragFactor(0.4)).toBeCloseTo(2, 12);
  });
});
