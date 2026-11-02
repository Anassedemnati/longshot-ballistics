import { accuracy, elapsedMs } from '../mission/stats';
import type { MissionStats } from '../mission/stats';

/** What the two buttons do (the mission wires them to `location.reload()` and the menu URL). */
export interface ResultsActions {
  onRestart(): void;
  onMenu(): void;
}

/** "03:07": minutes and seconds (minutes may pass 59); never negative. */
export function missionTimeText(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

/** The result lines in display order: label and value text. */
export function resultRows(s: MissionStats): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    ['Shots fired', String(s.shots)],
    ['Hits', String(s.hits)],
    ['Accuracy', `${Math.round(accuracy(s) * 100)} %`],
    ['Headshots', String(s.headshots)],
    ['Longest hit', s.longestHitM > 0 ? `${Math.round(s.longestHitM)} m` : '—'],
    ['Mission time', missionTimeText(elapsedMs(s))],
  ];
  if (s.assistsUsed) rows.push(['Assists used', 'Yes']);
  return rows;
}

/** The overlay's heading: the mission was won, or the player was killed by the enemy snipers. */
export function resultTitle(s: MissionStats): string {
  return s.failed ? 'Mission failed' : 'Mission complete';
}

/** "1 of 4 targets down": what a failed mission got done. */
export function failedSummary(s: MissionStats): string {
  return `${s.targetsDown} of ${s.targetsTotal} target${s.targetsTotal === 1 ? '' : 's'} down`;
}

function el(parent: HTMLElement, tag: string, className: string, text = ''): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  parent.appendChild(node);
  return node;
}

/**
 * The end-of-mission overlay: a dark translucent panel with the stats and Restart / Menu buttons.
 * All DOM, styled in index.html. It swallows mouse presses, so a click on it never reaches the
 * document-level handlers that would grab the pointer again.
 */
export function showResults(parent: HTMLElement, stats: MissionStats, actions: ResultsActions): HTMLElement {
  const root = el(parent, 'div', 'results');
  root.addEventListener('mousedown', (e) => e.stopPropagation());
  const panel = el(root, 'div', 'results-panel');
  el(panel, 'h1', stats.failed ? 'results-title results-failed' : 'results-title', resultTitle(stats));
  if (stats.failed) el(panel, 'div', 'results-summary', failedSummary(stats));
  for (const [label, value] of resultRows(stats)) {
    const row = el(panel, 'div', 'results-row');
    el(row, 'span', 'results-label', label);
    el(row, 'span', 'results-value', value);
  }
  const buttons = el(panel, 'div', 'results-buttons');
  const restart = el(buttons, 'button', 'results-button results-restart', 'Restart');
  restart.addEventListener('click', () => actions.onRestart());
  const menu = el(buttons, 'button', 'results-button results-menu', 'Menu');
  menu.addEventListener('click', () => actions.onMenu());
  return root;
}
