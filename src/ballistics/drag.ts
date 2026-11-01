import { G7_TABLE } from './g7';
import { STANDARD_DENSITY } from './atmosphere';

// Monotone cubic (PCHIP, Fritsch-Carlson with scipy-style weighted slopes) interpolation of
// the G7 Cd(Mach) table. The table is non-uniformly spaced and has a hump around Mach 1,
// so a monotone interpolant avoids the overshoot a plain cubic spline would produce.

const XS: number[] = G7_TABLE.map((r) => r.mach);
const YS: number[] = G7_TABLE.map((r) => r.cd);
const N = XS.length;
const H: number[] = [];
const DELTA: number[] = [];
for (let i = 0; i < N - 1; i++) {
  H.push(XS[i + 1] - XS[i]);
  DELTA.push((YS[i + 1] - YS[i]) / H[i]);
}

/** Knot derivatives. Zero where the secant slopes change sign (or either is zero). */
const D: number[] = (() => {
  const d = new Array<number>(N).fill(0);
  for (let i = 1; i < N - 1; i++) {
    if (DELTA[i - 1] * DELTA[i] > 0) {
      const w1 = 2 * H[i] + H[i - 1];
      const w2 = H[i] + 2 * H[i - 1];
      d[i] = (w1 + w2) / (w1 / DELTA[i - 1] + w2 / DELTA[i]);
    }
  }
  d[0] = endpointSlope(H[0], H[1], DELTA[0], DELTA[1]);
  d[N - 1] = endpointSlope(H[N - 2], H[N - 3], DELTA[N - 2], DELTA[N - 3]);
  return d;
})();

/** One-sided three-point endpoint slope, clamped to preserve monotonicity. */
function endpointSlope(h0: number, h1: number, del0: number, del1: number): number {
  let d = ((2 * h0 + h1) * del0 - h0 * del1) / (h0 + h1);
  if (Math.sign(d) !== Math.sign(del0)) {
    d = 0;
  } else if (Math.sign(del0) !== Math.sign(del1) && Math.abs(d) > 3 * Math.abs(del0)) {
    d = 3 * del0;
  }
  return d;
}

/** G7 drag coefficient at the given Mach number. Clamped to the first/last table value outside the table. */
export function g7Cd(mach: number): number {
  if (!(mach > XS[0])) return YS[0]; // also catches NaN
  if (mach >= XS[N - 1]) return YS[N - 1];

  // Largest i with XS[i] <= mach (binary search); i in [0, N-2].
  let lo = 0;
  let hi = N - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (XS[mid] <= mach) lo = mid;
    else hi = mid;
  }
  const i = lo;
  const h = H[i];
  const t = (mach - XS[i]) / h;
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return h00 * YS[i] + h10 * h * D[i] + h01 * YS[i + 1] + h11 * h * D[i + 1];
}

/**
 * Drag scale factor [1/m] for a G7 ballistic coefficient (lb/in^2):
 * rho0 * pi / (8 * bc * 703.0696). Deceleration is
 * a = -densityRatio * dragFactor(bc) * g7Cd(M) * |v_rel| * v_rel.
 */
export function dragFactor(bcG7: number): number {
  return (STANDARD_DENSITY * Math.PI) / (8 * bcG7 * 703.0696);
}
