import { describe, expect, it } from 'vitest';
import { magnificationToVfov, milToPixels } from '../../src/game/aim';
import { MAG_DEFAULT, MAG_MAX, MAG_MIN } from '../../src/player/view';
import { drawReticle } from '../../src/player/reticle';

const WIDTH = 1280;
const HEIGHT = 720;
const CX = WIDTH / 2;

interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Draw the reticle on a recording fake context and return its stroked line segments and labels. */
function draw(
  mag: number,
  width = WIDTH,
  height = HEIGHT,
): { segments: Segment[]; labels: Array<{ text: string; x: number; y: number }> } {
  const segments: Segment[] = [];
  const labels: Array<{ text: string; x: number; y: number }> = [];
  let pen = { x: 0, y: 0 };
  const ctx = {
    canvas: { width: 0, height: 0 },
    setTransform: () => undefined,
    clearRect: () => undefined,
    beginPath: () => undefined,
    stroke: () => undefined,
    fillRect: () => undefined,
    moveTo: (x: number, y: number) => {
      pen = { x, y };
    },
    lineTo: (x: number, y: number) => {
      segments.push({ x1: pen.x, y1: pen.y, x2: x, y2: y });
      pen = { x, y };
    },
    fillText: (text: string, x: number, y: number) => labels.push({ text, x, y }),
  };
  drawReticle(ctx as unknown as CanvasRenderingContext2D, width, height, magnificationToVfov(mag), 1);
  return { segments, labels };
}

/** Half-length of the tick that crosses the stem at `mil` below the centre (a horizontal dash). */
function tickHalfLength(segments: Segment[], mil: number, vfov: number, height = HEIGHT): number {
  const y = height / 2 + milToPixels(mil, vfov, height);
  const tick = segments.find((s) => s.y1 === s.y2 && Math.abs(s.y1 - y) < 1e-6);
  if (!tick) throw new Error(`no tick at ${mil} mil`);
  return (tick.x2 - tick.x1) / 2;
}

describe('scope magnification', () => {
  it('opens at 8x, inside the 4x-25x range', () => {
    expect(MAG_DEFAULT).toBe(8);
    expect(MAG_DEFAULT).toBeGreaterThanOrEqual(MAG_MIN);
    expect(MAG_DEFAULT).toBeLessThanOrEqual(MAG_MAX);
    expect(MAG_MAX).toBe(25);
  });
});

describe('reticle ticks stay visible at low magnification', () => {
  for (const mag of [MAG_MIN, MAG_DEFAULT, 12, MAG_MAX]) {
    it(`every tick is at least 3 px each side of the stem at ${mag}x, and bigger marks are longer`, () => {
      const vfov = magnificationToVfov(mag);
      const { segments } = draw(mag);
      const half = tickHalfLength(segments, 0.5, vfov); // half-mil tick
      const full = tickHalfLength(segments, 1, vfov); // full-mil tick
      const numbered = tickHalfLength(segments, 2, vfov); // numbered mil
      expect(half).toBeGreaterThanOrEqual(3);
      expect(full).toBeGreaterThan(half);
      expect(numbered).toBeGreaterThan(full);
    });
  }

  it('at 8x the numbers sit clear of the numbered ticks', () => {
    const vfov = magnificationToVfov(MAG_DEFAULT);
    const { segments, labels } = draw(MAG_DEFAULT);
    const numberedHalf = tickHalfLength(segments, 2, vfov);
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) expect(label.x).toBeGreaterThan(CX + numberedHalf);
  });

  it('on a big screen the marks keep their true angular size (the floor only lifts small ones)', () => {
    const height = 2160;
    const vfov = magnificationToVfov(MAG_MAX);
    const { segments } = draw(MAG_MAX, 3840, height);
    expect(tickHalfLength(segments, 2, vfov, height)).toBeCloseTo(milToPixels(0.4, vfov, height), 6);
    expect(tickHalfLength(segments, 1, vfov, height)).toBeCloseTo(milToPixels(0.25, vfov, height), 6);
    expect(tickHalfLength(segments, 0.5, vfov, height)).toBeCloseTo(milToPixels(0.12, vfov, height), 6);
  });
});
