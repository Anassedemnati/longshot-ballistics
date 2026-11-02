import { windClockLabel, windVector } from '../mission/config';

/** Wind speed below which the HUD says "calm", m/s. */
const CALM_MPS = 0.05;

function el(parent: HTMLElement, tag: string, className: string, text = ''): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  parent.appendChild(node);
  return node;
}

/**
 * Text of the sound indicator. The audio only starts with the first click, so until the context is
 * running it says how to start it (not "Sound on"); after that it shows on/muted.
 */
export function soundLabel(running: boolean, muted: boolean, available = true): string {
  if (!available) return 'Sound unavailable';
  if (!running) return 'Sound: click to start';
  return muted ? 'Muted (M)' : 'Sound on (M)';
}

/** "Wind 4.5 m/s from 9 o'clock (left)", or "Wind calm". */
export function windText(speedMps: number, clock: number): string {
  if (!(Math.abs(speedMps) >= CALM_MPS)) return 'Wind calm';
  return `Wind ${Math.abs(speedMps).toFixed(1)} m/s ${windClockLabel(clock)}`;
}

/** "Targets 3/5": targets still standing out of the total. */
export function targetsText(left: number, total: number): string {
  return `Targets ${left}/${total}`;
}

/** Rangefinder line: "Range 734 m", or "Range —" when nothing is under the crosshair. */
export function rangeText(rangeM: number | null): string {
  return rangeM === null || !Number.isFinite(rangeM) ? 'Range —' : `Range ${Math.round(rangeM)} m`;
}

/** Which optional keys the hint lists: C (cover) when the mission has enemy snipers, T / A / P when aim assists are on. */
export interface HintKeys {
  cover?: boolean;
  assists?: boolean;
}

/** The key hint, on one line. */
export function hintText(keys: HintKeys = {}): string {
  const parts = ['Click to take aim', 'Left click fire', 'Right click scope', 'Wheel zoom', 'R reload', 'M mute'];
  if (keys.cover) parts.push('C cover');
  if (keys.assists) parts.push('T/A/P assists');
  parts.push('Esc release mouse');
  return parts.join('  ·  ');
}

/**
 * Easy-style HUD: targets left, rangefinder, wind, magnification, rounds, the sound on/off indicator and
 * the last shot's result, plus a centre dot for the naked eye and the click-to-start hint. While the mouse
 * is free the hint also holds a "Menu" link (to `menuHref`), the only way out of a mission that keeps its
 * settings. All DOM; styled in index.html.
 */
export class Hud {
  private readonly targets: HTMLElement;
  private readonly range: HTMLElement;
  private readonly magnification: HTMLElement;
  private readonly rounds: HTMLElement;
  private readonly sound: HTMLElement;
  private readonly result: HTMLElement;
  private readonly dot: HTMLElement;
  private readonly hint: HTMLElement;

  constructor(
    parent: HTMLElement,
    wind: { windSpeedMps: number; windClock: number },
    targetsTotal: number,
    menuHref: string,
    keys: HintKeys = {},
  ) {
    const root = el(parent, 'div', 'hud');
    const panel = el(root, 'div', 'hud-panel');
    this.targets = el(panel, 'div', 'hud-line', targetsText(targetsTotal, targetsTotal));
    this.range = el(panel, 'div', 'hud-line', rangeText(null));

    const windLine = el(panel, 'div', 'hud-line');
    const calm = !(Math.abs(wind.windSpeedMps) >= CALM_MPS);
    const arrow = el(windLine, 'span', 'hud-wind-arrow', calm ? '·' : '➜');
    // The arrow points where the air moves to, seen from above with downrange up: right for wind from
    // the left (9), down toward the shooter for a headwind (12).
    const v = windVector(1, wind.windClock);
    if (!calm) arrow.style.transform = `rotate(${(Math.atan2(v.z, v.x) * 180) / Math.PI}deg)`;
    windLine.append(' ' + windText(wind.windSpeedMps, wind.windClock));

    this.magnification = el(panel, 'div', 'hud-line');
    this.rounds = el(panel, 'div', 'hud-line');
    this.sound = el(panel, 'div', 'hud-line');
    this.result = el(root, 'div', 'hud-result');
    this.dot = el(root, 'div', 'hud-dot');
    this.hint = el(root, 'div', 'hud-hint');
    this.hint.append(hintText(keys));
    const menu = el(this.hint, 'a', 'hud-menu', 'Menu') as HTMLAnchorElement;
    menu.href = menuHref;
    // The HUD lets the mouse through to the canvas; this link is the exception. Its press must not reach the
    // document handler that grabs the pointer (the page is about to navigate).
    menu.addEventListener('mousedown', (e) => e.stopPropagation());
    this.setMagnification(1);
    this.setSound(false, false);
  }

  setTargets(left: number, total: number): void {
    this.targets.textContent = targetsText(left, total);
  }

  /** Rangefinder reading; cheap to call often: the DOM is only touched on change. */
  setRange(rangeM: number | null): void {
    const text = rangeText(rangeM);
    if (this.range.textContent !== text) this.range.textContent = text;
  }

  setMagnification(mag: number): void {
    this.magnification.textContent = mag <= 1 ? 'Zoom naked eye' : `Zoom ${mag.toFixed(1)}×`;
    this.dot.hidden = mag > 1;
  }

  setRounds(left: number, max: number, reloading: boolean): void {
    this.rounds.textContent = reloading ? `Rounds ${left}/${max}  reloading…` : `Rounds ${left}/${max}`;
  }

  /** Small sound indicator, see `soundLabel`. Cheap to call every frame: the DOM is only touched on change. */
  setSound(running: boolean, muted: boolean, available = true): void {
    const text = soundLabel(running, muted, available);
    if (this.sound.textContent !== text) this.sound.textContent = text;
  }

  setResult(text: string): void {
    this.result.textContent = text;
  }

  /** The text of the last-shot result line right now. */
  get resultText(): string {
    return this.result.textContent ?? '';
  }

  /** Show the "click to take aim" hint (and the Menu link in it) while the mouse is not captured. */
  setHintVisible(visible: boolean): void {
    this.hint.hidden = !visible;
  }
}
