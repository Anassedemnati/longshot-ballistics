import './menu.css';
import { RIFLES } from '../ballistics/rifles';
import { DEFAULT_MISSION, MISSION_LIMITS, clampMission, randomMission, windClockLabel } from '../mission/config';
import type { Density, FiringPosition, MissionConfig } from '../mission/config';
import { createRng } from '../mission/random';
import { THEMES } from '../mission/themes';
import type { ThemeId } from '../mission/themes';
import {
  ASSISTS_NOTE,
  FIGHT_BACK_NOTE,
  GHILLIE_NOTE,
  INTEGRAL_SUPPRESSOR_NOTE,
  RANGE_STEP_M,
  ART_BOX_ASPECT,
  OWN_ART_IMAGE,
  RIFLE_ART_IMAGE,
  RIFLE_SHORT_NAME,
  WHOLE_ART,
  boxCrop,
  SNIPERS_NOTE,
  SUPPRESSOR_NOTE,
  WIND_STEP_MPS,
  clockPoint,
  densityNote,
  linkRange,
  menuSearch,
  positionNote,
  rangeLabel,
  rifleArt,
  rifleArtStyle,
  rifleNote,
  rifleTitle,
  seedFromBits,
  snipersLabel,
  startSearch,
  stepClock,
  themeBlurb,
  windSpeedLabel,
} from './menuModel';
import { createFullscreenButton } from './fullscreen';

/**
 * Debug/automation hook, `window.__menu`: sets and reads the same state the controls show and starts the
 * mission like the Start button does. Only exposed in dev builds or with `?debug=1` (the smoke check uses it).
 */
export interface MenuDebugHook {
  set(partial: Partial<MissionConfig>): void;
  get(): MissionConfig;
  start(): void;
}

declare global {
  interface Window {
    __menu?: MenuDebugHook;
  }
}

const THEME_ORDER: readonly ThemeId[] = ['desert', 'arctic', 'valley'];
const DENSITY_OPTIONS: ReadonlyArray<{ value: Density; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'few', label: 'Few' },
  { value: 'many', label: 'Many' },
];
const POSITION_OPTIONS: ReadonlyArray<{ value: FiringPosition; label: string }> = [
  { value: 'valley', label: 'Valley' },
  { value: 'ridge', label: 'Ridge' },
  { value: 'mountain', label: 'Mountain' },
];
/**
 * The rifles by calibre, lightest first, in a grid of compact buttons four to a row. Listed by hand: `Object.keys(RIFLES)` would put the
 * integer-like ids ('50', '127', '300' ...) in numeric order.
 */
const RIFLE_ORDER: readonly MissionConfig['rifle'][] = ['308', '338', '300', '408', '50', '127', '127s'];
const RIFLE_OPTIONS: ReadonlyArray<{ value: MissionConfig['rifle']; label: string }> = RIFLE_ORDER.map((id) => ({
  value: id,
  label: RIFLE_SHORT_NAME[id],
}));

/** Arrow keys on the wind dial: clockwise or counter-clockwise by one position. */
const ARROW_STEP: Record<string, number | undefined> = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 };

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A fresh 32-bit mission seed from the browser's random source (UI code: src/mission never calls Math.random). */
function newSeed(): number {
  const bits = new Uint32Array(1);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bits);
  else bits[0] = Date.now();
  return seedFromBits(bits[0] ?? 0);
}

function el<K extends keyof HTMLElementTagNameMap>(
  parent: HTMLElement | null,
  tag: K,
  className = '',
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  parent?.appendChild(node);
  return node;
}

function svg<K extends keyof SVGElementTagNameMap>(
  parent: Element | null,
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent?.appendChild(node);
  return node;
}

/** A labelled field: the label (uppercase caption) and the live value on one line. Returns both nodes. */
function fieldHead(
  parent: HTMLElement,
  label: string,
  forId: string | undefined,
  valueId: string,
): { label: HTMLElement; value: HTMLOutputElement } {
  const head = el(parent, 'div', 'menu-field-head');
  const caption = forId ? el(head, 'label', 'menu-label', label) : el(head, 'span', 'menu-label', label);
  if (forId) caption.setAttribute('for', forId);
  const value = el(head, 'output', 'menu-value');
  value.id = valueId;
  if (forId) value.htmlFor.add(forId);
  return { label: caption, value };
}

/** A native range input; `--p` (0..1) tells the stylesheet how much of the track to fill. */
function rangeInput(id: string, min: number, max: number, step: number): HTMLInputElement {
  const input = el(null, 'input', 'menu-range');
  input.type = 'range';
  input.id = id;
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  return input;
}

function setFill(input: HTMLInputElement, value: number): void {
  const min = Number(input.min);
  const max = Number(input.max);
  input.style.setProperty('--p', String(Math.min(1, Math.max(0, (value - min) / (max - min)))));
}

/** A group of radio buttons drawn as a segmented control. Native radios: arrow keys and Tab behave as expected. */
function segmented<T extends string>(
  parent: HTMLElement,
  name: string,
  label: string,
  options: ReadonlyArray<{ value: T; label: string }>,
  onChange: (value: T) => void,
  noteFor: (value: T) => string,
  /** Lines the note reserves, so a longer note in one state does not make the panel grow. */
  noteLines = 1,
  /** Many short options: compact buttons that wrap into a grid on a narrow screen (the rifles). */
  compact = false,
): (value: T) => void {
  const field = el(parent, 'div', 'menu-field');
  const captionId = `menu-${name}-label`;
  el(el(field, 'div', 'menu-field-head'), 'span', 'menu-label', label).id = captionId;
  const group = el(field, 'div', compact ? 'menu-seg menu-seg-compact' : 'menu-seg');
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-labelledby', captionId);
  const inputs = new Map<T, HTMLInputElement>();
  for (const option of options) {
    const item = el(group, 'label', 'menu-seg-option');
    const input = el(item, 'input', 'menu-sr');
    input.type = 'radio';
    input.name = name;
    input.value = option.value;
    input.addEventListener('change', () => {
      if (input.checked) onChange(option.value);
    });
    el(item, 'span', 'menu-seg-text', option.label);
    inputs.set(option.value, input);
  }
  const note = el(field, 'p', 'menu-note menu-seg-note');
  if (noteLines > 1) note.style.minHeight = `${noteLines * 1.2}em`;
  return (value) => {
    const input = inputs.get(value);
    if (input) input.checked = true;
    note.textContent = noteFor(value);
  };
}

/**
 * An on/off switch: a native checkbox (Space toggles it, Tab reaches it) drawn as a switch, the caption on the left and
 * the state on the right, a note under it. Returns the function that shows a value; given a `locked` text it also locks the
 * switch (disabled, the text in place of the note) until it is called without one.
 */
function toggle(
  parent: HTMLElement,
  name: string,
  label: string,
  note: string,
  onChange: (on: boolean) => void,
): (on: boolean, locked?: string | null) => void {
  const field = el(parent, 'div', 'menu-field');
  const row = el(field, 'label', 'menu-toggle');
  el(row, 'span', 'menu-label', label);
  const state = el(row, 'span', 'menu-value menu-toggle-state');
  const input = el(row, 'input', 'menu-sr');
  input.type = 'checkbox';
  input.name = name;
  input.addEventListener('change', () => onChange(input.checked));
  el(row, 'span', 'menu-switch').setAttribute('aria-hidden', 'true');
  const noteEl = el(field, 'p', 'menu-note menu-toggle-note', note);
  return (on, locked = null) => {
    input.checked = on;
    input.disabled = locked !== null;
    row.classList.toggle('is-locked', locked !== null);
    state.textContent = on ? 'On' : 'Off';
    noteEl.textContent = locked ?? note;
  };
}

/** The start menu: configure a mission, then Start (or roll a Random mission). `last` pre-fills the controls. */
export function showMenu(app: HTMLElement, opts: { last: MissionConfig | null; debug: boolean }): void {
  let cfg: MissionConfig = clampMission(opts.last ?? DEFAULT_MISSION);
  const syncers: Array<() => void> = [];
  const L = MISSION_LIMITS;
  const base = import.meta.env.BASE_URL;

  /** Change settings (a partial update is clamped like every mission) and redraw all controls. */
  function apply(partial: Partial<MissionConfig>): void {
    cfg = clampMission({ ...cfg, ...partial });
    for (const sync of syncers) sync();
  }

  function start(): void {
    // This history entry becomes the menu holding these settings, so the browser's Back from the mission
    // returns to a pre-filled menu instead of the defaults the page was opened with.
    history.replaceState(null, '', menuSearch(cfg, opts.debug));
    window.location.search = startSearch(cfg, newSeed(), opts.debug);
  }

  const root = el(null, 'div', 'menu');

  // --- Background: the selected theme's card, blurred and dimmed ---
  const bg = el(root, 'div', 'menu-bg');
  bg.setAttribute('aria-hidden', 'true');
  const bgImages = new Map<ThemeId, HTMLImageElement>();
  for (const id of THEME_ORDER) {
    const img = el(bg, 'img', 'menu-bg-img');
    img.src = `${base}menu/card_${id}-640.webp`;
    img.alt = '';
    img.decoding = 'async';
    bgImages.set(id, img);
  }
  syncers.push(() => {
    for (const [id, img] of bgImages) img.classList.toggle('is-active', id === cfg.theme);
  });

  const form = el(root, 'form', 'menu-shell');
  form.noValidate = true;
  form.addEventListener('submit', (e) => {
    e.preventDefault(); // never a real GET submit: it would race the navigation start() makes
    start();
  });

  // --- Title ---
  const head = el(form, 'header', 'menu-head');
  el(head, 'h1', 'menu-title', 'SNIPER SIMULATOR');
  el(head, 'p', 'menu-subtitle', 'Mission setup');

  // --- Theme cards ---
  const themeSection = el(form, 'section', 'menu-themes');
  el(themeSection, 'h2', 'menu-label menu-section-label', 'Theme').id = 'menu-theme-label';
  const cards = el(themeSection, 'div', 'menu-cards');
  cards.setAttribute('role', 'radiogroup');
  cards.setAttribute('aria-labelledby', 'menu-theme-label');
  const themeInputs = new Map<ThemeId, HTMLInputElement>();
  for (const id of THEME_ORDER) {
    const card = el(cards, 'label', 'menu-card');
    card.dataset.theme = id;
    const input = el(card, 'input', 'menu-sr');
    input.type = 'radio';
    input.name = 'theme';
    input.value = id;
    input.addEventListener('change', () => {
      if (input.checked) apply({ theme: id });
    });
    themeInputs.set(id, input);
    const img = el(card, 'img', 'menu-card-img');
    img.srcset = `${base}menu/card_${id}-640.webp 640w, ${base}menu/card_${id}.webp 1280w`;
    img.sizes = '(min-width: 1200px) 360px, 30vw';
    img.src = `${base}menu/card_${id}-640.webp`;
    img.alt = '';
    img.decoding = 'async';
    const caption = el(card, 'span', 'menu-card-caption');
    el(caption, 'span', 'menu-card-name', THEMES[id].name);
    el(caption, 'span', 'menu-card-note', themeBlurb(id));
  }
  syncers.push(() => {
    const input = themeInputs.get(cfg.theme);
    if (input) input.checked = true;
  });

  const columns = el(form, 'div', 'menu-columns');

  // --- Targets panel: range band, soldiers, vehicle targets ---
  const targets = el(columns, 'section', 'menu-panel');
  el(targets, 'h2', 'menu-panel-title', 'Targets');

  const rangeField = el(targets, 'div', 'menu-field');
  const rangeHead = fieldHead(rangeField, 'Range band', undefined, 'menu-range-value');
  rangeHead.label.id = 'menu-range-label';
  const dual = el(rangeField, 'div', 'menu-dual');
  dual.setAttribute('role', 'group');
  dual.setAttribute('aria-labelledby', 'menu-range-label');
  el(dual, 'div', 'menu-dual-track');
  el(dual, 'div', 'menu-dual-fill');
  const rangeMinInput = rangeInput('menu-range-min', L.rangeMin, L.rangeMax, RANGE_STEP_M);
  const rangeMaxInput = rangeInput('menu-range-max', L.rangeMin, L.rangeMax, RANGE_STEP_M);
  rangeMinInput.setAttribute('aria-label', 'Nearest target distance, metres');
  rangeMaxInput.setAttribute('aria-label', 'Farthest target distance, metres');
  dual.append(rangeMinInput, rangeMaxInput);
  rangeHead.value.htmlFor.add('menu-range-min');
  rangeHead.value.htmlFor.add('menu-range-max');
  const rangeScale = el(rangeField, 'div', 'menu-scale');
  el(rangeScale, 'span', '', `${L.rangeMin} m`);
  el(rangeScale, 'span', '', `${L.rangeMax} m`);
  let lastMoved: 'min' | 'max' = 'max';
  for (const [input, which] of [
    [rangeMinInput, 'min'],
    [rangeMaxInput, 'max'],
  ] as const) {
    const moved = () => {
      lastMoved = which;
      const band = linkRange({ min: cfg.rangeMin, max: cfg.rangeMax }, which, Number(input.value));
      apply({ rangeMin: band.min, rangeMax: band.max });
    };
    input.addEventListener('input', moved);
    input.addEventListener('focus', () => {
      lastMoved = which;
      syncRange();
    });
  }
  const syncRange = () => {
    rangeMinInput.value = String(cfg.rangeMin);
    rangeMaxInput.value = String(cfg.rangeMax);
    const span = L.rangeMax - L.rangeMin;
    dual.style.setProperty('--a', String((cfg.rangeMin - L.rangeMin) / span));
    dual.style.setProperty('--b', String((cfg.rangeMax - L.rangeMin) / span));
    rangeHead.value.textContent = rangeLabel({ min: cfg.rangeMin, max: cfg.rangeMax });
    // The thumb to grab when both sit on one spot: the one that can still move away from it.
    const middle = (L.rangeMin + L.rangeMax) / 2;
    const minOnTop = cfg.rangeMin === cfg.rangeMax ? cfg.rangeMin >= middle : lastMoved === 'min';
    rangeMinInput.style.zIndex = minOnTop ? '2' : '1';
    rangeMaxInput.style.zIndex = minOnTop ? '1' : '2';
  };
  syncers.push(syncRange);

  /** A single slider with a live value. */
  function slider(
    parent: HTMLElement,
    id: string,
    label: string,
    min: number,
    max: number,
    step: number,
    read: () => number,
    write: (v: number) => void,
    text: (v: number) => string,
    scale: [string, string],
    note?: string,
  ): void {
    const field = el(parent, 'div', 'menu-field');
    const { value } = fieldHead(field, label, id, `${id}-value`);
    const input = rangeInput(id, min, max, step);
    field.appendChild(input);
    const ends = el(field, 'div', 'menu-scale');
    el(ends, 'span', '', scale[0]);
    el(ends, 'span', '', scale[1]);
    if (note) el(field, 'p', 'menu-note menu-slider-note', note);
    input.addEventListener('input', () => write(Number(input.value)));
    syncers.push(() => {
      const v = read();
      input.value = String(v);
      setFill(input, v);
      value.textContent = text(v);
    });
  }

  slider(
    targets,
    'menu-soldiers',
    'Soldiers',
    L.soldiersMin,
    L.soldiersMax,
    1,
    () => cfg.soldiers,
    (v) => apply({ soldiers: v }),
    String,
    [String(L.soldiersMin), String(L.soldiersMax)],
  );
  // Right under the count: whether those soldiers move, take cover and shoot back or stand where they were placed.
  const syncFightBack = toggle(targets, 'fightback', 'Soldiers fight back', FIGHT_BACK_NOTE, (on) => apply({ soldiersFightBack: on }));
  syncers.push(() => syncFightBack(cfg.soldiersFightBack));
  slider(
    targets,
    'menu-vehicle-targets',
    'Vehicle targets',
    0,
    L.vehicleTargetsMax,
    1,
    () => cfg.vehicleTargets,
    (v) => apply({ vehicleTargets: v }),
    String,
    ['0', String(L.vehicleTargetsMax)],
  );
  slider(
    targets,
    'menu-snipers',
    'Enemy snipers',
    L.enemySnipers.min,
    L.enemySnipers.max,
    1,
    () => cfg.enemySnipers,
    (v) => apply({ enemySnipers: v }),
    snipersLabel,
    [String(L.enemySnipers.min), String(L.enemySnipers.max)],
    SNIPERS_NOTE,
  );

  // --- Wind panel: speed slider and the clock dial ---
  const wind = el(columns, 'section', 'menu-panel');
  el(wind, 'h2', 'menu-panel-title', 'Wind');
  slider(
    wind,
    'menu-wind-speed',
    'Speed',
    0,
    L.windMaxMps,
    WIND_STEP_MPS,
    () => cfg.windSpeedMps,
    (v) => apply({ windSpeedMps: v }),
    windSpeedLabel,
    ['0', `${L.windMaxMps} m/s`],
  );

  const dialField = el(wind, 'div', 'menu-field menu-dial-field');
  const dialHead = fieldHead(dialField, 'Direction', undefined, 'menu-dial-value');
  dialHead.label.id = 'menu-dial-label';
  const dial = svg(null, 'svg', { viewBox: '-100 -100 200 200', class: 'menu-dial', role: 'radiogroup', 'aria-labelledby': 'menu-dial-label' });
  dialField.appendChild(dial);
  svg(dial, 'circle', { class: 'menu-dial-ring', r: 58 });
  // The shooter at the centre, facing up the dial (downrange).
  svg(dial, 'polygon', { class: 'menu-dial-shooter', points: '0,-9 7,7 0,3 -7,7' });
  const arrow = svg(dial, 'g', { class: 'menu-dial-arrow' });
  svg(arrow, 'line', { x1: 0, y1: -56, x2: 0, y2: -28 });
  svg(arrow, 'polygon', { points: '0,-15 -8,-31 8,-31' });
  const dialNodes: SVGGElement[] = [];
  for (let clock = 1; clock <= 12; clock++) {
    const p = clockPoint(clock, 77);
    const node = svg(dial, 'g', {
      class: 'menu-dial-pos',
      transform: `translate(${p.x} ${p.y})`,
      role: 'radio',
      'aria-label': `${clock} o'clock`,
      'aria-checked': 'false',
      tabindex: -1,
      'data-clock': clock,
    });
    svg(node, 'circle', { r: 14 });
    const label = svg(node, 'text', { class: 'menu-dial-num', y: 0 });
    label.textContent = String(clock);
    node.addEventListener('click', () => apply({ windClock: clock }));
    node.addEventListener('keydown', (e) => {
      const delta = ARROW_STEP[e.key];
      if (delta !== undefined) {
        e.preventDefault();
        const next = stepClock(clock, delta);
        apply({ windClock: next });
        dialNodes[next - 1]?.focus();
      } else if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        apply({ windClock: clock });
      }
    });
    dialNodes.push(node);
  }
  el(dialField, 'p', 'menu-note', '12 = downrange. The arrow shows where the wind blows.');
  syncers.push(() => {
    arrow.setAttribute('transform', `rotate(${cfg.windClock * 30})`);
    arrow.classList.toggle('is-calm', cfg.windSpeedMps === 0);
    dialHead.value.textContent = windClockLabel(cfg.windClock);
    dialNodes.forEach((node, i) => {
      const on = i + 1 === cfg.windClock;
      node.classList.toggle('is-selected', on);
      node.setAttribute('aria-checked', String(on));
      node.setAttribute('tabindex', on ? '0' : '-1');
    });
  });

  // --- Rifle panel: the rifle (with its concept art), suppressor, ghillie suit and aim assists ---
  const gear = el(columns, 'section', 'menu-panel');
  el(gear, 'h2', 'menu-panel-title', 'Rifle and aids');
  const art = el(gear, 'figure', 'menu-rifle-art');
  art.style.aspectRatio = String(ART_BOX_ASPECT); // every rifle's art is fitted to this shape: the box never changes height
  const artImg = el(art, 'img', 'menu-rifle-img');
  artImg.alt = '';
  artImg.decoding = 'async';
  // A picture that cannot be loaded leaves the box with its caption only (and the calibre written large in it).
  artImg.addEventListener('error', () => art.classList.add('is-missing'));
  artImg.addEventListener('load', () => art.classList.remove('is-missing'));
  const artCalibre = el(art, 'span', 'menu-rifle-calibre');
  artCalibre.setAttribute('aria-hidden', 'true');
  const artCaption = el(art, 'figcaption', 'menu-rifle-caption');
  const syncRifle = segmented(gear, 'rifle', 'Rifle', RIFLE_OPTIONS, (v) => apply({ rifle: v }), rifleNote, 2, true);
  const syncSuppressor = toggle(gear, 'suppressed', 'Suppressor', SUPPRESSOR_NOTE, (on) => apply({ suppressed: on }));
  const syncCamo = toggle(gear, 'camo', 'Ghillie suit', GHILLIE_NOTE, (on) => apply({ camo: on }));
  const syncAssists = toggle(gear, 'assists', 'Aim assists', ASSISTS_NOTE, (on) => apply({ assists: on }));
  syncers.push(
    () => {
      const { file, crop } = rifleArt(cfg.rifle);
      const style = crop ? rifleArtStyle(boxCrop(crop)) : WHOLE_ART;
      art.dataset.rifle = cfg.rifle;
      if (artImg.dataset.file !== file) {
        art.classList.remove('is-missing');
        artImg.dataset.file = file;
        artImg.width = crop ? RIFLE_ART_IMAGE.w : OWN_ART_IMAGE.w;
        artImg.height = crop ? RIFLE_ART_IMAGE.h : OWN_ART_IMAGE.h;
        artImg.src = `${base}${file}`;
      }
      artCalibre.textContent = RIFLE_SHORT_NAME[cfg.rifle];
      artImg.style.width = `${style.widthPct}%`;
      artImg.style.left = `${style.leftPct}%`;
      artImg.style.top = `${style.topPct}%`;
      artCaption.textContent = rifleTitle(cfg.rifle);
      art.setAttribute('aria-label', `${rifleTitle(cfg.rifle)}, concept art`);
    },
    () => syncRifle(cfg.rifle),
    () => syncSuppressor(cfg.suppressed, RIFLES[cfg.rifle].integralSuppressor ? INTEGRAL_SUPPRESSOR_NOTE : null),
    () => syncCamo(cfg.camo),
    () => syncAssists(cfg.assists),
  );

  // --- Position panel: where the shooter lies, and the scenery around ---
  const place = el(columns, 'section', 'menu-panel');
  el(place, 'h2', 'menu-panel-title', 'Position and scenery');
  const syncPosition = segmented(
    place,
    'position',
    'Firing position',
    POSITION_OPTIONS,
    (v) => apply({ position: v }),
    positionNote,
    2,
  );
  const syncBuildings = segmented(place, 'buildings', 'Buildings', DENSITY_OPTIONS, (v) => apply({ buildings: v }), (v) => densityNote('buildings', v));
  const syncVehicles = segmented(place, 'vehicles', 'Scenery vehicles', DENSITY_OPTIONS, (v) => apply({ vehicles: v }), (v) => densityNote('vehicles', v));
  syncers.push(
    () => syncPosition(cfg.position),
    () => syncBuildings(cfg.buildings),
    () => syncVehicles(cfg.vehicles),
  );

  // --- Buttons ---
  const actions = el(form, 'footer', 'menu-actions');
  el(actions, 'p', 'menu-note menu-actions-note', 'Every start rolls a new layout.');
  createFullscreenButton(actions, 'menu-button menu-fullscreen'); // not made where the browser has no fullscreen
  const random = el(actions, 'button', 'menu-button menu-random', 'Random mission');
  random.type = 'button';
  random.addEventListener('click', () => apply(randomMission(createRng(newSeed()))));
  const go = el(actions, 'button', 'menu-button menu-start', 'Start mission');
  go.type = 'submit';

  syncers.forEach((sync) => sync());
  app.appendChild(root);

  if (import.meta.env.DEV || opts.debug) {
    window.__menu = {
      set: (partial) => apply(partial),
      get: () => ({ ...cfg }),
      start,
    };
  }
}
