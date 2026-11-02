import { describe, expect, it } from 'vitest';
import {
  SNIPER_BOUNDS,
  SNIPER_PARTS,
  SNIPER_REACH,
  sniperAimPoints,
  sniperBoundsObstacle,
  sniperHitSpheres,
  sniperWorldPoint,
  sniperZones,
} from '../../src/mission/sniperDims';
import { segmentBox } from '../../src/game/hit';
import { createRng } from '../../src/mission/random';
import { MAX_OVERHANG } from '../../src/mission/dummyDims';
import { SNIPER_SPHERES_FOR } from '../../src/mission/sniperSpheres';

describe('sniper hit spheres', () => {
  it('cover every point of every body part', () => {
    const rng = createRng(77);
    const spheres = sniperHitSpheres();
    let checked = 0;
    for (const part of SNIPER_PARTS) {
      for (let i = 0; i < 4000; i++) {
        // A random point inside the ellipsoid (rejection sampling in the unit ball).
        let ux = 0;
        let uy = 0;
        let uz = 0;
        do {
          ux = rng() * 2 - 1;
          uy = rng() * 2 - 1;
          uz = rng() * 2 - 1;
        } while (ux * ux + uy * uy + uz * uz > 1);
        const p = { x: part.cx + ux * part.rx, y: part.cy + uy * part.ry, z: part.cz + uz * part.rz };
        const inside = spheres.some((s) => Math.hypot(p.x - s.x, p.y - s.y, p.z - s.z) <= s.radius);
        expect(inside, `${part.zone} point ${JSON.stringify(p)}`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBe(SNIPER_PARTS.length * 4000);
  });

  it('give every part its own zone name, and use only the four body zones', () => {
    expect(new Set(sniperHitSpheres().map((s) => s.name))).toEqual(new Set(['head', 'upperTorso', 'lowerTorso', 'limbs']));
    // The head sphere is the first sphere: a head shot is a head shot even where two spheres overlap.
    expect(sniperHitSpheres()[0].name).toBe('head');
  });

  it('are few enough for a cheap bullet test', () => {
    expect(sniperHitSpheres().length).toBeLessThan(100);
  });

  it('come from a table made for the current part dimensions', () => {
    expect(SNIPER_SPHERES_FOR).toHaveLength(SNIPER_PARTS.length);
    SNIPER_PARTS.forEach((p, i) => {
      expect(SNIPER_SPHERES_FOR[i], `part ${i}`).toEqual([p.cx, p.cy, p.cz, p.rx, p.ry, p.rz, MAX_OVERHANG]);
    });
  });

  it('lie inside the body bounds, give or take the overhang', () => {
    const b = SNIPER_BOUNDS;
    for (const s of sniperHitSpheres()) {
      expect(s.x - s.radius).toBeGreaterThanOrEqual(b.cx - b.hx - MAX_OVERHANG - 1e-9);
      expect(s.x + s.radius).toBeLessThanOrEqual(b.cx + b.hx + MAX_OVERHANG + 1e-9);
      expect(s.y + s.radius).toBeLessThanOrEqual(b.cy + b.hy + MAX_OVERHANG + 1e-9);
      expect(s.z - s.radius).toBeGreaterThanOrEqual(b.cz - b.hz - MAX_OVERHANG - 1e-9);
      expect(s.z + s.radius).toBeLessThanOrEqual(b.cz + b.hz + MAX_OVERHANG + 1e-9);
    }
  });
});

/**
 * The body seen by a shooter and the discs the hit spheres cast there: from the front and from above (the two the spheres are
 * made for), and in between, from a hill looking down by 10 to 75 degrees or up from a valley by 10 and 20, and with the sniper turned
 * 10 degrees either way. The silhouette is the union of the parts' ellipse outlines on a fine grid.
 */
describe('sniper hit spheres against the drawn silhouettes', () => {
  const GRID = 0.0025;
  /** The grid's own error: a distance to the nearest silhouette cell can be this much more than to the true outline. */
  const GRID_SLACK = GRID * Math.SQRT1_2 + 1e-9;
  type Part = (typeof SNIPER_PARTS)[number];
  interface View {
    name: string;
    /** A point of the body frame in the image plane. */
    project(q: { x: number; y: number; z: number }): [number, number];
    /** The outline of a part in that plane: an axis-aligned ellipse. */
    ellipse(p: Part): { uc: number; vc: number; a: number; b: number };
  }
  /** The shooter looks along the body's axis, down by `deg` (90 is straight down, negative looks up). */
  const pitched = (deg: number, name: string): View => {
    const c = Math.cos((deg * Math.PI) / 180);
    const s = Math.sin((deg * Math.PI) / 180);
    return {
      name,
      project: (q) => [q.x, q.y * c - q.z * s],
      ellipse: (p) => ({ uc: p.cx, vc: p.cy * c - p.cz * s, a: p.rx, b: Math.hypot(p.ry * c, p.rz * s) }),
    };
  };
  /** The shooter is level, the sniper turned by `deg`. */
  const turned = (deg: number): View => {
    const c = Math.cos((deg * Math.PI) / 180);
    const s = Math.sin((deg * Math.PI) / 180);
    return {
      name: `turned ${deg} degrees`,
      project: (q) => [q.x * c + q.z * s, q.y],
      ellipse: (p) => ({ uc: p.cx * c + p.cz * s, vc: p.cy, a: Math.hypot(p.rx * c, p.rz * s), b: p.ry }),
    };
  };
  const views: View[] = [
    pitched(0, 'front'),
    pitched(90, 'top'),
    ...[10, 20, 30, 45, 60, 75].map((deg) => pitched(deg, `looking down ${deg} degrees`)),
    pitched(-10, 'looking up 10 degrees'),
    pitched(-20, 'looking up 20 degrees'),
    turned(10),
    turned(-10),
  ];

  for (const view of views) {
    describe(view.name, () => {
      // Which cells (u, v) of the grid lie inside some part's ellipse.
      const ellipses = SNIPER_PARTS.map((p) => view.ellipse(p));
      const margin = 0.06;
      const lo = [Math.min(...ellipses.map((e) => e.uc - e.a)) - margin, Math.min(...ellipses.map((e) => e.vc - e.b)) - margin];
      const hi = [Math.max(...ellipses.map((e) => e.uc + e.a)) + margin, Math.max(...ellipses.map((e) => e.vc + e.b)) + margin];
      const nu = Math.ceil((hi[0] - lo[0]) / GRID);
      const nv = Math.ceil((hi[1] - lo[1]) / GRID);
      const inside = new Uint8Array(nu * nv);
      for (let i = 0; i < nu; i++) {
        for (let j = 0; j < nv; j++) {
          const u = lo[0] + (i + 0.5) * GRID;
          const v = lo[1] + (j + 0.5) * GRID;
          inside[i * nv + j] = ellipses.some((e) => ((u - e.uc) / e.a) ** 2 + ((v - e.vc) / e.b) ** 2 <= 1) ? 1 : 0;
        }
      }

      it('every point of the silhouette (a 2.5 mm grid) is inside the disc of some sphere', () => {
        const discs = sniperHitSpheres().map((s) => ({ c: view.project(s), r: s.radius }));
        let cells = 0;
        const missed: string[] = [];
        for (let i = 0; i < nu; i++) {
          for (let j = 0; j < nv; j++) {
            if (!inside[i * nv + j]) continue;
            cells++;
            const u = lo[0] + (i + 0.5) * GRID;
            const v = lo[1] + (j + 0.5) * GRID;
            if (!discs.some((d) => Math.hypot(u - d.c[0], v - d.c[1]) <= d.r)) missed.push(`(${u.toFixed(3)}, ${v.toFixed(3)})`);
          }
        }
        expect(cells).toBeGreaterThan(20000);
        expect(missed.slice(0, 5)).toEqual([]);
      });

      it(`no sphere's disc reaches more than ${MAX_OVERHANG * 100} cm past the silhouette`, () => {
        const reach = Math.ceil((MAX_OVERHANG + GRID_SLACK) / GRID) + 1;
        /** True when some silhouette cell centre lies within `d` of (u, v). */
        const within = (u: number, v: number, d: number): boolean => {
          const ci = Math.floor((u - lo[0]) / GRID);
          const cj = Math.floor((v - lo[1]) / GRID);
          for (let i = Math.max(0, ci - reach); i <= Math.min(nu - 1, ci + reach); i++) {
            for (let j = Math.max(0, cj - reach); j <= Math.min(nv - 1, cj + reach); j++) {
              if (inside[i * nv + j] && Math.hypot(u - (lo[0] + (i + 0.5) * GRID), v - (lo[1] + (j + 0.5) * GRID)) <= d) return true;
            }
          }
          return false;
        };
        const over: string[] = [];
        for (const s of sniperHitSpheres()) {
          const [cu, cv] = view.project(s);
          for (let k = 0; k < 120; k++) {
            const a = (k / 120) * 2 * Math.PI;
            const u = cu + Math.cos(a) * s.radius;
            const v = cv + Math.sin(a) * s.radius;
            if (!within(u, v, MAX_OVERHANG + GRID_SLACK)) over.push(`${s.name} sphere (${s.x}, ${s.y}, ${s.z}) r${s.radius} at (${u.toFixed(3)}, ${v.toFixed(3)})`);
          }
        }
        expect(over.slice(0, 5)).toEqual([]);
      });
    });
  }
});

describe('sniper bounds', () => {
  it('enclose every body part and sit on the ground', () => {
    const b = SNIPER_BOUNDS;
    for (const p of SNIPER_PARTS) {
      expect(p.cx - p.rx).toBeGreaterThanOrEqual(b.cx - b.hx - 1e-9);
      expect(p.cx + p.rx).toBeLessThanOrEqual(b.cx + b.hx + 1e-9);
      expect(p.cy + p.ry).toBeLessThanOrEqual(b.cy + b.hy + 1e-9);
      expect(p.cz - p.rz).toBeGreaterThanOrEqual(b.cz - b.hz - 1e-9);
      expect(p.cz + p.rz).toBeLessThanOrEqual(b.cz + b.hz + 1e-9);
    }
    expect(b.cy - b.hy).toBeGreaterThanOrEqual(0);
    expect(b.cy - b.hy).toBeLessThan(0.05);
  });

  it('SNIPER_REACH reaches the farthest corner of the bounds', () => {
    const b = SNIPER_BOUNDS;
    expect(SNIPER_REACH).toBeGreaterThanOrEqual(Math.hypot(b.cx, b.cz + b.hz));
    expect(SNIPER_REACH).toBeLessThan(2.1);
  });

  it('turn with the pose and hold both aim points', () => {
    const pose = { x: 10, y: 3, z: -400, yaw: 0.4 };
    const aim = sniperAimPoints(pose);
    const obstacle = sniperBoundsObstacle(pose, 'sniper-0');
    expect(obstacle.id).toBe('sniper-0:bounds');
    // A segment that starts inside the box returns 0: both aim points are inside the bounds.
    for (const p of [aim.head, aim.upperTorso]) {
      expect(segmentBox(p, { x: p.x + 1e-6, y: p.y, z: p.z }, obstacle.box)).toBe(0);
    }
  });
});

describe('sniper pose', () => {
  it('puts the head toward the shooter at yaw = facingYaw', () => {
    // Facing yaw of a sniper at (0, -500): zero. Local +Z (the head end) points at world +Z, toward the origin.
    const head = sniperWorldPoint({ x: 0, y: 0, z: -500, yaw: 0 }, { x: 0, y: 0, z: 0.13 });
    expect(head.z).toBeCloseTo(-499.87, 9);
    // At +90 degrees local +Z points at world +X.
    const side = sniperWorldPoint({ x: 0, y: 0, z: 0, yaw: Math.PI / 2 }, { x: 0, y: 0, z: 1 });
    expect(side.x).toBeCloseTo(1, 9);
    expect(side.z).toBeCloseTo(0, 9);
    // Local +X maps to world (cos yaw, -sin yaw), like the props.
    const right = sniperWorldPoint({ x: 0, y: 0, z: 0, yaw: Math.PI / 2 }, { x: 1, y: 0, z: 0 });
    expect(right.x).toBeCloseTo(0, 9);
    expect(right.z).toBeCloseTo(-1, 9);
  });

  it('turns every zone sphere about the belly position', () => {
    const pose = { x: 5, y: 2, z: -300, yaw: 1 };
    const zones = sniperZones(pose);
    expect(zones).toHaveLength(sniperHitSpheres().length);
    zones.forEach((z, i) => {
      const s = sniperHitSpheres()[i];
      expect(Math.hypot(z.center.x - pose.x, z.center.z - pose.z)).toBeCloseTo(Math.hypot(s.x, s.z), 9);
      expect(z.center.y).toBeCloseTo(pose.y + s.y, 9);
    });
  });
});
