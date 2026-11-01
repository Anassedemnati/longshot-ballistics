import type { StageConfig } from '../game/config';

const MPS_TO_MPH = 2.2369362920544;

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

/**
 * Easy-style stage-1 HUD: range, wind, magnification, rounds, the sound on/off indicator and the last
 * shot's result, plus a centre dot for the naked eye and the click-to-start hint. All DOM; styled in
 * index.html.
 */
export class Hud {
  private readonly magnification: HTMLElement;
  private readonly rounds: HTMLElement;
  private readonly sound: HTMLElement;
  private readonly result: HTMLElement;
  private readonly dot: HTMLElement;
  private readonly hint: HTMLElement;

  constructor(parent: HTMLElement, config: StageConfig) {
    const root = el(parent, 'div', 'hud');
    const panel = el(root, 'div', 'hud-panel');
    el(panel, 'div', 'hud-line', `Range ${Math.round(config.range)} m`);

    const wind = el(panel, 'div', 'hud-line');
    const speed = Math.abs(config.windFromLeftMps);
    const arrow = el(wind, 'span', 'hud-wind-arrow', speed < 0.05 ? '·' : '➜');
    // The arrow shows where the wind blows to: right when it comes from the left, else left.
    if (config.windFromLeftMps < 0) arrow.style.transform = 'rotate(180deg)';
    const side = config.windFromLeftMps < 0 ? 'right' : 'left';
    wind.append(
      speed < 0.05
        ? ' Wind calm'
        : ` Wind ${speed.toFixed(1)} m/s (${(speed * MPS_TO_MPH).toFixed(0)} mph) from ${side}`,
    );

    this.magnification = el(panel, 'div', 'hud-line');
    this.rounds = el(panel, 'div', 'hud-line');
    this.sound = el(panel, 'div', 'hud-line');
    this.result = el(root, 'div', 'hud-result');
    this.dot = el(root, 'div', 'hud-dot');
    this.hint = el(
      root,
      'div',
      'hud-hint',
      'Click to take aim  ·  Left click fire  ·  Right click scope  ·  Wheel zoom  ·  R reload  ·  M mute  ·  Esc release mouse',
    );
    this.setMagnification(1);
    this.setSound(false, false);
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

  /** Show the "click to take aim" hint while the mouse is not captured. */
  setHintVisible(visible: boolean): void {
    this.hint.hidden = !visible;
  }
}
