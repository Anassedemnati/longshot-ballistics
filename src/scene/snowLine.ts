// Where the snow starts (pure, no three.js): the terrain shader lays snow caps from `line` m up (full `band` m higher, wobbled by
// about +-14 m of noise), and the tree placement (mission/scatter.ts) stops its firs at the same lines, so trees never stand in
// the snow caps. One source for both.

export interface SnowLine {
  /** Height at which snow caps begin, m. */
  line: number;
  /** Over how many metres above `line` they grow to full cover. */
  band: number;
}

/** The snow lines of the themes that have snow caps (the desert has none). */
export const SNOW_LINES: Readonly<Record<'arctic' | 'valley', SnowLine>> = {
  arctic: { line: 65, band: 45 },
  // The valley's walls run 55-194 m: 70 m would whiten most of the green hills.
  valley: { line: 100, band: 50 },
};
