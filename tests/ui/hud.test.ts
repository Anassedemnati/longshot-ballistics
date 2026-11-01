import { describe, expect, it } from 'vitest';
import { soundLabel } from '../../src/ui/hud';

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
