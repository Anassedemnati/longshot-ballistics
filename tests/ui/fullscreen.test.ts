import { describe, expect, it } from 'vitest';
import { fullscreenAvailable, fullscreenLabel, isFullscreen, onFullscreenChange, toggleFullscreen } from '../../src/ui/fullscreen';
import type { FullscreenDoc } from '../../src/ui/fullscreen';

/** A fake page: standard or WebKit-prefixed API, recording what was called. */
function fake(kind: 'standard' | 'webkit' | 'none', enabled?: boolean) {
  const log: string[] = [];
  const listeners = new Map<string, Array<() => void>>();
  const doc: FullscreenDoc = {
    documentElement: {},
    addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    removeEventListener: (type, fn) => listeners.set(type, (listeners.get(type) ?? []).filter((l) => l !== fn)),
  };
  if (kind === 'standard') {
    doc.documentElement.requestFullscreen = () => {
      log.push('request');
      doc.fullscreenElement = {} as Element;
    };
    doc.exitFullscreen = () => {
      log.push('exit');
      doc.fullscreenElement = null;
    };
    if (enabled !== undefined) doc.fullscreenEnabled = enabled;
  } else if (kind === 'webkit') {
    doc.documentElement.webkitRequestFullscreen = () => {
      log.push('webkitRequest');
      doc.webkitFullscreenElement = {} as Element;
    };
    doc.webkitExitFullscreen = () => {
      log.push('webkitExit');
      doc.webkitFullscreenElement = null;
    };
  }
  return { doc, log, listeners };
}

describe('fullscreen', () => {
  it('labels the button with what it will do', () => {
    expect(fullscreenLabel(false)).toBe('Fullscreen');
    expect(fullscreenLabel(true)).toBe('Exit fullscreen');
  });

  it('is available with the standard API or Safari\'s prefixed one, and not when disabled or missing', () => {
    expect(fullscreenAvailable(fake('standard').doc)).toBe(true);
    expect(fullscreenAvailable(fake('webkit').doc)).toBe(true);
    expect(fullscreenAvailable(fake('none').doc)).toBe(false);
    expect(fullscreenAvailable(fake('standard', false).doc)).toBe(false);
  });

  it('enters and leaves fullscreen, through the prefixed calls on Safari', () => {
    const s = fake('standard');
    toggleFullscreen(s.doc);
    expect(isFullscreen(s.doc)).toBe(true);
    toggleFullscreen(s.doc);
    expect(isFullscreen(s.doc)).toBe(false);
    expect(s.log).toEqual(['request', 'exit']);
    const w = fake('webkit');
    toggleFullscreen(w.doc);
    expect(isFullscreen(w.doc)).toBe(true);
    toggleFullscreen(w.doc);
    expect(w.log).toEqual(['webkitRequest', 'webkitExit']);
  });

  it('does nothing without the API, and swallows a refused request', () => {
    const none = fake('none');
    expect(() => toggleFullscreen(none.doc)).not.toThrow();
    const refused = fake('standard');
    refused.doc.documentElement.requestFullscreen = () => Promise.reject(new Error('no gesture'));
    expect(() => toggleFullscreen(refused.doc)).not.toThrow();
    const thrown = fake('standard');
    thrown.doc.documentElement.requestFullscreen = () => {
      throw new Error('denied');
    };
    expect(() => toggleFullscreen(thrown.doc)).not.toThrow();
  });

  it('listens to both change events and stops when told', () => {
    const s = fake('standard');
    let calls = 0;
    const off = onFullscreenChange(() => calls++, s.doc);
    for (const fn of s.listeners.get('fullscreenchange') ?? []) fn();
    for (const fn of s.listeners.get('webkitfullscreenchange') ?? []) fn();
    expect(calls).toBe(2);
    off();
    expect(s.listeners.get('fullscreenchange')).toEqual([]);
    expect(s.listeners.get('webkitfullscreenchange')).toEqual([]);
  });
});
