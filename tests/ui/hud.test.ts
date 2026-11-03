import { describe, expect, it } from 'vitest';
import { hintText, rangeText, soundLabel, targetsText, windText } from '../../src/ui/hud';

describe('soundLabel', () => {
  it('asks for a click until the audio context is running', () => {
    expect(soundLabel(false, false)).toBe('Sound: click to start');
    expect(soundLabel(false, true)).toBe('Sound: click to start');
  });

  it('says Sound on (M) once it runs, Muted (M) when muted', () => {
    expect(soundLabel(true, false)).toBe('Sound on (M)');
    expect(soundLabel(true, true)).toBe('Muted (M)');
  });

  it('says so when the browser has no usable audio', () => {
    expect(soundLabel(false, false, false)).toBe('Sound unavailable');
    expect(soundLabel(false, true, false)).toBe('Sound unavailable');
  });
});

describe('hintText', () => {
  it('lists the basic keys, and nothing about cover or assists when the mission has neither', () => {
    const text = hintText();
    for (const key of ['Click to take aim', 'Left click fire', 'Right click scope', 'Wheel zoom', 'R reload', 'F fullscreen', 'M mute', 'Esc release mouse']) {
      expect(text).toContain(key);
    }
    expect(text).not.toMatch(/\bC cover|T\/A\/P/);
  });

  it('adds C (cover) with snipers, and T/A/P with assists, before the Esc key', () => {
    expect(hintText({ cover: true })).toContain('M mute  ·  C cover  ·  Esc release mouse');
    expect(hintText({ assists: true })).toContain('M mute  ·  T/A/P assists  ·  Esc release mouse');
    expect(hintText({ cover: true, assists: true })).toContain('C cover  ·  T/A/P assists  ·  Esc');
    expect(hintText({ cover: true, assists: true })).not.toContain('\n'); // one line
  });

  it('lists F fullscreen, unless the browser has none', () => {
    expect(hintText()).toContain('R reload  ·  F fullscreen  ·  M mute');
    expect(hintText({ fullscreen: false })).not.toContain('fullscreen');
  });
});

describe('windText', () => {
  it('gives the speed and the clock direction', () => {
    expect(windText(4.5, 9)).toBe("Wind 4.5 m/s from 9 o'clock (left)");
    expect(windText(12, 3)).toBe("Wind 12.0 m/s from 3 o'clock (right)");
    expect(windText(0.1, 12)).toBe("Wind 0.1 m/s from 12 o'clock (downrange)");
  });

  it('says calm when there is no wind', () => {
    expect(windText(0, 9)).toBe('Wind calm');
    expect(windText(0.04, 9)).toBe('Wind calm');
  });
});

describe('targetsText', () => {
  it('shows the targets left out of the total', () => {
    expect(targetsText(3, 5)).toBe('Targets 3/5');
    expect(targetsText(0, 1)).toBe('Targets 0/1');
  });
});

describe('rangeText', () => {
  it('rounds the rangefinder reading to whole metres', () => {
    expect(rangeText(733.6)).toBe('Range 734 m');
    expect(rangeText(57.4)).toBe('Range 57 m');
  });

  it('shows a dash when nothing is under the crosshair', () => {
    expect(rangeText(null)).toBe('Range —');
    expect(rangeText(NaN)).toBe('Range —');
  });
});
