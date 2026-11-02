import { describe, expect, it } from 'vitest';
import { FrameGovernor, QUALITY, SCALE_STEPS, pixelRatioFor, qualityFromSearch, settingsFor } from '../../src/scene/quality';
import type { GovernorAction } from '../../src/scene/quality';

describe('qualityFromSearch', () => {
  it('is auto by default, ignoring the mission code', () => {
    expect(qualityFromSearch('')).toEqual({ choice: 'auto', post: null });
    expect(qualityFromSearch('?m=v2.d.300.300.1.0.0.9.308.n.n.1.r.0.0.0&debug=1')).toEqual({ choice: 'auto', post: null });
    expect(qualityFromSearch('?quality=ultra')).toEqual({ choice: 'auto', post: null });
  });

  it('reads ?quality=', () => {
    for (const q of ['auto', 'high', 'medium', 'low'] as const) expect(qualityFromSearch(`?quality=${q}`).choice).toBe(q);
  });

  it('maps the older ?post= onto it: high -> high, low and off -> low (off keeps no post chain)', () => {
    expect(qualityFromSearch('?post=high')).toEqual({ choice: 'high', post: 'high' });
    expect(qualityFromSearch('?post=low')).toEqual({ choice: 'low', post: 'low' });
    expect(qualityFromSearch('?post=off')).toEqual({ choice: 'low', post: 'off' });
    expect(qualityFromSearch('?post=wat')).toEqual({ choice: 'auto', post: null });
  });

  it('?quality= wins over ?post=, which then only picks the post chain', () => {
    expect(qualityFromSearch('?quality=medium&post=off')).toEqual({ choice: 'medium', post: 'off' });
    expect(settingsFor('medium', 'off')).toMatchObject({ level: 'medium', post: 'off', fxaa: false, shadowMapSize: QUALITY.medium.shadowMapSize });
    expect(settingsFor('high', 'low')).toMatchObject({ level: 'high', post: 'low', samples: 2 });
    expect(settingsFor('low', null)).toBe(QUALITY.low);
  });
});

describe('quality levels', () => {
  it('step down in cost: multisampling and bloom only on high, FXAA only where there is none, smaller shadow map and fewer plants below', () => {
    expect(QUALITY.high).toMatchObject({ post: 'high', samples: 2, fxaa: false }); // multisampled already
    expect(QUALITY.medium).toMatchObject({ post: 'high', samples: 0, fxaa: true }); // bloom kept (the muzzle flash, the sun), FXAA instead of multisampling
    expect(QUALITY.low).toMatchObject({ post: 'low', samples: 0, fxaa: false });
    const order = [QUALITY.high, QUALITY.medium, QUALITY.low];
    for (let i = 1; i < order.length; i++) {
      expect(order[i].shadowMapSize).toBeLessThanOrEqual(order[i - 1].shadowMapSize);
      expect(order[i].vegetationScale).toBeLessThanOrEqual(order[i - 1].vegetationScale);
      expect(order[i].detailScale).toBeLessThanOrEqual(order[i - 1].detailScale);
      expect(order[i].pixelRatioCap).toBeLessThanOrEqual(order[i - 1].pixelRatioCap);
      expect(order[i].shadowEvery).toBeGreaterThanOrEqual(order[i - 1].shadowEvery);
    }
    expect(QUALITY.high.vegetationScale).toBe(1);
  });

  it('the pixel ratio is the display\'s, capped by the level, times the governor\'s scale, never below 0.3', () => {
    expect(pixelRatioFor(QUALITY.medium, 2, 1)).toBe(1); // a retina screen renders at 1x on medium
    expect(pixelRatioFor(QUALITY.high, 2, 1)).toBe(1.5);
    expect(pixelRatioFor(QUALITY.high, 1, 0.6)).toBeCloseTo(0.6, 9);
    expect(pixelRatioFor(QUALITY.medium, 0.5, 1)).toBe(0.5);
    expect(pixelRatioFor(QUALITY.low, NaN, 1)).toBe(1);
    expect(pixelRatioFor(QUALITY.low, 1, 0.001)).toBe(0.3);
  });
});

describe('FrameGovernor', () => {
  /** Feed `seconds` of frames of `ms` each; returns the actions taken, with the time they came at. */
  function run(g: FrameGovernor, ms: number, seconds: number, at = { t: 0 }): Array<GovernorAction & { t: number }> {
    const out: Array<GovernorAction & { t: number }> = [];
    for (let i = 0; i < (seconds * 1000) / ms; i++) {
      at.t += ms / 1000;
      const a = g.frame(ms);
      if (a) out.push({ ...a, t: at.t });
    }
    return out;
  }

  it('does nothing while the frames are fast', () => {
    const g = new FrameGovernor(false);
    expect(run(g, 12, 30)).toEqual([]);
    expect(g.scale).toBe(1);
  });

  it('does nothing in the warm-up however slow (shader compiles, uploads), then steps the scale down one step at a time while slow', () => {
    const g = new FrameGovernor(false);
    const actions = run(g, 30, 12);
    expect(actions.length).toBeGreaterThanOrEqual(3);
    expect(actions[0].kind).toBe('scale');
    expect(actions.slice(0, 3).map((a) => (a.kind === 'scale' ? a.index : -1))).toEqual([1, 2, 3]); // one step each
    expect(g.scale).toBe(SCALE_STEPS[SCALE_STEPS.length - 1]); // and no further than the last step
    expect(actions[0].t).toBeGreaterThan(4); // after the start-up seconds, however many frames they held
    for (let i = 1; i < actions.length; i++) expect(actions[i].t - actions[i - 1].t).toBeGreaterThanOrEqual(1.49); // hysteresis: a hold between steps
  });

  it('the first seconds never count, even at a high frame rate; a few hitches in a fast run do not step it down', () => {
    const g = new FrameGovernor(false);
    const clock = { t: 0 };
    // 3.5 s of hitching frames (loading): nothing happens
    expect(run(g, 90, 3.5, clock)).toEqual([]);
    // then fast frames with an occasional 150 ms hitch (a texture upload): still nothing
    const actions: GovernorAction[] = [];
    for (let i = 0; i < 400; i++) {
      const a = g.frame(i % 40 === 0 ? 150 : 12);
      if (a) actions.push(a);
    }
    expect(actions).toEqual([]);
    expect(g.scale).toBe(1);
  });

  it('ignores stalls (a hidden tab, a long compile)', () => {
    const g = new FrameGovernor(false);
    run(g, 12, 3);
    for (let i = 0; i < 100; i++) expect(g.frame(1200)).toBeNull();
    expect(g.scale).toBe(1);
    expect(g.frame(0)).toBeNull();
    expect(g.frame(NaN)).toBeNull();
  });

  it('probes a step up after a while, keeps it when it holds, and takes it back (and asks later) when it does not', () => {
    const g = new FrameGovernor(false, { probeAfterS: 10, warmupS: 0 });
    const clock = { t: 0 };
    const down = run(g, 30, 5, clock); // slow: down
    expect(down.length).toBeGreaterThan(0);
    const level = g.scaleIndex;
    // now the frames are fast at the lower scale: after the probe delay it tries one step up
    const probe = run(g, 12, 14, clock);
    expect(probe[0]).toMatchObject({ kind: 'scale', index: level - 1 });
    // it holds (frames stay fast): no step back down
    expect(probe.filter((a) => a.kind === 'scale' && a.index > level - 1)).toEqual([]);
    // a failing probe: slow again at the higher scale -> back down, and the next probe waits longer
    const g2 = new FrameGovernor(false, { probeAfterS: 10, warmupS: 0 });
    const clock2 = { t: 0 };
    run(g2, 30, 5, clock2);
    const idx = g2.scaleIndex;
    const up = run(g2, 12, 12, clock2);
    expect(up.some((a) => a.kind === 'scale' && a.index === idx - 1)).toBe(true);
    const back = run(g2, 30, 6, clock2);
    expect(back.some((a) => a.kind === 'scale' && a.index === idx)).toBe(true);
    const upT = run(g2, 12, 12, clock2);
    expect(upT.filter((a) => a.kind === 'scale' && a.index === idx - 1)).toEqual([]); // 20 s now, not 10
    const later = run(g2, 12, 10, clock2);
    expect(later.some((a) => a.kind === 'scale' && a.index === idx - 1)).toBe(true);
  });

  it('in auto, a hopeless first few seconds at full resolution drops the level to low (once); a fair machine keeps it', () => {
    const slow = new FrameGovernor(true);
    const a = run(slow, 45, 10);
    expect(a[0]).toEqual(expect.objectContaining({ kind: 'level', level: 'low' }));
    expect(a.filter((x) => x.kind === 'level')).toHaveLength(1);
    const fair = new FrameGovernor(true);
    expect(run(fair, 20, 10).filter((x) => x.kind === 'level')).toEqual([]);
    const notAuto = new FrameGovernor(false);
    expect(run(notAuto, 45, 10).filter((x) => x.kind === 'level')).toEqual([]);
  });
});
