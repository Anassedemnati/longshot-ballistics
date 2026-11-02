// Generates src/mission/sniperSpheres.ts: the hit spheres of the prone sniper's body parts.
//   node scripts/gen-sniper-spheres.mjs        (Node 22.18+ loads the .ts part table directly)
// Re-run it whenever SNIPER_PARTS (src/mission/sniperParts.ts) or MAX_OVERHANG changes: sniperDims.ts throws
// on a stale table, and tests/mission/sniperDims.test.ts checks the result against the drawn ellipsoids.
//
// Every part is an ellipsoid (cx, cy, cz, rx, ry, rz). It is blanketed with spheres so that
//   (volume)   every point of the ellipsoid is inside some sphere (a bullet from any direction that crosses the
//              part meets one), and
//   (overhang) the disc each sphere casts stays within MAX_OVERHANG of the part's silhouette in every view of VIEWS:
//              from the front (a disc in x, y against the ellipse rx, ry), from above (x, z against rx, rz), from
//              a shooter looking down by 10 to 75 degrees or up by 10 and 20 (a hill or a valley: the silhouette is the
//              ellipse rx x sqrt((ry cos)^2 + (rz sin)^2), the sphere's centre moves by -z sin), and from a sniper
//              turned 10 degrees either way.
// A disc of radius r centred c satisfies the overhang rule when r <= d + MAX_OVERHANG, d being the distance from
// c to the ellipse's boundary, so the radius of a candidate centre is fixed by that (the biggest allowed, the
// smallest over the views). The spheres are then picked greedily (the one covering the most still-uncovered volume
// first, on a lattice of samples that is conservative: a sphere only counts a sample whose whole cell it holds)
// and every redundant one is dropped at the end. A sphere part (the head) gets exactly one sphere: itself.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_OVERHANG } from '../src/mission/dummyDims.ts';
import { SNIPER_PARTS } from '../src/mission/sniperParts.ts';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'mission', 'sniperSpheres.ts');
/** Sample lattice (volume to cover), m. */
const H = 0.007;
/** Candidate sphere centres lattice, m. */
const G = 0.012;
/** A sphere is this much smaller than the overhang rule allows (rounding of the table, the checks' grid), m. */
const SAFETY = 0.0006;
const R_CAP = 0.2;
const MM = 1e4;
const DEG = Math.PI / 180;
/**
 * The views the overhang rule holds in. `pitch`: the shooter looks along the body's axis, down by `deg` (negative: up;
 * 90 is straight down); `yaw`: the body is turned by `deg`. In each the image plane is (u, v) and a part's silhouette is an
 * axis-aligned ellipse about the projection of its centre.
 */
const VIEWS = [
  ...[-20, -10, 0, 10, 20, 30, 45, 60, 75, 90].map((deg) => ({ kind: 'pitch', cos: Math.cos(deg * DEG), sin: Math.sin(deg * DEG) })),
  ...[-10, 10].map((deg) => ({ kind: 'yaw', cos: Math.cos(deg * DEG), sin: Math.sin(deg * DEG) })),
];

/** How far inside the silhouette of a part (centre-relative sphere centre x, y, z) the sphere's centre is, the smallest over VIEWS. */
function depthInSilhouettes(x, y, z, a, b, c) {
  let d = Infinity;
  for (const v of VIEWS) {
    const k = v.cos;
    const m = v.sin;
    d =
      v.kind === 'pitch'
        ? Math.min(d, distToEllipse(x, y * k - z * m, a, Math.hypot(b * k, c * m)))
        : Math.min(d, distToEllipse(x * k + z * m, y, Math.hypot(a * k, c * m), b));
  }
  return d;
}

/** Distance from (px, py) to the boundary of the ellipse (a, b) about the origin; 0 outside. */
function distToEllipse(px, py, a, b) {
  px = Math.abs(px);
  py = Math.abs(py);
  if ((px / a) ** 2 + (py / b) ** 2 >= 1) return 0;
  const f = (t) => Math.hypot(px - a * Math.cos(t), py - b * Math.sin(t));
  const N = 96;
  let best = Infinity;
  let bt = 0;
  for (let i = 0; i <= N; i++) {
    const t = ((i / N) * Math.PI) / 2;
    const d = f(t);
    if (d < best) {
      best = d;
      bt = t;
    }
  }
  let lo = Math.max(0, bt - Math.PI / 2 / N);
  let hi = Math.min(Math.PI / 2, bt + Math.PI / 2 / N);
  for (let i = 0; i < 60; i++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    if (f(m1) < f(m2)) hi = m2;
    else lo = m1;
  }
  return Math.min(best, f((lo + hi) / 2));
}

/** A max-heap on `gain` (lazy greedy: entries are re-evaluated when they reach the top). */
class Heap {
  constructor() {
    this.a = [];
  }
  push(x) {
    const a = this.a;
    a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].gain >= a[i].gain) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].gain > a[m].gain) m = l;
        if (r < a.length && a[r].gain > a[m].gain) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
  get size() {
    return this.a.length;
  }
}

function coverPart(part) {
  const { rx: a, ry: b, rz: c } = part;
  if (Math.abs(a - b) < 1e-12 && Math.abs(b - c) < 1e-12) return [{ x: 0, y: 0, z: 0, r: a, exact: true }];

  const s = (H * Math.sqrt(3)) / 2; // half the diagonal of a sample cell
  const nx = Math.ceil((a + s) / H);
  const ny = Math.ceil((b + s) / H);
  const nz = Math.ceil((c + s) / H);
  const sx = 2 * nx + 1;
  const sy = 2 * ny + 1;
  const sz = 2 * nz + 1;
  const key = (i, j, k) => ((i + nx) * sy + (j + ny)) * sz + (k + nz);
  const unc = new Uint8Array(sx * sy * sz);
  const mult = new Uint16Array(sx * sy * sz);
  let remaining = 0;
  for (let i = -nx; i <= nx; i++)
    for (let j = -ny; j <= ny; j++)
      for (let k = -nz; k <= nz; k++) {
        const x = i * H;
        const y = j * H;
        const z = k * H;
        if ((x / (a + s)) ** 2 + (y / (b + s)) ** 2 + (z / (c + s)) ** 2 <= 1) {
          unc[key(i, j, k)] = 1;
          remaining++;
        }
      }

  // Visit every sample cell a sphere holds entirely (centre cx, cy, cz; radius r).
  const visit = (cd, fn) => {
    const R = cd.r - s;
    if (R <= 0) return;
    const m = Math.floor(R / H) + 1;
    const ci = Math.round(cd.x / H);
    const cj = Math.round(cd.y / H);
    const ck = Math.round(cd.z / H);
    const R2 = R * R;
    for (let i = Math.max(-nx, ci - m); i <= Math.min(nx, ci + m); i++) {
      const dx = i * H - cd.x;
      for (let j = Math.max(-ny, cj - m); j <= Math.min(ny, cj + m); j++) {
        const dy = j * H - cd.y;
        for (let k = Math.max(-nz, ck - m); k <= Math.min(nz, ck + m); k++) {
          const dz = k * H - cd.z;
          if (dx * dx + dy * dy + dz * dz <= R2) fn(key(i, j, k));
        }
      }
    }
  };

  const heap = new Heap();
  const gx = Math.floor(a / G);
  const gy = Math.floor(b / G);
  const gz = Math.floor(c / G);
  for (let i = -gx; i <= gx; i++)
    for (let j = -gy; j <= gy; j++)
      for (let k = -gz; k <= gz; k++) {
        const x = i * G;
        const y = j * G;
        const z = k * G;
        if ((x / a) ** 2 + (y / b) ** 2 + (z / c) ** 2 > 1) continue;
        const d = depthInSilhouettes(x, y, z, a, b, c);
        const r = Math.min(R_CAP, d + MAX_OVERHANG - SAFETY);
        const cd = { x, y, z, r, gain: 0 };
        visit(cd, (q) => {
          if (unc[q]) cd.gain++;
        });
        if (cd.gain > 0) heap.push(cd);
      }

  const picked = [];
  while (remaining > 0 && heap.size > 0) {
    const cd = heap.pop();
    let now = 0;
    visit(cd, (q) => {
      if (unc[q]) now++;
    });
    if (now === 0) continue;
    if (heap.size > 0 && now < heap.a[0].gain) {
      cd.gain = now;
      heap.push(cd);
      continue;
    }
    visit(cd, (q) => {
      if (unc[q]) {
        unc[q] = 0;
        remaining--;
      }
      mult[q]++;
    });
    picked.push(cd);
  }
  if (remaining > 0) throw new Error(`${remaining} samples of a ${a} x ${b} x ${c} part cannot be covered`);

  // Drop every sphere whose samples are all covered by others too (smallest first).
  picked.sort((u, v) => u.r - v.r);
  const kept = [];
  for (const cd of picked) {
    let needed = false;
    visit(cd, (q) => {
      if (mult[q] === 1) needed = true;
    });
    if (needed) kept.push(cd);
    else visit(cd, (q) => mult[q]--);
  }
  return kept;
}

const round = (v) => Math.round(v * MM) / MM;
const num = (v) => {
  const r = round(v);
  return Object.is(r, -0) ? '0' : String(r);
};

const forLines = [];
const rowLines = [];
let total = 0;
SNIPER_PARTS.forEach((part, index) => {
  const spheres = coverPart(part)
    .map((q) => ({ x: round(part.cx + q.x), y: round(part.cy + q.y), z: round(part.cz + q.z), r: q.exact ? q.r : Math.floor(q.r * MM) / MM }))
    .sort((u, v) => v.z - u.z || u.x - v.x || u.y - v.y);
  total += spheres.length;
  const rx = Math.max(...spheres.map((q) => q.r));
  const rn = Math.min(...spheres.map((q) => q.r));
  console.log(`part ${index} (${part.zone}): ${spheres.length} spheres, radius ${rn.toFixed(3)}..${rx.toFixed(3)}`);
  forLines.push(`  [${[part.cx, part.cy, part.cz, part.rx, part.ry, part.rz, MAX_OVERHANG].join(', ')}],`);
  rowLines.push(`  // part ${index}: ${part.zone}, ${spheres.length} spheres`);
  rowLines.push('  [');
  for (const q of spheres) rowLines.push(`    [${num(q.x)}, ${num(q.y)}, ${num(q.z)}, ${num(q.r)}],`);
  rowLines.push('  ],');
});

const text = `// GENERATED by scripts/gen-sniper-spheres.mjs from SNIPER_PARTS (sniperParts.ts) and MAX_OVERHANG: do not edit.
// The hit spheres of every body part of the prone sniper, [x, y, z, radius] in the body frame, m. They blanket
// each ellipsoid (every point of it is inside one) and none sticks out of the part's silhouette, seen from the
// front, from above or from the angles in between, by more than MAX_OVERHANG. See sniperDims.ts.

/** The part dimensions each table below was made for (cx, cy, cz, rx, ry, rz, MAX_OVERHANG): sniperDims.ts refuses a stale table. */
export const SNIPER_SPHERES_FOR: ReadonlyArray<readonly number[]> = [
${forLines.join('\n')}
];

/** Per part (same order as SNIPER_PARTS), its spheres. */
export const SNIPER_SPHERE_ROWS: ReadonlyArray<ReadonlyArray<readonly [number, number, number, number]>> = [
${rowLines.join('\n')}
];
`;
writeFileSync(OUT, text);
console.log(`wrote ${OUT}: ${total} spheres`);
