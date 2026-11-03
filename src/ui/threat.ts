// The threat HUD of a mission with enemy snipers: one line at the top of the screen (exposed or in
// cover, health, detection, snipers left and the countdown to the next incoming fire), the damage flash
// and the cover mask. All DOM, styled in index.html. The text and the flash level are pure functions.

import type { Awareness } from '../game/encounter';
import type { SquadState } from '../game/squad';

/** What the threat line shows. */
export interface ThreatState {
  health: number;
  /** 0..100 %. */
  detection: number;
  covered: boolean;
  snipersLeft: number;
  /** Seconds until a called bombardment lands; 0 when none is coming. */
  warning: number;
  /** The snipers are firing (detection at or above the threshold). */
  firing: boolean;
  /** How well the snipers know where the player is (`firing` goes with `firing` above). */
  awareness: Awareness;
  /** The player wears a ghillie suit. */
  camo: boolean;
  /** Seconds until the next sniper shot. */
  fireIn: number;
  /** The game is not running (pointer free). */
  paused: boolean;
  /** The player is dead. */
  failed: boolean;
  /** No sniper is left: the threat is over. */
  cleared: boolean;
  /** The soldiers fight back: how well their squad knows where the player is (absent: the soldiers stand still, there is no squad line). */
  squad?: SquadState;
  /** The bombardment on its way (`warning` > 0) was called by the soldiers' mortar, not by a sniper. */
  mortar?: boolean;
  /** The mission has no enemy snipers at all: the line leaves out the detection, the sniper count and what the snipers know. */
  noSnipers?: boolean;
}

/** What the threat line says of the squad: it is told, not guessed, from how much of the player's position the squad has. */
const SQUAD_TEXT: Record<SquadState, string> = {
  unaware: 'Squad unaware',
  alerted: 'Squad alerted',
  searching: 'Squad searching for you',
  engaging: 'Squad has found you',
};

/** A countdown in tenths of a second: the unit it is shown in, and the unit the line is rebuilt in. */
const tenths = (seconds: number): number => Math.round(seconds * 10);
const showTenths = (seconds: number): string => (tenths(seconds) / 10).toFixed(1);

/**
 * The threat line, e.g. "EXPOSED · Health 82 · Detection 70 % · 2 snipers left · SNIPER FIRING IN 2.1 s". When nothing is
 * coming it says what the snipers know: "Enemy unaware" (and "ghillie suit" when he wears one) until a shot or the exposure
 * gives him away, then "Enemy searching for you · C: cover".
 */
export function threatText(s: ThreatState): string {
  if (s.failed) return 'MISSION FAILED · you were killed';
  if (s.cleared) return `${s.noSnipers ? 'SQUAD DOWN' : 'ALL SNIPERS DOWN'} · threat cleared · Health ${Math.ceil(s.health)}`;
  const parts: string[] = [s.covered ? 'IN COVER' : 'EXPOSED', `Health ${Math.ceil(s.health)}`];
  if (!s.noSnipers) {
    parts.push(`Detection ${Math.round(s.detection)} %`, `${s.snipersLeft} sniper${s.snipersLeft === 1 ? '' : 's'} left`);
  }
  if (s.warning > 0) parts.push(s.mortar ? `INCOMING MORTAR ${showTenths(s.warning)} s — C: COVER` : `INCOMING BOMBARDMENT ${showTenths(s.warning)} s — C: COVER`);
  else if (s.firing && !s.noSnipers) parts.push(`SNIPER FIRING IN ${showTenths(s.fireIn)} s`);
  else if (!s.noSnipers) {
    if (s.awareness === 'unaware') {
      parts.push('Enemy unaware');
      if (s.camo) parts.push('ghillie suit');
    } else parts.push('Enemy searching for you · C: cover');
  }
  if (s.squad) parts.push(s.squad === 'engaging' && s.warning <= 0 ? `${SQUAD_TEXT[s.squad]} · C: cover` : SQUAD_TEXT[s.squad]);
  if (s.paused) parts.push('PAUSED');
  return parts.join(' · ');
}

/**
 * The threat line as a cache: `line(state)` is called every frame and hands back the same string until something
 * the line shows changes (the rounded health, the rounded detection, the countdown to a tenth of a second, the
 * snipers left, a flag, the awareness), so a frame in which nothing changed builds no string and makes no array.
 */
export class ThreatLine {
  private readonly format: (s: ThreatState) => string;
  private text = '';
  private built = false;
  private flags = 0;
  private health = 0;
  private detection = 0;
  private left = 0;
  private countdown = 0;

  constructor(format: (s: ThreatState) => string = threatText) {
    this.format = format;
  }

  line(s: ThreatState): string {
    const flags =
      (s.covered ? 1 : 0) |
      (s.firing ? 2 : 0) |
      (s.paused ? 4 : 0) |
      (s.failed ? 8 : 0) |
      (s.cleared ? 16 : 0) |
      (s.warning > 0 ? 32 : 0) |
      (s.awareness === 'searching' ? 64 : s.awareness === 'firing' ? 128 : 0) |
      (s.camo ? 256 : 0) |
      (s.mortar ? 512 : 0) |
      (s.noSnipers ? 1024 : 0) |
      (s.squad === undefined ? 0 : (SQUAD_BITS[s.squad] << 11));
    const health = Math.ceil(s.health);
    const detection = Math.round(s.detection);
    const countdown = s.warning > 0 ? tenths(s.warning) : s.firing ? tenths(s.fireIn) : 0;
    if (
      this.built &&
      flags === this.flags &&
      health === this.health &&
      detection === this.detection &&
      s.snipersLeft === this.left &&
      countdown === this.countdown
    ) {
      return this.text;
    }
    this.built = true;
    this.flags = flags;
    this.health = health;
    this.detection = detection;
    this.left = s.snipersLeft;
    this.countdown = countdown;
    this.text = this.format(s);
    return this.text;
  }
}

/** The squad state as a number for the line's cache key (0 is "no squad line"). */
const SQUAD_BITS: Record<SquadState, number> = { unaware: 1, alerted: 2, searching: 3, engaging: 4 };

/** How long a damage flash takes to fade, s. */
export const FLASH_SECONDS = 0.5;

/** Strength (0..0.6) of the red flash for `damage` health points: a graze is faint, a bombardment is not. */
export function flashIntensity(damage: number): number {
  if (!(damage > 0)) return 0;
  return Math.min(0.6, 0.15 + damage / 100);
}

/** What the screen shows of the cover and the damage. */
export interface ThreatView {
  setText(text: string): void;
  setCovered(covered: boolean): void;
  /** A hit of this strength (see flashIntensity); a stronger flash replaces a weaker one still fading. */
  flash(intensity: number): void;
  /** Fade the flash by `dt` seconds. */
  update(dt: number): void;
}

function el(parent: HTMLElement, tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  parent.appendChild(node);
  return node;
}

/** The DOM of the threat line, the cover mask and the damage flash. */
export class ThreatUi implements ThreatView {
  private readonly panel: HTMLElement;
  private readonly mask: HTMLElement;
  private readonly flashEl: HTMLElement;
  private shown = '';
  private level = 0;
  private age = FLASH_SECONDS;

  constructor(parent: HTMLElement) {
    this.panel = el(parent, 'div', 'threat-panel');
    this.mask = el(parent, 'div', 'cover-mask');
    this.mask.hidden = true;
    this.flashEl = el(parent, 'div', 'damage-flash');
  }

  /** Cheap to call every frame: the DOM is only touched on change (and never read back). */
  setText(text: string): void {
    if (text === this.shown) return;
    this.shown = text;
    this.panel.textContent = text;
  }

  setCovered(covered: boolean): void {
    this.mask.hidden = !covered;
  }

  flash(intensity: number): void {
    if (intensity <= 0) return;
    this.level = Math.max(this.level * (1 - this.age / FLASH_SECONDS), intensity);
    this.age = 0;
    this.flashEl.style.opacity = String(this.level);
  }

  update(dt: number): void {
    if (this.age >= FLASH_SECONDS) return;
    this.age = Math.min(FLASH_SECONDS, this.age + Math.max(0, dt));
    this.flashEl.style.opacity = String(this.level * (1 - this.age / FLASH_SECONDS));
  }
}
