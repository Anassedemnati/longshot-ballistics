import { describe, expect, it } from 'vitest';
import { segmentBox } from '../../src/game/hit';
import type { Box } from '../../src/game/hit';
import { lineOfSightClear } from '../../src/mission/layout';
import {
  BAG_HALF,
  BAG_RING_RADIUS,
  CRESCENT_FROM_DEG,
  PAD_EDGE_RADIUS,
  PAD_FLAT_RADIUS,
  ROCK_BEARING_MIN_DEG,
  bearingOf,
  nestObstacles,
  planNest,
} from '../../src/mission/nestPlan';
import type { NestPlan } from '../../src/mission/nestPlan';
import { terrainGridAxes } from '../../src/scene/terrain';
import { makeMeshGround } from '../../src/mission/scatter';
import { POSITIONS, THEMES, aimPoints, bigMission, blockedByExtra } from '../helpers/missions';
import type { Mission } from '../helpers/missions';

const SEEDS = [1, 2, 3, 7, 20261101];
const DEG = Math.PI / 180;

function nestFor(m: Mission): NestPlan {
  const { field, config } = m;
  return planNest({
    eye: field.shooter,
    ground: makeMeshGround(terrainGridAxes(), field.height),
    terrain: field.height,
    position: config.position,
    theme: config.theme,
    seed: config.seed,
  });
}

/** The eight corners of an oriented box. */
function corners(b: Box): Array<{ x: number; y: number; z: number }> {
  const out = [];
  const c = Math.cos(b.yaw);
  const s = Math.sin(b.yaw);
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const lx = sx * b.halfSize.x;
        const lz = sz * b.halfSize.z;
        out.push({ x: b.center.x + c * lx + s * lz, y: b.center.y + sy * b.halfSize.y, z: b.center.z - s * lx + c * lz });
      }
    }
  }
  return out;
}

describe('planNest', () => {
  it('is deterministic for (seed, theme, position) and varies with the seed', () => {
    const m = bigMission('desert', 3, 'ridge');
    const a = nestFor(m);
    const b = nestFor(m);
    expect(b.bags).toEqual(a.bags);
    expect(b.rocks).toEqual(a.rocks);
    expect(nestFor(bigMission('desert', 4, 'ridge')).bags).not.toEqual(a.bags);
  });

  for (const theme of THEMES) {
    for (const position of POSITIONS) {
      it(`${theme} / ${position}: a crescent of two courses and two to four rocks, round the eye and open to the front`, () => {
        for (const seed of SEEDS) {
          const m = bigMission(theme, seed, position);
          const nest = nestFor(m);
          const eye = nest.eye;
          expect(nest.bags.length).toBeGreaterThanOrEqual(15);
          expect(nest.bags.length).toBeLessThanOrEqual(40);
          expect(new Set(nest.bags.map((b) => b.course))).toEqual(new Set([0, 1]));
          expect(nest.rocks.length).toBeGreaterThanOrEqual(2);
          expect(nest.rocks.length).toBeLessThanOrEqual(position === 'mountain' ? 3 : 4);
          const from = (position === 'mountain' ? CRESCENT_FROM_DEG.platform : CRESCENT_FROM_DEG.ground) * DEG;
          for (const b of nest.bags) {
            const bearing = Math.abs(bearingOf(b.x - eye.x, b.z - eye.z));
            expect(bearing).toBeGreaterThanOrEqual(from - 0.05); // the open front
            const d = Math.hypot(b.x - eye.x, b.z - eye.z);
            expect(d).toBeGreaterThan(BAG_RING_RADIUS - 0.1);
            expect(d).toBeLessThan(BAG_RING_RADIUS + 0.1);
            // below the eye, so even the view over the wings is open
            expect(b.y + b.hy).toBeLessThan(eye.y - 0.08);
            // resting on the surface (at most 2 cm sunk, and not floating)
            expect(b.y - b.hy - b.course * 0.135).toBeLessThan(nest.surface(b.x, b.z) + 0.01);
            expect(b.y - b.hy - b.course * 0.135).toBeGreaterThan(nest.surface(b.x, b.z) - 0.05);
          }
          for (const r of nest.rocks) {
            const bearing = Math.abs(bearingOf(r.x - eye.x, r.z - eye.z));
            expect(bearing).toBeGreaterThanOrEqual(ROCK_BEARING_MIN_DEG * DEG - 1e-9);
            expect(Math.hypot(r.x - eye.x, r.z - eye.z)).toBeGreaterThanOrEqual(2.2);
            expect(r.y).toBeLessThanOrEqual(nest.surface(r.x, r.z) + 0.12); // on the highest ground under it, sunk a little
            expect(r.y).toBeGreaterThan(nest.surface(r.x, r.z) - 0.3);
          }
        }
      });

      it(`${theme} / ${position}: nothing in the forward cone, nothing within a metre of the eye, and no box blocks any line of sight (several seeds)`, () => {
        for (const seed of SEEDS) {
          const m = bigMission(theme, seed, position);
          const nest = nestFor(m);
          const eye = nest.eye;
          for (const box of nest.boxes) {
            for (const c of corners(box)) {
              const d = Math.hypot(c.x - eye.x, c.z - eye.z);
              const bearing = Math.abs(bearingOf(c.x - eye.x, c.z - eye.z));
              // the whole view cone of 15 degrees either side of every target line (they lie within 12 degrees) stays clear
              expect(bearing, `${theme}/${position}/${seed}`).toBeGreaterThan(40 * DEG);
              expect(d).toBeGreaterThan(1.0);
              if (bearing < 90 * DEG) expect(d).toBeGreaterThan(1.1); // in front: well over 0.8 m
            }
          }
          // not a single eye -> target line (head, upper torso, engine, snipers) meets a box
          for (const p of aimPoints(m.layout, m.field)) {
            for (const box of nest.boxes) expect(segmentBox(eye, p, box)).toBeNull();
          }
          expect(blockedByExtra(m, nestObstacles(nest))).toEqual([]);
          // and the lines that were open are still open with the nest in the world
          const both = nestObstacles(nest);
          for (const p of aimPoints(m.layout, m.field)) {
            expect(lineOfSightClear(eye, p, m.field, both)).toBe(true);
          }
        }
      });
    }
  }

  it('the mountain platform is level behind and beside the eye, the natural ground in front, and never above a sight line', () => {
    for (const theme of THEMES) {
      for (const seed of SEEDS.slice(0, 3)) {
        const m = bigMission(theme, seed, 'mountain');
        const nest = nestFor(m);
        const { eye } = nest;
        const top = m.field.height(eye.x, eye.z) - 0.02;
        expect(nest.pad).not.toBeNull();
        expect(nest.pad?.top).toBeCloseTo(top, 9);
        for (let a = 0; a < 360; a += 5) {
          const t = a * DEG;
          for (const r of [0.5, 1.4, 2.5, PAD_FLAT_RADIUS - 0.1, PAD_EDGE_RADIUS + 1, 7]) {
            const x = eye.x + r * Math.sin(t);
            const z = eye.z - r * Math.cos(t);
            const natural = m.field.height(x, z);
            const y = nest.surface(x, z);
            expect(y).toBeGreaterThanOrEqual(natural - 1e-9); // fill only ever adds
            if (Math.min(a, 360 - a) <= 55 && r >= 0.5) expect(y).toBeCloseTo(natural, 6); // the natural ground in front
            if (Math.min(a, 360 - a) >= 100 && r <= PAD_FLAT_RADIUS - 0.1) expect(y).toBeCloseTo(top, 6); // level behind and beside
            if (r >= 7) expect(y).toBeCloseTo(natural, 6); // gone by the foot of the platform
          }
        }
        // every line of sight from the eye runs above the platform (checked along its first 8 m)
        for (const p of aimPoints(m.layout, m.field)) {
          const len = Math.hypot(p.x - eye.x, p.z - eye.z);
          for (let d = 0.3; d <= 8; d += 0.1) {
            const u = d / len;
            const x = eye.x + (p.x - eye.x) * u;
            const z = eye.z + (p.z - eye.z) * u;
            expect(eye.y + (p.y - eye.y) * u).toBeGreaterThan(nest.surface(x, z));
          }
        }
      }
    }
  });

  it('only the mountain has a platform', () => {
    expect(nestFor(bigMission('valley', 3, 'valley')).pad).toBeNull();
    expect(nestFor(bigMission('valley', 3, 'ridge')).pad).toBeNull();
  });

  it('the sandbag is a believable size', () => {
    expect(BAG_HALF.x * 2).toBeGreaterThan(0.4);
    expect(BAG_HALF.x * 2).toBeLessThan(0.65);
    expect(BAG_HALF.y * 2).toBeLessThan(0.25);
  });
});
