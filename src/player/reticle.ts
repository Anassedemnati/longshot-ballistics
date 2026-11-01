import { milToPixels } from '../game/aim';

// First-focal-plane MRAD reticle: every position and size scales with the optical zoom, so a
// hash mark always spans the same angle on target. Angles in mils; sizes below are in mils too.

/** Hash marks (full mils) and half-mil ticks extend to these angles on both axes. */
const HASH_MAX_MIL = 10;
const HALF_MIL_MAX = 5;
/** Beyond this angle the cross hairs become thick posts running out to the edge of the view. */
const POST_START_MIL = 10;
/** Numbered hashes (below the centre). */
const NUMBERED_MILS = [2, 4, 6, 8, 10];

/** Half-length of each kind of tick, mils. */
const TICK_HALF_MIL = 0.25;
const TICK_HALF_NUMBERED = 0.4;
const TICK_HALF_HALF_MIL = 0.12;

/** Stroke widths, CSS px, scaled from mils but never thinner than the minimum so lines stay visible. */
const THIN_MIL = 0.04;
const THIN_MIN_PX = 1;
const POST_MIL = 0.5;
const POST_MIN_PX = 2;
const LABEL_MIL = 0.6;
const LABEL_MIN_PX = 9;
const LABEL_GAP_MIL = 0.15;

const INK = '#000';

/**
 * Draw the scope reticle. Sizes the canvas backing store to css * dpr, then draws in CSS pixels.
 * Call again whenever the viewport size, devicePixelRatio or magnification changes.
 */
export function drawReticle(
  ctx: CanvasRenderingContext2D,
  cssWidth: number,
  cssHeight: number,
  vfovRad: number,
  dpr: number,
): void {
  const canvas = ctx.canvas;
  const backingWidth = Math.round(cssWidth * dpr);
  const backingHeight = Math.round(cssHeight * dpr);
  // Assigning width/height reallocates and clears the canvas; only do it when the size changes.
  if (canvas.width !== backingWidth) canvas.width = backingWidth;
  if (canvas.height !== backingHeight) canvas.height = backingHeight;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const cx = cssWidth / 2;
  const cy = cssHeight / 2;
  const px = (mils: number): number => milToPixels(mils, vfovRad, cssHeight);

  const thin = Math.max(THIN_MIN_PX, px(THIN_MIL));
  const post = Math.max(POST_MIN_PX, px(POST_MIL));
  const reach = px(HASH_MAX_MIL);

  ctx.fillStyle = INK;
  ctx.strokeStyle = INK;
  ctx.lineWidth = thin;
  ctx.lineCap = 'butt';

  // Thin cross hairs out to 10 mil, with ticks, in one path.
  ctx.beginPath();
  ctx.moveTo(cx - reach, cy);
  ctx.lineTo(cx + reach, cy);
  ctx.moveTo(cx, cy - reach);
  ctx.lineTo(cx, cy + reach);

  for (let half = 1; half <= HASH_MAX_MIL * 2; half++) {
    const mil = half / 2;
    const isFullMil = half % 2 === 0;
    if (!isFullMil && mil > HALF_MIL_MAX) continue;
    const halfLength = isFullMil
      ? px(NUMBERED_MILS.includes(mil) ? TICK_HALF_NUMBERED : TICK_HALF_MIL)
      : px(TICK_HALF_HALF_MIL);
    const d = px(mil);
    for (const sign of [-1, 1]) {
      // Ticks across the vertical stem (horizontal dashes) ...
      ctx.moveTo(cx - halfLength, cy + sign * d);
      ctx.lineTo(cx + halfLength, cy + sign * d);
      // ... and across the horizontal stem (vertical dashes).
      ctx.moveTo(cx + sign * d, cy - halfLength);
      ctx.lineTo(cx + sign * d, cy + halfLength);
    }
  }
  ctx.stroke();

  // Thick posts from 10 mil to the edge of the view, in all four directions.
  const start = px(POST_START_MIL);
  const halfPost = post / 2;
  ctx.fillRect(cx + start, cy - halfPost, Math.max(0, cssWidth - (cx + start)), post); // right
  ctx.fillRect(0, cy - halfPost, Math.max(0, cx - start), post); // left
  ctx.fillRect(cx - halfPost, cy + start, post, Math.max(0, cssHeight - (cy + start))); // bottom
  ctx.fillRect(cx - halfPost, 0, post, Math.max(0, cy - start)); // top

  // Numbers 2, 4, 6, 8, 10 beside the lower half of the vertical stem.
  const labelPx = Math.max(LABEL_MIN_PX, px(LABEL_MIL));
  ctx.font = `${labelPx}px sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const labelX = cx + px(TICK_HALF_NUMBERED + LABEL_GAP_MIL);
  // At low zoom the numbers are closer together than their own height and would overprint.
  if (px(NUMBERED_MILS[0]) >= labelPx) {
    for (const mil of NUMBERED_MILS) {
      ctx.fillText(String(mil), labelX, cy + px(mil));
    }
  }
}
