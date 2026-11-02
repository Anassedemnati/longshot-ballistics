import { describe, expect, it } from 'vitest';
import { flashIntensity, threatText } from '../../src/ui/threat';
import type { ThreatState } from '../../src/ui/threat';

const state = (over: Partial<ThreatState> = {}): ThreatState => ({
  health: 100,
  detection: 0,
  covered: false,
  snipersLeft: 2,
  warning: 0,
  firing: false,
  fireIn: 4,
  paused: false,
  failed: false,
  cleared: false,
  ...over,
});

describe('threatText', () => {
  it('says the enemy is searching while the player is not detected, and tells him about cover', () => {
    expect(threatText(state())).toBe('EXPOSED · Health 100 · Detection 0 % · 2 snipers left · Enemy searching · C: cover');
  });

  it('counts down to the next sniper shot once detected', () => {
    const text = threatText(state({ detection: 70.4, firing: true, fireIn: 2.13, health: 82 }));
    expect(text).toBe('EXPOSED · Health 82 · Detection 70 % · 2 snipers left · SNIPER FIRING IN 2.1 s');
  });

  it('warns of a bombardment with its own countdown, and the cover key', () => {
    const text = threatText(state({ detection: 100, firing: true, fireIn: 1, warning: 3.04 }));
    expect(text).toContain('INCOMING BOMBARDMENT 3.0 s — C: COVER');
    expect(text).not.toContain('SNIPER FIRING IN');
  });

  it('shows IN COVER, and singular sniper', () => {
    const text = threatText(state({ covered: true, snipersLeft: 1 }));
    expect(text.startsWith('IN COVER')).toBe(true);
    expect(text).toContain('1 sniper left');
  });

  it('rounds health up, so a living player never reads 0', () => {
    expect(threatText(state({ health: 0.4 }))).toContain('Health 1');
  });

  it('says so while the game is paused', () => {
    expect(threatText(state({ paused: true }))).toContain('PAUSED — click to resume');
    expect(threatText(state({ paused: false }))).not.toContain('PAUSED');
  });

  it('says the mission is failed, or that every sniper is down', () => {
    expect(threatText(state({ failed: true, health: 0 }))).toBe('MISSION FAILED · you were killed');
    expect(threatText(state({ cleared: true, snipersLeft: 0, health: 64 }))).toBe('ALL SNIPERS DOWN · threat cleared · Health 64');
  });
});

describe('flashIntensity', () => {
  it('is 0 for no damage and grows with the damage, up to 0.6', () => {
    expect(flashIntensity(0)).toBe(0);
    expect(flashIntensity(-5)).toBe(0);
    expect(flashIntensity(Number.NaN)).toBe(0);
    expect(flashIntensity(5)).toBeLessThan(flashIntensity(18));
    expect(flashIntensity(18)).toBeLessThan(flashIntensity(45));
    expect(flashIntensity(45)).toBeLessThanOrEqual(0.6);
    expect(flashIntensity(1000)).toBe(0.6);
  });
});
