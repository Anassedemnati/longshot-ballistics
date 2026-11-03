import type { Vec3 } from '../ballistics/types';
import type { TerrainField } from '../scene/terrainField';
import { propFootprintRadius } from './props';
import type { PropKind } from './props';
import type { Rng } from './random';

// How good a place is for an enemy sniper to hide (pure, no three.js; `layout.ts` gathers the places that pass its hard
// line-of-sight rules and picks among the best by these scores). A hide is better when the sniper
//   - has height over the shooter (he looks down on the battlefield),
//   - is not skylined: from the shooter's eye there is ground behind him, not sky (a backdrop breaks up his outline),
//   - has hard cover close by (a wall, a vehicle, a shed or a house within a few metres),
//   - lies away from the soldiers the player is shooting at, not in their group,
//   - lies off to a flank, away from the centre line the player's own attention is on,
//   - lies on a roof (a good site, but one among several).
// Each of these is a number in -1..1 or 0..1 (see the functions) and `scoreHide` adds them with the weights below.

/** The tuning numbers of the hide score. */
export const HIDE = {
  /** Height over the shooter's eye, m, that earns the full height score (and its negative, the full penalty): the score is clipped to -1..1. */
  heightRefM: 20,
  /**
   * The ground behind the sniper is looked at along the line from the shooter's eye through his head, extended past him: sampled from this
   * far beyond him (m) to this far, every `backdropStepM`. Terrain that meets the line within the window is his backdrop; the sooner it
   * does the better, and none at all is the sky.
   */
  backdropFromM: 20,
  backdropToM: 400,
  backdropStepM: 20,
  /** Hard cover counts in full when its nearest edge is this far from the sniper, m, at least... */
  coverNearM: 3,
  /** ... and at most this far; beyond it the score fades linearly to nothing over `coverFadeM`. Nearer than `coverNearM` it is worth `coverTooCloseScore`. */
  coverFarM: 12,
  coverFadeM: 13,
  coverTooCloseScore: 0.5,
  /** A sniper this far (m) from the nearest soldier, or farther, is fully apart from the group. */
  apartFullM: 40,
  /** A sniper at this bearing off the centre line, rad, or more, is fully on a flank. */
  flankFullRad: (8 * Math.PI) / 180,
  /** Weights of the five terms. */
  weights: { height: 1, backdrop: 1.5, cover: 0.6, apart: 1.2, flank: 0.4 },
  /**
   * What each kind of site is worth on its own: a roof is a good place to lie (a platform with a view over everything around it), a ridge a fair one.
   * Tuned (with the weights and the pick floor, over 210 missions with houses at each position) so that a roof wins about one hide in ten from the
   * valley floor, where it stands against the sky, three in ten to four in ten from the ridge, where the valley walls make better hides, and about
   * four in five from the mountain, where the ground behind every roof is a backdrop and the houses are the hard cover.
   */
  site: { roof: 2, ridge: 0.2, open: 0 },
  /** The placement picks among this many hides: the best of each kind of site, then the best of the rest... */
  pickFrom: 4,
  /** ... with chances in proportion to exp((score - best) / pickTemperature): near-equal hides are about as likely, a clearly better one is favoured, ... */
  pickTemperature: 0.5,
  /** ... but none of them is worth less than this share of the best one's chance, so a kind of site that scores lower everywhere (the ground, from a mountain) still turns up now and then. */
  pickFloor: 0.25,
} as const;

/** Where the sniper lies, as far as the score is concerned. */
export type HideSite = keyof typeof HIDE.site;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** -1..1: how far his head is above (+) or below (-) the shooter's eye (`headAboveEyeM`, m), `HIDE.heightRefM` metres being the whole range. */
export function heightScore(headAboveEyeM: number): number {
  return clamp(headAboveEyeM / HIDE.heightRefM, -1, 1);
}

/**
 * -1..1: what the shooter sees behind the sniper. The eye -> head line is extended past him, the terrain under it sampled (horizontally
 * 20 to 400 m beyond him, every 20 m), and the first place where the ground reaches the line is his backdrop: against a hillside right
 * behind him (20 m) the score is +1 and his outline is broken up; the farther back the first ground is the less it helps, down to -1
 * for none within 400 m, a bare crest against the sky. Comparing with the line, not with the height of his head, is what makes it right
 * from a ridge or a mountain, where the shooter looks down and nearly everything lies below the sniper's head, and what lets a roof on a
 * plain count for something: the line from a high eye meets the plain a little way behind it.
 */
export function backdropScore(field: Pick<TerrainField, 'height'>, eye: Vec3, head: Vec3): number {
  const dx = head.x - eye.x;
  const dz = head.z - eye.z;
  const range = Math.hypot(dx, dz);
  if (!(range > 1e-6)) return 0;
  const ux = dx / range;
  const uz = dz / range;
  const slope = (head.y - eye.y) / range;
  const from = HIDE.backdropFromM;
  const to = HIDE.backdropToM;
  for (let d = from; d <= to + 1e-9; d += HIDE.backdropStepM) {
    if (field.height(head.x + ux * d, head.z + uz * d) >= head.y + slope * d) return 1 - 2 * clamp((d - from) / (to - from), 0, 1);
  }
  return -1;
}

/**
 * 0..1: what hard cover this near is worth, `gapM` being the distance from the sniper to the nearest edge of a wall, vehicle, shed
 * or house (negative inside one: he lies on its roof, which is the roof's bonus, not cover). Full from 3 to 12 m, half when
 * right beside him, fading to nothing over the next 13 m, and 0 when there is none (Infinity).
 */
export function coverScore(gapM: number): number {
  if (!(gapM >= 0)) return 0;
  if (gapM < HIDE.coverNearM) return HIDE.coverTooCloseScore;
  if (gapM <= HIDE.coverFarM) return 1;
  return clamp(1 - (gapM - HIDE.coverFarM) / HIDE.coverFadeM, 0, 1);
}

/** 0..1: how far he is from the nearest soldier: 40 m or more is fully apart, on top of one is 0 (Infinity, with no soldiers, is fully apart). */
export function apartScore(nearestSoldierM: number): number {
  return clamp(nearestSoldierM / HIDE.apartFullM, 0, 1);
}

/** 0..1: how far off the centre line he lies: 8 degrees or more is a full flank. */
export function flankScore(bearingRad: number): number {
  return clamp(Math.abs(bearingRad) / HIDE.flankFullRad, 0, 1);
}

/** What the score is made of for one hide. */
export interface HideTerms {
  /** His head's height over the shooter's eye, m. */
  headAboveEyeM: number;
  /** `backdropScore`. */
  backdrop: number;
  /** Distance to the nearest edge of hard cover, m (Infinity when there is none; negative while lying on a roof). */
  coverGapM: number;
  /** Distance to the nearest soldier, m. */
  nearestSoldierM: number;
  /** Bearing off the centre line, rad. */
  bearingRad: number;
  site: HideSite;
}

/** The weighted sum of the terms: higher is a better hide. Nothing here decides validity (the line-of-sight rules do that, before the score). */
export function scoreHide(t: HideTerms): number {
  const w = HIDE.weights;
  return (
    w.height * heightScore(t.headAboveEyeM) +
    w.backdrop * t.backdrop +
    w.cover * coverScore(t.coverGapM) +
    w.apart * apartScore(t.nearestSoldierM) +
    w.flank * flankScore(t.bearingRad) +
    HIDE.site[t.site]
  );
}

/** Hard cover for a sniper: everything solid enough to lie beside. */
const HARD_COVER: ReadonlySet<PropKind> = new Set<PropKind>(['wall', 'truck', 'jeep', 'shed', 'house']);

/**
 * Distance from (x, z) to the nearest edge of any hard cover in `props` (a footprint circle each; negative inside one), m; Infinity
 * when there is none.
 */
export function nearestCoverGap(x: number, z: number, props: ReadonlyArray<{ kind: PropKind; x: number; z: number }>): number {
  let gap = Infinity;
  for (const p of props) {
    if (!HARD_COVER.has(p.kind)) continue;
    gap = Math.min(gap, Math.hypot(p.x - x, p.z - z) - propFootprintRadius(p.kind));
  }
  return gap;
}

/** A hide as the pick sees it: its score and the kind of site. */
export interface HideChoice {
  score: number;
  site: HideSite;
}

/**
 * One of the hides in `scored`, picked with `rng`: from a pool of `HIDE.pickFrom` of them (the best of each kind of site, highest
 * first, then the best of the rest), each with a chance in proportion to exp((score - best) / HIDE.pickTemperature) and at least
 * `HIDE.pickFloor` of the best one's. So another seed gives another hide, near-equal hides are about as likely, and no kind of site
 * is ever shut out by the others (a roof is never automatic, nor ruled out). Returns the index into `scored`, or -1 when it is
 * empty. One draw from `rng` whenever there is something to pick from.
 */
export function pickHide(scored: ReadonlyArray<HideChoice>, rng: Rng): number {
  if (scored.length === 0) return -1;
  const order = scored.map((_, i) => i).sort((a, b) => scored[b].score - scored[a].score || a - b);
  const pool: number[] = [];
  const kinds = new Set<HideSite>();
  for (const i of order) {
    if (kinds.has(scored[i].site)) continue;
    kinds.add(scored[i].site);
    pool.push(i);
  }
  for (const i of order) {
    if (pool.length >= HIDE.pickFrom) break;
    if (!pool.includes(i)) pool.push(i);
  }
  pool.sort((a, b) => scored[b].score - scored[a].score || a - b);
  const best = scored[pool[0]].score;
  const weights = pool.map((i) => Math.max(Math.exp((scored[i].score - best) / HIDE.pickTemperature), HIDE.pickFloor));
  let roll = rng() * weights.reduce((a, b) => a + b, 0);
  for (let k = 0; k < pool.length; k++) {
    roll -= weights[k];
    if (roll < 0) return pool[k];
  }
  return pool[pool.length - 1];
}
