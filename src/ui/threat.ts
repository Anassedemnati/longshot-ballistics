// The threat HUD of a mission with enemy snipers: one line at the top of the screen (exposed or in
// cover, health, detection, snipers left and the countdown to the next incoming fire), the damage flash
// and the cover mask. All DOM, styled in index.html. The text and the flash level are pure functions.

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
  /** Seconds until the next sniper shot. */
  fireIn: number;
  /** The game is not running (pointer free). */
  paused: boolean;
  /** The player is dead. */
  failed: boolean;
  /** No sniper is left: the threat is over. */
  cleared: boolean;
}

/** The threat line, e.g. "EXPOSED · Health 82 · Detection 70 % · 2 snipers left · SNIPER FIRING IN 2.1 s". */
export function threatText(s: ThreatState): string {
  if (s.failed) return 'MISSION FAILED · you were killed';
  if (s.cleared) return `ALL SNIPERS DOWN · threat cleared · Health ${Math.ceil(s.health)}`;
  const parts = [
    s.covered ? 'IN COVER' : 'EXPOSED',
    `Health ${Math.ceil(s.health)}`,
    `Detection ${Math.round(s.detection)} %`,
    `${s.snipersLeft} sniper${s.snipersLeft === 1 ? '' : 's'} left`,
  ];
  if (s.warning > 0) parts.push(`INCOMING BOMBARDMENT ${s.warning.toFixed(1)} s — C: COVER`);
  else if (s.firing) parts.push(`SNIPER FIRING IN ${s.fireIn.toFixed(1)} s`);
  else parts.push('Enemy searching · C: cover');
  if (s.paused) parts.push('PAUSED — click to resume');
  return parts.join(' · ');
}

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
  private level = 0;
  private age = FLASH_SECONDS;

  constructor(parent: HTMLElement) {
    this.panel = el(parent, 'div', 'threat-panel');
    this.mask = el(parent, 'div', 'cover-mask');
    this.mask.hidden = true;
    this.flashEl = el(parent, 'div', 'damage-flash');
  }

  /** Cheap to call every frame: the DOM is only touched on change. */
  setText(text: string): void {
    if (this.panel.textContent !== text) this.panel.textContent = text;
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
