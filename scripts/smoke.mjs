// Headless smoke check: serves the production build with `vite preview`, opens it in the locally
// installed Google Chrome and checks that the game renders, scopes, fires and hits.
//   npm run smoke      (removes dist/, rebuilds, then runs this script, so it always tests fresh code)
// Running `node scripts/smoke.mjs` alone tests whatever dist/ holds. Screenshots go to test-results/
// (git-ignored; old ones are deleted first). Exits 0 on success, 1 on any failed check.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'test-results');
const VITE_BIN = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
/** Preferred preview port; 5173 is the dev server and is never used. Falls back to any free port. */
const PREFERRED_PORT = 4174;
const VIEWPORT = { width: 1280, height: 720 };
/** Software rendering (SwiftShader) can drop below 1 fps and game time moves at most 0.1 s per frame, so be patient. */
const RESULT_TIMEOUT_MS = 90_000;
/** Chrome flags that give headless Chrome software WebGL when it has no usable GPU. */
const SOFTWARE_GL_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
/** Lets the audio context start without a real click, so `unlockAudio()` from the page really starts audio. */
const AUDIO_ARGS = ['--autoplay-policy=no-user-gesture-required'];
/** The game's own frame-time cap (MAX_FRAME_DT in src/mission/run.ts): game time advances at most this per frame. */
const MAX_FRAME_DT_S = 0.1;
/** Dummy fall (0.4 s) plus the 3 s it lies there before standing up again (src/scene/target.ts), with a margin. */
const DUMMY_RESET_GAME_S = 3.8;
/** Bolt cycle (BOLT_TIME_S in src/game/weapon.ts) plus a margin: a trigger pull sooner than this is ignored. */
const BOLT_GAME_S = 1.3;
/** The results appear this long (RESULTS_DELAY_S in src/mission/run.ts) after the last target goes down. */
const RESULTS_GAME_S = 1.5;
/**
 * Hold-over, m, that puts a .308 bullet (desert air, no wind, zeroed at 100 m) on the aim point at 300 m: the
 * drop there is about 0.45 m. Worked out with the real ballistics for the missions below; a chest aim plus this lands in the vest.
 */
const HOLD_300M = 0.45;
/**
 * Hold-over, m, by range for the same round, from the same ballistics (desert air, no wind, zeroed at 100 m; the real drop
 * less the few cm the sight line sits above the bore): the enemy snipers lie 150-450 m out in the missions below.
 */
const HOLD_TABLE = [[100, 0], [150, 0], [200, 0.09], [250, 0.24], [300, 0.45], [350, 0.72], [400, 1.06], [450, 1.47], [500, 1.96]];
function holdFor(range) {
  const i = HOLD_TABLE.findIndex(([r]) => r >= range);
  if (i <= 0) return HOLD_TABLE[Math.max(i, 0)][1];
  const [r0, h0] = HOLD_TABLE[i - 1];
  const [r1, h1] = HOLD_TABLE[i];
  return h0 + ((h1 - h0) * (range - r0)) / (r1 - r0);
}
/**
 * Missions of the smoke. The URL codec (src/mission/config.ts) writes v6.<theme>.<min>.<max>.<soldiers>.<vehicle targets>.<wind x10>.<clock>.<rifle>.<buildings>.<vehicles>.<seed>.<position>.<suppressed>.<snipers>.<assists>.<camo>.<fight back>.<objective>.<base>;
 * the hand-written missions below stay in the older v1 form (the first eleven fields) or the v2 one (fifteen, no ghillie suit), which must keep
 * working: v1 decodes to ridge, unsuppressed, 0 enemy snipers, no assists, no ghillie suit, v2 to no ghillie suit, and every code the game
 * writes back is v6 (V1_TAIL below). The HVT mission stays a v5 link (no base), which must keep working too.
 */
const MISSION_OPEN = 'v1.d.300.300.3.0.0.9.308.n.n.1'; // 3 soldiers at 300 m, calm, no cover
const MISSION_SINGLE = 'v1.d.300.300.1.0.0.9.308.n.n.1'; // one soldier, no cover (placed like any mission: within 10 degrees of straight ahead)
const MISSION_MENU_LINK = 'v1.d.300.300.2.0.20.6.308.n.n.7'; // 2 soldiers at 300 m, 2 m/s from behind: settings that differ from the defaults
const MISSION_COVER = 'v1.d.300.300.3.2.0.12.308.m.m.5'; // 3 soldiers + 2 vehicle targets, many buildings and vehicles
const MISSION_ASSISTS = 'v2.d.300.300.1.0.45.9.308.n.n.1.r.0.0.1'; // one soldier at 300 m, 4.5 m/s from 9 o'clock, no enemy snipers, aim assists ON
/** What the game writes for a v1 mission: the same fields, in v6 form, with the new options off (objective: clear the area, no base) (the soldiers of an old link stand still). */
const V1_TAIL = '.r.0.0.0.0.0.c.n';
const asV3 = (v1Code) => v1Code.replace(/^v1\./, 'v6.') + V1_TAIL;
/** The menu's defaults (DEFAULT_MISSION) as a mission code: the menu starts them with a fresh seed, so any seed matches. */
const MISSION_DEFAULT_RE = /^v6\.d\.600\.1000\.3\.0\.45\.9\.308\.f\.f\.\d+\.r\.0\.1\.0\.0\.1\.c\.n$/; // ridge, no suppressor, 1 enemy sniper, no assists, no ghillie suit, the soldiers fight back, clear the area, no base
/** The order Tab visits the menu's controls in. */
const MENU_TAB_ORDER = [
  'radio:theme',
  'menu-range-min',
  'menu-range-max',
  'menu-soldiers',
  'checkbox:fightback',
  'menu-vehicle-targets',
  'menu-snipers',
  'menu-wind-speed',
  'menu-dial-pos is-selected',
  'radio:rifle',
  'checkbox:suppressed',
  'checkbox:camo',
  'checkbox:assists',
  'radio:objective',
  'radio:position',
  'radio:buildings',
  'radio:vehicles',
  'radio:base',
  'menu-button menu-fullscreen',
  'menu-button menu-random',
  'menu-button menu-start',
];
const THEME_NAMES = { d: 'desert', a: 'arctic', v: 'valley' };
/** Draw-call budget of the largest mission (it draws about 300 today). */
const MAX_DRAW_CALLS = 400;
const MISSION_MAX = 'v1.d.100.1500.10.3.120.3.338.m.m.1'; // the largest mission: 10 soldiers + 3 vehicle targets, many buildings and vehicles, 12 m/s
const MISSION_MAX_SNIPERS = 'v2.d.100.1500.10.3.120.3.338.m.m.1.r.0.3.0'; // the same with 3 enemy snipers
/** 1 soldier at 300 m among many buildings, calm, 2 enemy snipers (seed 2 puts both on rooftops, 199 and 321 m out). */
const MISSION_SNIPERS = 'v2.d.300.300.1.0.0.9.308.m.n.2.r.0.2.0';
/** The same with one enemy sniper, for the mission-failed path. */
const MISSION_SNIPER_ONE = 'v2.d.300.300.1.0.0.9.308.m.n.2.r.0.1.0';
/** 1 soldier, 2 rooftop snipers (seed 2), 4.5 m/s from 9 o'clock, aim assists ON: the three features that share the screen. */
const MISSION_SNIPERS_ASSISTS = 'v2.d.300.300.1.0.45.9.308.m.n.2.r.0.2.1';
/** 1 soldier at 300 m among many buildings, calm, 1 enemy sniper (as MISSION_SNIPER_ONE), in a ghillie suit: a v3 code. */
const MISSION_GHILLIE = 'v3.d.300.300.1.0.0.9.308.m.n.2.r.0.1.0.1';
/** The same with a suppressor and no ghillie suit: a shot is quiet (9 %), so what a missed bullet adds near the sniper shows on its own. */
const MISSION_BULLET_CUE = 'v3.d.300.300.1.0.0.9.308.m.n.2.r.1.1.0.0';
/** The largest mission with everything on: mountain, suppressor, 3 enemy snipers, aim assists. */
const MISSION_MAX_ALL = 'v2.d.100.1500.10.3.120.3.338.m.m.1.m.1.3.1';
/** A high-value target at 300 m, calm air, no scenery but his compound, 2 soldiers that stand still, no enemy sniper: the officer and his guards walk his route. */
const MISSION_HVT = 'v5.d.300.300.2.0.0.9.308.n.n.3.r.0.0.0.0.0.h';
/** The longest the threat line gets (3 snipers, a bombardment coming, pointer free). */
const LONGEST_THREAT = 'EXPOSED · Health 100 · Detection 100 % · 3 snipers left · INCOMING BOMBARDMENT 3.0 s — C: COVER · PAUSED';
/** A small mission (1 soldier, 1 enemy sniper, some cover) for each firing position in each theme: `v2.<theme>.300.600.1.0.0.12.308.n.n.<seed>.<position>.0.1.0`. */
const SMALL_POSITIONS = [['v', 'valley'], ['r', 'ridge'], ['m', 'mountain']];
const SMALL_THEMES = [['d', 'desert'], ['a', 'arctic'], ['v', 'valley']];
const smallMission = (theme, position) => `v2.${theme}.300.600.1.0.0.12.308.n.n.5.${position}.0.1.0`;
const MISSION_THEMES = ['a', 'v'].map((t) => `v1.${t}.400.800.4.1.45.9.308.m.m.3`); // arctic, valley: wind, props, a vehicle target

function log(message) {
  console.log(`[smoke] ${message}`);
}

function check(condition, message) {
  if (!condition) throw new Error(`Check failed: ${message}`);
  log(`ok: ${message}`);
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const { port: bound } = server.address();
      server.close(() => resolve(bound));
    });
  });
}

/** PREFERRED_PORT if it is free, otherwise whatever port the OS hands out. */
async function pickPort() {
  try {
    return await listen(PREFERRED_PORT);
  } catch {
    return listen(0);
  }
}

/** Start `vite preview` on the built dist/ and resolve once it answers HTTP. */
async function startPreview(port) {
  const child = spawn(process.execPath, [VITE_BIN, 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  let exited = false;
  child.once('exit', () => (exited = true));

  const url = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`vite preview exited early:\n${output}`);
    try {
      const response = await fetch(url);
      if (response.ok) return { child, url, isExited: () => exited };
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  child.kill('SIGKILL');
  throw new Error(`vite preview did not come up on ${url}:\n${output}`);
}

async function stopPreview(preview) {
  if (!preview || preview.isExited()) return;
  const done = new Promise((resolve) => preview.child.once('exit', resolve));
  preview.child.kill('SIGTERM');
  const timer = setTimeout(() => preview.child.kill('SIGKILL'), 3000);
  await done;
  clearTimeout(timer);
}

/**
 * Launch Chrome with the machine's own WebGL; if that gives no WebGL context (or SMOKE_SOFTWARE_GL=1 is
 * set), relaunch with SwiftShader software rendering.
 */
async function launchChrome() {
  if (process.env.SMOKE_SOFTWARE_GL !== '1') {
    const browser = await chromium.launch({ channel: 'chrome', headless: true, args: AUDIO_ARGS });
    const page = await browser.newPage();
    const hasWebGL = await page.evaluate(() => Boolean(document.createElement('canvas').getContext('webgl2')));
    await page.close();
    if (hasWebGL) return { browser, renderer: 'system WebGL' };
    log('no WebGL in headless Chrome, retrying with SwiftShader');
    await browser.close();
  }
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: [...AUDIO_ARGS, ...SOFTWARE_GL_ARGS] });
  return { browser, renderer: 'SwiftShader software WebGL' };
}

/**
 * Decode a PNG inside the page (no image library needed) and measure it: how many distinct colours a
 * grid of sample points holds, and the brightness (0-255) at the four corners and at the middle.
 */
function analyzePng(page, png) {
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const { width, height } = bitmap;
    const ctx = new OffscreenCanvas(width, height).getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, width, height);
    const luma = (x, y) => {
      const i = (Math.floor(y) * width + Math.floor(x)) * 4;
      return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    };
    // Distinct colours (4 bits per channel) over a 48x27 grid, optionally just the middle of the image.
    const distinct = (x0, y0, x1, y1) => {
      const seen = new Set();
      for (let gy = 0; gy < 27; gy++) {
        for (let gx = 0; gx < 48; gx++) {
          const x = x0 + ((x1 - x0) * (gx + 0.5)) / 48;
          const y = y0 + ((y1 - y0) * (gy + 0.5)) / 27;
          const i = (Math.floor(y) * width + Math.floor(x)) * 4;
          seen.add(((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4));
        }
      }
      return seen.size;
    };
    const m = 2;
    const corners = [luma(m, m), luma(width - 1 - m, m), luma(m, height - 1 - m), luma(width - 1 - m, height - 1 - m)];
    return {
      width,
      height,
      distinctAll: distinct(0, 0, width, height),
      distinctMiddle: distinct(width * 0.3, height * 0.3, width * 0.7, height * 0.7),
      maxCorner: Math.max(...corners),
      skyLuma: luma(width * 0.5, height * 0.1),
      groundLuma: luma(width * 0.5, height * 0.95),
    };
  }, png.toString('base64'));
}

/**
 * The fraction of a grid of points over the lower right of the picture that is NOT sky: where the sky is blue
 * (blue well above red) a point of the rifle (black steel, olive polymer, sand chassis) is not. Aimed far above the
 * horizon the whole lower half of the picture is sky, so only the rifle can make this fraction positive.
 */
function nonSkyFraction(page, png) {
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const { width, height } = bitmap;
    const ctx = new OffscreenCanvas(width, height).getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, width, height);
    let notSky = 0;
    let total = 0;
    for (let gy = 0; gy < 16; gy++) {
      for (let gx = 0; gx < 32; gx++) {
        const x = Math.floor(width * (0.6 + (0.35 * (gx + 0.5)) / 32));
        const y = Math.floor(height * (0.55 + (0.4 * (gy + 0.5)) / 16));
        const i = (y * width + x) * 4;
        total++;
        if (data[i + 2] - data[i] < 30) notSky++;
      }
    }
    return notSky / total;
  }, png.toString('base64'));
}

/** How many pixels differ clearly (more than 30 in some channel) between two PNGs of the same size. */
function pngDiff(page, a, b) {
  return page.evaluate(
    async ([base64A, base64B]) => {
      const read = async (base64) => {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
        const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
        ctx.drawImage(bitmap, 0, 0);
        return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      };
      const [da, db] = [await read(base64A), await read(base64B)];
      let count = 0;
      for (let i = 0; i < da.length; i += 4) {
        if (Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2])) > 30) count++;
      }
      return count;
    },
    [a.toString('base64'), b.toString('base64')],
  );
}

/** Screenshot the page, optionally with the HUD hidden so only the 3D canvas (and scope) is measured. */
async function shoot(page, { hideHud, path }) {
  if (hideHud) await page.evaluate(() => document.querySelector('.hud')?.style.setProperty('visibility', 'hidden'));
  const png = await page.screenshot({ path });
  if (hideHud) await page.evaluate(() => document.querySelector('.hud')?.style.removeProperty('visibility'));
  return png;
}

/** Resolve after `frames` animation frames (or `timeoutMs`), reporting how many ran and how long they took. */
function animationFrames(page, frames, timeoutMs = 15_000) {
  return page.evaluate(
    ([wanted, timeout]) =>
      new Promise((resolve) => {
        const start = performance.now();
        let count = 0;
        const tick = () => {
          count++;
          if (count >= wanted || performance.now() - start > timeout) resolve({ frames: count, ms: performance.now() - start });
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    [frames, timeoutMs],
  );
}

/**
 * Wait until `seconds` of GAME time have passed: it sums the frame times the same way the game loop does
 * (each frame counts at most MAX_FRAME_DT_S), so it holds on slow software rendering too.
 */
function waitGameSeconds(page, seconds) {
  return page.evaluate(
    ([wanted, cap]) =>
      new Promise((resolve) => {
        let last = null;
        let total = 0;
        const tick = (now) => {
          if (last !== null) total += Math.min((now - last) / 1000, cap);
          last = now;
          if (total >= wanted) resolve(total);
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    [seconds, MAX_FRAME_DT_S],
  );
}

/** Wait for the HUD result line to show a HIT or a MISS and return its text. */
async function waitForResult(page) {
  await page.waitForFunction(() => /HIT|MISS/.test(document.querySelector('.hud-result')?.textContent ?? ''), undefined, {
    timeout: RESULT_TIMEOUT_MS,
  });
  return (await page.locator('.hud-result').textContent()) ?? '';
}

const gameState = (page) => page.evaluate(() => window.__game.state());

/** Wait until the mission has exactly `n` targets standing. */
async function waitForTargetsLeft(page, n) {
  try {
    await page.waitForFunction((wanted) => window.__game.state().targetsLeft === wanted, n, { timeout: RESULT_TIMEOUT_MS });
  } catch (error) {
    throw new Error(`timed out waiting for targetsLeft = ${n}: ${error.message}`);
  }
}

/** Wait until every image of the page has loaded: leaving while the menu pictures load aborts them, which would count as failed requests. */
const imagesLoaded = (page) =>
  page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0), undefined, { timeout: 15_000 });

/** What the menu's controls show (read from the DOM, so it works without ?debug=1 too). */
const menuDom = (page) =>
  page.evaluate(() => {
    const checked = (name) => document.querySelector(`input[name=${name}]:checked`)?.value;
    const text = (id) => document.getElementById(id)?.textContent;
    return {
      theme: checked('theme'),
      range: text('menu-range-value'),
      soldiers: text('menu-soldiers-value'),
      vehicleTargets: text('menu-vehicle-targets-value'),
      wind: text('menu-wind-speed-value'),
      clock: text('menu-dial-value'),
      rifle: checked('rifle'),
      buildings: checked('buildings'),
      vehicles: checked('vehicles'),
      position: checked('position'),
      positionNote: document.querySelector('input[name=position]')?.closest('.menu-field')?.querySelector('.menu-seg-note')?.textContent,
      suppressed: document.querySelector('input[name=suppressed]')?.checked,
      suppressedText: document.querySelector('input[name=suppressed]')?.closest('label')?.querySelector('.menu-toggle-state')?.textContent,
      camo: document.querySelector('input[name=camo]')?.checked,
      camoText: document.querySelector('input[name=camo]')?.closest('label')?.querySelector('.menu-toggle-state')?.textContent,
      assists: document.querySelector('input[name=assists]')?.checked,
      assistsText: document.querySelector('input[name=assists]')?.closest('label')?.querySelector('.menu-toggle-state')?.textContent,
      snipers: text('menu-snipers-value'),
      rifleArt: document.querySelector('.menu-rifle-art')?.dataset.rifle,
    };
  });

/** Whether the menu's rifle art really shows only its crop: the picture covers the whole box on every side, and has loaded. */
const rifleArtCovers = (page) =>
  page.evaluate(() => {
    const art = document.querySelector('.menu-rifle-art');
    const outer = art.getBoundingClientRect();
    // The picture is placed inside the box's border: the inner (padding) box is what it has to cover.
    const box = { left: outer.left + art.clientLeft, top: outer.top + art.clientTop, width: art.clientWidth };
    box.right = box.left + art.clientWidth;
    box.bottom = box.top + art.clientHeight;
    const img = document.querySelector('.menu-rifle-img');
    const r = img.getBoundingClientRect();
    const eps = 0.75;
    return {
      loaded: img.complete && img.naturalWidth > 0,
      covers: r.left <= box.left + eps && r.top <= box.top + eps && r.right >= box.right - eps && r.bottom >= box.bottom - eps,
      // The crop is a strip, not the whole picture: the image is much bigger than the box.
      zoomed: r.width > box.width * 1.5,
    };
  });

/** Click a segmented-control option (the radio's label) by the radio's name and value. */
const clickSeg = (page, name, value) => page.locator('label.menu-seg-option', { has: page.locator(`input[name=${name}][value="${value}"]`) }).click();

/** Click a switch (the checkbox's label) by the checkbox's name. */
const clickSwitch = (page, name) => page.locator('label.menu-toggle', { has: page.locator(`input[name=${name}]`) }).click();

/** Does the menu fit its window without scrolling right now? */
const menuFits = (page) =>
  page.evaluate(() => {
    const m = document.querySelector('.menu');
    return { scroll: m.scrollHeight, client: m.clientHeight };
  });

const menuConfig = (page) => page.evaluate(() => window.__menu.get());

/** The mission code (the `m=` value) in the page's URL. */
const missionCode = (page) => new URL(page.url()).searchParams.get('m');

/**
 * Press the real Start button and wait for the mission page. With `debug` the menu carries `&debug=1` into
 * the URL, so the debug hook comes up and we wait for it.
 */
async function clickStart(page, { debug }) {
  const url = debug ? /\?m=v6\.[^&]+&debug=1$/ : /\?m=v6\.[^&]+$/;
  await Promise.all([page.waitForURL(url), page.locator('.menu-start').click()]);
  if (debug) await page.waitForFunction(() => Boolean(window.__game), undefined, { timeout: 15_000 });
  else await page.waitForSelector('.hud');
}

/**
 * Point the view at `point` raised by `hold` metres, pull the trigger, and return the HUD text once the bullet
 * has landed. Fails if the trigger pull was ignored (no new shot in the stats).
 */
async function shootAt(page, point, hold) {
  const before = (await gameState(page)).stats.shots;
  await page.evaluate(
    ([x, y, z]) => {
      window.__game.aimAt(x, y, z);
      window.__game.fire();
    },
    [point.x, point.y + hold, point.z],
  );
  check((await gameState(page)).stats.shots === before + 1, `the shot was fired (shot ${before + 1})`);
  await page.waitForFunction(
    () => {
      const text = document.querySelector('.hud-result')?.textContent ?? '';
      return text !== '' && text !== 'Shot away…';
    },
    undefined,
    { timeout: RESULT_TIMEOUT_MS },
  );
  return (await page.locator('.hud-result').textContent()) ?? '';
}

/** The text of each results row, as { label: value }. */
async function resultsRows(page) {
  return page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('.results-row')].map((row) => [
        row.querySelector('.results-label')?.textContent,
        row.querySelector('.results-value')?.textContent,
      ]),
    ),
  );
}

/**
 * The screen boxes of the HUD's panels: status (top left), threat line (top centre), assist panel (top right), key hint (bottom).
 * `threatText` (the longest line) is put into the threat panel for the measurement and taken out again at once.
 */
function panelRects(page, threatText) {
  return page.evaluate((longest) => {
    const threat = document.querySelector('.threat-panel');
    const kept = threat?.textContent ?? '';
    if (threat && longest) threat.textContent = longest;
    const rect = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return r.width > 0 && r.height > 0 ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null;
    };
    const out = { hud: rect('.hud-panel'), threat: rect('.threat-panel'), assist: rect('.assist-panel'), hint: rect('.hud-hint') };
    if (threat && longest) threat.textContent = kept;
    return out;
  }, threatText);
}

const rectsOverlap = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
const rectText = (r) => `${Math.round(r.left)},${Math.round(r.top)}-${Math.round(r.right)},${Math.round(r.bottom)}`;

/** No two HUD panels overlap and every panel is inside the window. */
function checkPanelsClear(rects, width, height, label) {
  const names = Object.keys(rects).filter((k) => rects[k] !== null);
  log(`${label}: ${names.map((k) => `${k} ${rectText(rects[k])}`).join(' | ')}`);
  for (const name of names) {
    const r = rects[name];
    check(r.left >= 0 && r.top >= 0 && r.right <= width && r.bottom <= height, `${label}: the ${name} panel is inside the window`);
  }
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      check(!rectsOverlap(rects[names[i]], rects[names[j]]), `${label}: the ${names[i]} and ${names[j]} panels do not overlap`);
    }
  }
}

/** "Target 198 m · Hold 0.7 mil high, 0.4 mil left" -> range and signed offsets in mil (up and right positive); null when it is not a call. */
function parseSpotter(text) {
  const m = /^Target (\d+) m · (.+)$/.exec(text);
  if (!m) return null;
  const up = /(\d+\.\d) mil (high|low)/.exec(m[2]);
  const side = /(\d+\.\d) mil (left|right)/.exec(m[2]);
  return {
    rangeM: Number(m[1]),
    upMil: up ? Number(up[1]) * (up[2] === 'high' ? 1 : -1) : 0,
    rightMil: side ? Number(side[1]) * (side[2] === 'right' ? 1 : -1) : 0,
  };
}

async function run() {
  check(existsSync(join(ROOT, 'dist', 'index.html')), 'dist/index.html exists (run `npm run build` first)');
  mkdirSync(OUT_DIR, { recursive: true });
  for (const name of readdirSync(OUT_DIR)) if (name.endsWith('.png')) rmSync(join(OUT_DIR, name)); // no stale evidence

  let preview = null;
  let browser = null;
  const cleanup = async () => {
    await browser?.close().catch(() => undefined);
    await stopPreview(preview);
  };
  // Never leave the preview server behind, even on Ctrl-C.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => cleanup().finally(() => process.exit(130)));
  }

  try {
    const port = await pickPort();
    preview = await startPreview(port);
    log(`vite preview on ${preview.url}`);

    const launched = await launchChrome();
    browser = launched.browser;
    log(`Chrome ${browser.version()}, ${launched.renderer}`);
    const problems = [];
    const soundFiles = new Set(); // the recordings fetched successfully, by file name
    /** A fresh page whose console errors, page errors, failed requests, 4xx/5xx and sound warnings all land in `problems`. */
    const openPage = async () => {
      const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
      page.on('console', (message) => {
        if (message.type() === 'error') problems.push(`console.error: ${message.text()}`);
        // A recording that failed to fetch or decode logs a warning and the game plays a synth instead.
        if (message.type() === 'warning' && /unavailable/.test(message.text())) problems.push(`console.warn: ${message.text()}`);
      });
      page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
      page.on('requestfailed', (request) => problems.push(`request failed: ${request.url()} ${request.failure()?.errorText}`));
      page.on('response', (response) => {
        if (response.status() >= 400) problems.push(`HTTP ${response.status()}: ${response.url()}`);
        else if (/\/sounds\/[^/]+\.mp3$/.test(response.url())) soundFiles.add(response.url().split('/').pop());
      });
      return page;
    };
    const startGame = async (page, query) => {
      await page.goto(`${preview.url}?${query}`, { waitUntil: 'load' });
      try {
        await page.waitForFunction(() => Boolean(window.__game), undefined, { timeout: 15_000 });
      } catch {
        throw new Error(`the game did not start (no window.__game). Problems: ${problems.join(' | ') || 'none logged'}`);
      }
    };

    // 0. Without ?debug=1 the production build must not expose the debug hook. Wait until the game is
    // really running (HUD built, frames drawn), otherwise "undefined" would only mean "not started yet".
    const plain = await openPage();
    await plain.goto(`${preview.url}?range=800`, { waitUntil: 'load' });
    await plain.waitForSelector('.hud');
    const plainFrames = await animationFrames(plain, 3);
    check(plainFrames.frames >= 3, 'the game runs without ?debug=1');
    check((await plain.evaluate(() => window.__game)) === undefined, 'window.__game is undefined without ?debug=1');
    // The practice range's HUD Menu link goes to the menu holding the legacy-derived settings; no debug=1 to carry.
    check(
      (await plain.locator('.hud-menu').getAttribute('href')) === '/?last=v6.d.800.800.1.0.45.9.308.n.n.1.r.0.0.0.0.0.c.n',
      'the practice range\'s HUD Menu link points at the menu with its settings (no debug=1)',
    );
    await plain.close();

    const page = await openPage();
    await startGame(page, 'range=800&debug=1');
    check(
      (await page.locator('.hud-line', { hasText: 'Sound: click to start' }).count()) === 1,
      'HUD says "Sound: click to start" before any audio exists',
    );
    // What the first click does: creates the audio context, decodes the recordings, starts the wind.
    // The mp3s were already requested at start-up (prefetch); a 4xx or a decode failure ends up in `problems`.
    await page.evaluate(() => window.__game.unlockAudio());
    await page.waitForTimeout(3000);
    await page.waitForFunction(() => /Sound on \(M\)/.test(document.querySelector('.hud-panel')?.textContent ?? ''), undefined, {
      timeout: 10_000,
    });
    check(true, 'after unlockAudio the audio context runs and the HUD says "Sound on (M)"');
    check(soundFiles.size === 7, `all 7 recordings in public/sounds were served (${[...soundFiles].sort().join(', ')})`);

    // Is it actually animating? Wait for a few animation frames (software rendering can take seconds).
    const { frames, ms } = await animationFrames(page, 5);
    log(`${frames} animation frames in ${Math.round(ms)} ms`);
    check(frames >= 5, 'the game loop is running');

    // 1. Naked eye: the canvas shows a scene, not one flat colour.
    await shoot(page, { hideHud: false, path: join(OUT_DIR, 'naked.png') });
    const naked = await analyzePng(page, await shoot(page, { hideHud: true }));
    log(`naked canvas: ${JSON.stringify(naked)}`);
    check(naked.distinctAll >= 6, `naked-eye canvas is not one colour (${naked.distinctAll} distinct sampled colours)`);
    check(Math.abs(naked.skyLuma - naked.groundLuma) > 10, 'sky and ground differ in brightness');
    check((await page.locator('.hud-line', { hasText: 'naked eye' }).count()) === 1, 'HUD says naked eye');

    // 2. Scope on: black surround with a lens in the middle, HUD shows the magnification.
    await page.evaluate(() => window.__game.toggleScope());
    await page.waitForTimeout(500);
    const scopePng = await shoot(page, { hideHud: false, path: join(OUT_DIR, 'scope.png') });
    const scope = await analyzePng(page, scopePng);
    log(`scope: ${JSON.stringify(scope)}`);
    check(await page.locator('.scope-overlay').isVisible(), 'scope overlay is visible');
    check((await page.locator('.hud-line', { hasText: /Zoom \d/ }).count()) === 1, 'HUD shows the scope magnification');
    check((await page.locator('.hud-line', { hasText: 'Zoom 8.0' }).count()) === 1, 'the scope opens at 8x');
    // The click-to-aim hint (visible: the debug hook never grabs the pointer) must sit below the lens.
    const lensBox = await page.locator('.scope-lens').boundingBox();
    const hintBox = await page.locator('.hud-hint').boundingBox();
    check(
      lensBox !== null && hintBox !== null && hintBox.y >= lensBox.y + lensBox.height,
      `the hint is below the scope lens (hint top ${hintBox?.y.toFixed(0)}, lens bottom ${lensBox ? (lensBox.y + lensBox.height).toFixed(0) : '?'})`,
    );
    check(scope.maxCorner < 12, `scope surround is black (corner brightness ${scope.maxCorner.toFixed(1)})`);
    check(scope.distinctMiddle >= 4, `scope lens shows the scene (${scope.distinctMiddle} distinct sampled colours)`);

    // 3. Fire straight at the target (no pointer lock needed through the debug hook) and wait for the result.
    // The two extra clicks come while the bolt is being worked: they must not fire (still Rounds 4/5).
    await page.evaluate(() => {
      window.__game.fire();
      window.__game.fire();
      window.__game.fire();
    });
    const result = await waitForResult(page);
    log(`HUD result: "${result}"`);
    check(/HIT|MISS/.test(result), 'HUD shows HIT or MISS after the shot');
    check(
      (await page.locator('.hud-line', { hasText: 'Rounds 4/5' }).count()) === 1,
      'three fast clicks used one round only (bolt cycle lockout, Rounds 4/5)',
    );
    await page.screenshot({ path: join(OUT_DIR, 'result.png') });

    // 4. At 100 m with no wind a shot at the chest must hit; the dummy falls and then stands up again.
    const near = await openPage();
    await startGame(near, 'range=100&wind=0&debug=1');
    await near.evaluate(() => window.__game.unlockAudio());
    await near.evaluate(() => window.__game.toggleScope()); // 8x: the dummy is big enough to see in the screenshots
    await animationFrames(near, 5);
    await near.screenshot({ path: join(OUT_DIR, 'standing-100m.png') });
    await near.evaluate(() => window.__game.fire());
    const nearResult = await waitForResult(near);
    log(`100 m HUD result: "${nearResult}"`);
    check(/HIT/.test(nearResult), 'a shot straight at the chest at 100 m hits');
    await near.waitForTimeout(1000);
    await near.screenshot({ path: join(OUT_DIR, 'hit-100m.png') });

    await waitGameSeconds(near, DUMMY_RESET_GAME_S);
    await near.screenshot({ path: join(OUT_DIR, 'reset-100m.png') });
    await near.evaluate(() => window.__game.fire());
    const againResult = await waitForResult(near);
    log(`100 m HUD result after the dummy stood up: "${againResult}"`);
    check(/HIT/.test(againResult), 'the dummy stood up again by itself and the next shot hits it');
    check((await near.locator('.hud-line', { hasText: 'Rounds 3/5' }).count()) === 1, 'two rounds were used (Rounds 3/5)');

    // 5. Reload: pulling the trigger meanwhile says so, and the magazine is full again after 1.5 s of game time.
    await near.evaluate(() => {
      window.__game.reload();
      window.__game.fire();
    });
    check(((await near.locator('.hud-result').textContent()) ?? '') === 'Reloading…', 'firing during a reload shows "Reloading…"');
    check((await near.locator('.hud-line', { hasText: 'reloading…' }).count()) === 1, 'the rounds line says reloading');
    await waitGameSeconds(near, 1.7);
    check((await near.locator('.hud-line', { hasText: 'Rounds 5/5' }).count()) === 1, 'the reload refilled the magazine (Rounds 5/5)');
    check(((await near.locator('.hud-result').textContent()) ?? '') === '', 'the "Reloading…" message is gone once the reload is done');

    await near.close();
    await page.close();

    // 5b. The first-person rifle: drawn over the lower right of the view while not scoped, hidden in the scope.
    // Aimed far above the horizon the whole lower half of the picture is blue sky, so anything in its lower right that
    // is not sky is the rifle. The scope's black DOM mask is hidden so it cannot stand in for "hidden".
    const hand = await openPage();
    await startGame(hand, 'range=300&wind=0&debug=1');
    const handHead = (await gameState(hand)).soldiers[0].head;
    await hand.evaluate(([x, y, z]) => window.__game.aimAt(x, y, z), [handHead.x, handHead.y + 600, handHead.z]);
    await animationFrames(hand, 5);
    const handShown = await nonSkyFraction(hand, await shoot(hand, { hideHud: true, path: join(OUT_DIR, 'rifle-unscoped.png') }));
    const handCallsShown = (await gameState(hand)).render.calls;
    log(`rifle: unscoped, ${(handShown * 100).toFixed(0)} % of the lower-right points are not sky, ${handCallsShown} draw calls`);
    check(handShown > 0.15, 'unscoped, the first-person rifle is drawn in the lower right of the view');
    await hand.evaluate(() => {
      window.__game.toggleScope();
      document.querySelector('.scope-overlay')?.style.setProperty('display', 'none');
    });
    await animationFrames(hand, 5);
    const handHidden = await nonSkyFraction(hand, await shoot(hand, { hideHud: true, path: join(OUT_DIR, 'rifle-scoped.png') }));
    const handCallsHidden = (await gameState(hand)).render.calls;
    log(`rifle: scoped, ${(handHidden * 100).toFixed(0)} % of the lower-right points are not sky, ${handCallsHidden} draw calls`);
    check(handHidden === 0, 'scoped, the first-person rifle is hidden');
    check(
      handCallsShown > handCallsHidden && handCallsShown - handCallsHidden <= 15,
      `the rifle adds a handful of draw calls to the reading (${handCallsHidden} -> ${handCallsShown})`,
    );
    await hand.close();

    // A suppressed .338: the rifle shows, the shot goes off with the quiet sound, nothing throws (errors land in `problems`).
    const quiet = await openPage();
    await startGame(quiet, 'm=v2.d.300.300.3.0.0.9.338.n.n.1.r.1.0.0&debug=1');
    await quiet.evaluate(() => window.__game.unlockAudio());
    const quietHead = (await gameState(quiet)).soldiers[0].head;
    await quiet.evaluate(([x, y, z]) => window.__game.aimAt(x, y, z), [quietHead.x, quietHead.y + 600, quietHead.z]);
    await animationFrames(quiet, 5);
    const quietShown = await nonSkyFraction(quiet, await shoot(quiet, { hideHud: true, path: join(OUT_DIR, 'rifle-suppressed.png') }));
    check(quietShown > 0.15, `the suppressed .338 rifle is drawn too (${(quietShown * 100).toFixed(0)} % of the points)`);
    await quiet.evaluate(() => window.__game.fire());
    check((await gameState(quiet)).stats.shots === 1, 'a shot with the suppressor fitted goes off');
    await animationFrames(quiet, 10);
    await quiet.close();

    // 6. A real mission: three soldiers at 300 m, calm air. Down them one by one.
    const mission = await openPage();
    await startGame(mission, `m=${MISSION_OPEN}&debug=1`);
    await mission.evaluate(() => window.__game.unlockAudio());
    let st = await gameState(mission);
    check(st.targetsLeft === 3 && st.soldiers.length === 3, 'a non-legacy mission starts with 3 targets standing');
    check(st.stats.startMs === null, 'the mission clock is stopped before the first pointer lock or shot');
    check(
      (await mission.locator('.assist-panel').count()) === 0 && (await mission.locator('.aim-marker').count()) === 0,
      'assists disabled (the default): no assist panel and no aim marker',
    );
    for (const key of ['KeyT', 'KeyA', 'KeyP']) await mission.keyboard.press(key);
    await animationFrames(mission, 3);
    check(
      (await mission.locator('.assist-panel').count()) === 0 && (await mission.locator('.aim-marker').count()) === 0 && !(await gameState(mission)).stats.assistsUsed,
      'assists disabled: the keys T, A and P do nothing',
    );
    check(
      st.snipers.length === 0 && st.snipersLeft === 0 && st.health === 100 && st.detection === 0 && !st.covered,
      'a mission without enemy snipers: no snipers, full health, no detection',
    );
    check(
      (await mission.locator('.threat-panel').count()) === 0 && (await mission.locator('.cover-mask').count()) === 0,
      'a mission without enemy snipers has no threat panel and no cover mask',
    );
    await mission.keyboard.press('KeyC');
    check(!(await gameState(mission)).covered, 'C does nothing in a mission without enemy snipers');
    await mission.evaluate(() => window.__game.setDetection(100)); // no encounter: the call changes nothing
    check((await gameState(mission)).detection === 0, 'setDetection does nothing without enemy snipers');
    check((await mission.locator('.hud-line', { hasText: 'Targets 3/3' }).count()) === 1, 'HUD says "Targets 3/3"');
    check((await mission.locator('.hud-line', { hasText: "Wind calm" }).count()) === 1, 'HUD says "Wind calm" at 0 m/s');
    await animationFrames(mission, 5);
    const missionPng = await analyzePng(mission, await shoot(mission, { hideHud: true, path: join(OUT_DIR, 'mission-start.png') }));
    check(missionPng.distinctAll >= 6, `the mission canvas is not one colour (${missionPng.distinctAll} distinct sampled colours)`);
    check(Math.abs(missionPng.skyLuma - missionPng.groundLuma) > 10, 'the mission shows sky and ground');
    log(`mission draw calls ${st.render.calls}, triangles ${st.render.triangles}`);

    // Rangefinder: aim at a soldier's chest and the HUD reads about 300 m.
    await mission.evaluate(([x, y, z]) => window.__game.aimAt(x, y, z), [st.soldiers[1].upperTorso.x, st.soldiers[1].upperTorso.y, st.soldiers[1].upperTorso.z]);
    await mission.waitForFunction(() => /Range (29\d|30\d) m/.test(document.querySelector('.hud-panel')?.textContent ?? ''), undefined, {
      timeout: RESULT_TIMEOUT_MS,
    });
    check(true, 'the rangefinder reads about 300 m on a soldier at 300 m');

    const first = await shootAt(mission, st.soldiers[0].upperTorso, HOLD_300M);
    log(`mission shot 1: "${first}"`);
    check(/HIT/.test(first), 'a chest shot with hold-over hits the first soldier');
    check(typeof (await gameState(mission)).stats.startMs === 'number', 'the first shot started the mission clock');
    await waitForTargetsLeft(mission, 2);
    check((await mission.locator('.hud-line', { hasText: 'Targets 2/3' }).count()) === 1, 'HUD says "Targets 2/3"');
    await mission.screenshot({ path: join(OUT_DIR, 'mission-hit.png') });
    await waitGameSeconds(mission, DUMMY_RESET_GAME_S + 1); // a practice dummy would stand up again by now
    st = await gameState(mission);
    check(st.targetsLeft === 2 && st.soldiers[0].down, 'the downed soldier stays down (no auto-reset in a mission)');

    for (const index of [1, 2]) {
      const result = await shootAt(mission, st.soldiers[index].upperTorso, HOLD_300M);
      log(`mission shot ${index + 1}: "${result}"`);
      check(/HIT/.test(result), `a chest shot with hold-over hits soldier ${index + 1}`);
      await waitForTargetsLeft(mission, 2 - index);
      if (index < 2) await waitGameSeconds(mission, BOLT_GAME_S);
    }
    st = await gameState(mission);
    check(st.complete && st.stats.endMs !== null, 'all targets down: the mission is complete');
    check(!st.resultsShown, 'the results wait 1.5 s after the last target');
    await mission.waitForSelector('.results', { timeout: RESULT_TIMEOUT_MS });
    const rows = await resultsRows(mission);
    log(`results: ${JSON.stringify(rows)}`);
    check(rows['Shots fired'] === '3' && rows['Hits'] === '3' && rows['Accuracy'] === '100 %', 'results: 3 shots, 3 hits, 100 % accuracy');
    check(!('Assists used' in rows), 'results: no "Assists used" line when no assist was on');
    check(/^(29\d|30\d) m$/.test(rows['Longest hit'] ?? ''), `results: longest hit about 300 m (${rows['Longest hit']})`);
    check(/^\d\d:\d\d$/.test(rows['Mission time'] ?? ''), `results: mission time as mm:ss (${rows['Mission time']})`);
    check((await mission.locator('.results-button').count()) === 2, 'results: Restart and Menu buttons');
    check((await mission.evaluate(() => document.pointerLockElement)) === null, 'the pointer is not locked on the results screen');
    await mission.screenshot({ path: join(OUT_DIR, 'mission-results.png') });
    await mission.waitForLoadState('networkidle'); // leaving while the sound files load would abort them
    await Promise.all([mission.waitForURL(/\?last=v6\.d\.300\.300\.3\.0\.0\.9\.308\.n\.n\.1\.r\.0\.0\.0\.0\.0\.c\.n&debug=1$/), mission.locator('.results-menu').click()]);
    await mission.waitForSelector('.menu-start');
    await imagesLoaded(mission);
    check((await mission.locator('.menu-start').count()) === 1, 'Menu returns to the start menu with the mission in ?last= (and debug=1 kept)');
    check((await mission.evaluate(() => window.__game)) === undefined, 'the start menu runs no game');
    check((await mission.evaluate(() => typeof window.__menu?.get)) === 'function', 'the results Menu button kept debug=1: window.__menu exists');
    const prefilled = await menuDom(mission);
    log(`menu pre-filled from ?last=: ${JSON.stringify(prefilled)}`);
    check(
      prefilled.theme === 'desert' && prefilled.range === '300 m' && prefilled.soldiers === '3' && prefilled.vehicleTargets === '0',
      'the menu is pre-filled with the last mission (desert, 300 m, 3 soldiers, no vehicle targets)',
    );
    check(
      prefilled.wind === '0.0 m/s · 0 mph' && prefilled.clock === "from 9 o'clock (left)" && prefilled.rifle === '308',
      'the menu is pre-filled with the last mission\'s calm wind and .308',
    );
    check(prefilled.buildings === 'none' && prefilled.vehicles === 'none', 'the menu is pre-filled with the last mission\'s no buildings, no vehicles');

    // Start from the pre-filled menu: the same mission with a new seed (debug=1 is carried along, so the hook is up).
    await clickStart(mission, { debug: true });
    check(/^v6\.d\.300\.300\.3\.0\.0\.9\.308\.n\.n\.\d+\.r\.0\.0\.0\.0\.0\.c\.n$/.test(missionCode(mission) ?? ''), `Start runs the pre-filled mission (${missionCode(mission)})`);
    check(missionCode(mission) !== 'v6.d.300.300.3.0.0.9.308.n.n.1.r.0.0.0.0.0.c.n', 'Start rolls a fresh seed');
    const restartedFrames = await animationFrames(mission, 3);
    check(restartedFrames.frames >= 3, 'the mission started from the menu runs');
    check((await mission.locator('.hud-line', { hasText: 'Targets 3/3' }).count()) === 1, 'menu start: HUD says "Targets 3/3"');
    await mission.close();

    // 6b. Aim assists: a mission that enables them gets the panel; T / A / P toggle the trajectory line, the aim marker and the spotter.
    const assisted = await openPage();
    await startGame(assisted, `m=${MISSION_ASSISTS}&debug=1`);
    await assisted.evaluate(() => window.__game.toggleScope()); // the scope opens at 8x
    await animationFrames(assisted, 3);
    st = await gameState(assisted);
    const modeButton = (mode) => assisted.locator(`.assist-button[data-mode=${mode}]`);
    const pressed = async (mode) => (await modeButton(mode).getAttribute('aria-pressed')) === 'true';
    check((await assisted.locator('.assist-panel').count()) === 1, 'assists enabled: the assist panel is there');
    check((await assisted.locator('.assist-button').count()) === 3, 'the panel has three toggles (T, A, P)');
    check(
      /^T · Trajectory OFF$/.test((await modeButton('trajectory').textContent()) ?? '') &&
        /^A · Aim marker OFF$/.test((await modeButton('aim').textContent()) ?? '') &&
        /^P · Spotter OFF$/.test((await modeButton('spotter').textContent()) ?? ''),
      'the toggles read T / A / P and start OFF',
    );
    check(!(await assisted.locator('.aim-marker').isVisible()) && !(await assisted.locator('.assist-spotter').isVisible()), 'with every assist off there is no marker and no spotter text');
    const assistedHint = (await assisted.locator('.hud-hint').textContent()) ?? '';
    check(/T\/A\/P assists/.test(assistedHint) && !/ C cover/.test(assistedHint), `the hint of a mission with assists and no snipers lists T/A/P but not C (${assistedHint})`);
    check(!st.stats.assistsUsed, 'no assist used yet');
    // The panel stays clear of the scope lens.
    const lens = await assisted.locator('.scope-lens').boundingBox();
    const panelBox = await assisted.locator('.assist-panel').boundingBox();
    const lensX = lens.x + lens.width / 2;
    const lensY = lens.y + lens.height / 2;
    const nearX = Math.min(Math.max(lensX, panelBox.x), panelBox.x + panelBox.width);
    const nearY = Math.min(Math.max(lensY, panelBox.y), panelBox.y + panelBox.height);
    check(Math.hypot(nearX - lensX, nearY - lensY) > lens.width / 2, 'the assist panel does not cover the scope lens');
    // Typing in a text field does not toggle anything.
    await assisted.evaluate(() => {
      const input = document.createElement('input');
      input.id = 'smoke-typing';
      document.body.appendChild(input);
      input.focus();
    });
    await assisted.keyboard.press('KeyT');
    await assisted.keyboard.press('KeyA');
    await assisted.keyboard.press('KeyP');
    check(!(await pressed('trajectory')) && !(await pressed('aim')) && !(await pressed('spotter')), 'T, A and P typed into an input field toggle nothing');
    await assisted.evaluate(() => document.getElementById('smoke-typing')?.remove());

    const chest = st.soldiers[0].upperTorso;
    // T: the line is drawn into the 3D scene. Aimed along the horizon the shot falls a long way below the view axis (it only meets the
    // ground some 800 m out), so the line is long. (Aimed at a target 300 m away it is a few pixels: it ends just behind the target.)
    await assisted.evaluate(() => window.__game.aimAt(0, 13, -3000));
    await waitGameSeconds(assisted, 0.5);
    // Measured on the middle of the scope with the HUD and the panel hidden (their ON/OFF text would change it too).
    const middle = { x: 440, y: 160, width: 400, height: 400 };
    const hideOverlays = (hidden) =>
      assisted.evaluate((h) => document.querySelectorAll('.hud, .assist-panel').forEach((n) => n.style.setProperty('visibility', h ? 'hidden' : 'visible')), hidden);
    await hideOverlays(true);
    const lineOff = await assisted.screenshot({ clip: middle });
    await waitGameSeconds(assisted, 0.4);
    const lineOffAgain = await assisted.screenshot({ clip: middle });
    await hideOverlays(false);
    check((await pngDiff(assisted, lineOff, lineOffAgain)) < 20, 'the scope picture is steady while the trajectory is off (nothing else moves)');
    await assisted.keyboard.press('KeyT');
    check(await pressed('trajectory'), 'key T switches the trajectory preview ON');
    await waitGameSeconds(assisted, 0.4);
    await hideOverlays(true);
    const lineOn = await assisted.screenshot({ clip: middle });
    await hideOverlays(false);
    const lineDiff = await pngDiff(assisted, lineOff, lineOn);
    check(lineDiff > 40, `T draws the trajectory line into the scene (${lineDiff} pixels changed)`);
    await assisted.screenshot({ path: join(OUT_DIR, 'assists-trajectory.png') });
    check((await gameState(assisted)).stats.assistsUsed, 'switching an assist on marks the mission "assists used"');
    await assisted.keyboard.press('KeyT');
    check(!(await pressed('trajectory')), 'T again switches it OFF');
    await waitGameSeconds(assisted, 0.4);
    await hideOverlays(true);
    const lineGone = await assisted.screenshot({ clip: middle });
    await hideOverlays(false);
    check((await pngDiff(assisted, lineOff, lineGone)) < 20, 'the line is gone again with T OFF');

    // The same with the naked eye, aimed well above the horizon.
    await assisted.evaluate(() => {
      window.__game.toggleScope();
      window.__game.aimAt(0, 200, -1000);
    });
    await waitGameSeconds(assisted, 0.4);
    const whole = { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height };
    await hideOverlays(true);
    const arcOff = await assisted.screenshot({ clip: whole });
    await hideOverlays(false);
    await assisted.keyboard.press('KeyT');
    await waitGameSeconds(assisted, 0.4);
    await hideOverlays(true);
    const arcOn = await assisted.screenshot({ clip: whole });
    await hideOverlays(false);
    const arcDiff = await pngDiff(assisted, arcOff, arcOn);
    check(arcDiff > 40, `T draws the line with the naked eye too, aimed above the horizon (${arcDiff} pixels changed)`);
    await assisted.screenshot({ path: join(OUT_DIR, 'assists-arc.png') });
    await assisted.keyboard.press('KeyT');
    await assisted.evaluate(([x, y, z]) => {
      window.__game.toggleScope();
      window.__game.aimAt(x, y, z);
    }, [chest.x, chest.y, chest.z]);
    await waitGameSeconds(assisted, 0.4);

    // A (by a real click on the button): the diamond. With the crosshair on the chest it sits just above the crosshair (the hold-over) and inside the lens.
    await modeButton('aim').click();
    check(await pressed('aim'), 'clicking the A button switches the aim marker ON');
    check((await assisted.evaluate(() => document.pointerLockElement)) === null, 'a click on an assist button does not grab the pointer');
    await waitGameSeconds(assisted, 0.4);
    check(await assisted.locator('.aim-marker').isVisible(), 'A shows the aim marker (◇)');
    const markerAt = async () => {
      const box = await assisted.locator('.aim-marker').boundingBox();
      return { x: box.x + box.width / 2 - VIEWPORT.width / 2, y: box.y + box.height / 2 - VIEWPORT.height / 2 };
    };
    const m1 = await markerAt();
    check(m1.y < -2 && Math.abs(m1.y) < 60 && Math.abs(m1.x) < 60, `the marker is above the crosshair by the hold-over (${m1.x.toFixed(0)}, ${m1.y.toFixed(0)} px from the centre)`);
    await assisted.screenshot({ path: join(OUT_DIR, 'assists-marker.png') });

    // P: the spotter's call.
    await assisted.keyboard.press('KeyP');
    check(await pressed('spotter'), 'key P switches the spotter ON');
    await waitGameSeconds(assisted, 0.4);
    const call = (await assisted.locator('.assist-spotter').textContent()) ?? '';
    log(`spotter: "${call}"`);
    const called = /^Target (29\d|30\d) m · Hold (\d+\.\d) mil high, (\d+\.\d) mil left$/.exec(call);
    check(called !== null, 'P shows the call: the range, "Hold … mil high" and, for wind from the left, "… mil left"');
    const rangeM = Number(called[1]);
    const upMil = Number(called[2]);
    const leftMil = Number(called[3]);
    check(upMil > 1 && upMil < 2.5, `the hold-over at 300 m is about 1.5 mil (${upMil})`);
    await assisted.screenshot({ path: join(OUT_DIR, 'assists-all.png') });

    // Follow the call: put the crosshair that far above and left of the chest. The marker then sits on the crosshair, the spotter says on target, and the shot hits.
    const bearing = Math.atan2(chest.x, -chest.z); // the shooter is at the origin; right = (cos b, 0, sin b)
    const hold = {
      x: chest.x - rangeM * Math.tan(leftMil / 1000) * Math.cos(bearing),
      y: chest.y + rangeM * Math.tan(upMil / 1000),
      z: chest.z - rangeM * Math.tan(leftMil / 1000) * Math.sin(bearing),
    };
    await assisted.evaluate(([x, y, z]) => window.__game.aimAt(x, y, z), [hold.x, hold.y, hold.z]);
    await waitGameSeconds(assisted, 0.4);
    const m2 = await markerAt();
    check(Math.hypot(m2.x, m2.y) < 4, `with the crosshair where the spotter said, the marker sits on it (${m2.x.toFixed(1)}, ${m2.y.toFixed(1)} px off the centre)`);
    const settled = (await assisted.locator('.assist-spotter').textContent()) ?? '';
    check(/On target|Hold 0\.1 mil/.test(settled), `...and the spotter says so ("${settled}")`);
    const assistedShot = await shootAt(assisted, hold, 0);
    log(`assisted shot: "${assistedShot}"`);
    check(/HIT/.test(assistedShot), 'the shot taken as the spotter called it hits the chest');
    await assisted.waitForSelector('.results', { timeout: RESULT_TIMEOUT_MS });
    const assistedRows = await resultsRows(assisted);
    check(assistedRows['Assists used'] === 'Yes', 'the results say "Assists used: Yes"');
    check((await assisted.locator('.assist-panel').count()) === 0 && (await assisted.locator('.aim-marker').count()) === 0, 'the results screen takes the assist panel and marker away');
    await assisted.screenshot({ path: join(OUT_DIR, 'assists-results.png') });
    await assisted.close();

    // 7. Restart reloads the same mission from scratch.
    const single = await openPage();
    await startGame(single, `m=${MISSION_SINGLE}&debug=1`);
    st = await gameState(single);
    check(st.targetsLeft === 1 && st.soldiers.length === 1, 'a one-soldier mission has one target');
    const single1 = await shootAt(single, st.soldiers[0].upperTorso, HOLD_300M);
    check(/HIT/.test(single1), 'the single soldier is hit');
    await single.waitForSelector('.results', { timeout: RESULT_TIMEOUT_MS });
    await Promise.all([single.waitForNavigation({ waitUntil: 'load' }), single.locator('.results-restart').click()]);
    await single.waitForFunction(() => Boolean(window.__game), undefined, { timeout: 15_000 });
    st = await gameState(single);
    check(st.targetsLeft === 1 && st.stats.shots === 0 && !st.resultsShown, 'Restart reloads the mission: target standing, score reset');
    check((await single.locator('.results').count()) === 0, 'the results are gone after Restart');
    await single.close();

    // 8. Cover and vehicle targets: 3 soldiers + 2 vehicle targets among many buildings and vehicles.
    const cover = await openPage();
    await startGame(cover, `m=${MISSION_COVER}&debug=1`);
    await cover.evaluate(() => window.__game.unlockAudio());
    st = await gameState(cover);
    check(st.targetsLeft === 5 && st.vehicles.length === 2, 'the cover mission has 5 targets (3 soldiers, 2 vehicles)');
    await animationFrames(cover, 5);
    log(`cover mission draw calls ${st.render.calls}, triangles ${st.render.triangles}`);
    const perf = await animationFrames(cover, 60);
    log(`cover mission: ${perf.frames} frames in ${Math.round(perf.ms)} ms (${((perf.frames / perf.ms) * 1000).toFixed(0)} fps, ${launched.renderer}, headless)`);
    const coverPng = await analyzePng(cover, await shoot(cover, { hideHud: true, path: join(OUT_DIR, 'mission-cover.png') }));
    check(coverPng.distinctAll >= 6, `the cover mission canvas is not one colour (${coverPng.distinctAll} distinct sampled colours)`);

    // A soldier behind cover: aiming at the hidden lower torso is stopped by the cover.
    const covered = st.soldiers.find((s) => s.behindCover);
    check(covered !== undefined, 'one soldier of the cover mission stands behind cover');
    await cover.evaluate(([x, y, z]) => {
      window.__game.toggleScope();
      window.__game.aimAt(x, y, z);
    }, [covered.upperTorso.x, covered.upperTorso.y, covered.upperTorso.z]);
    await animationFrames(cover, 5);
    await cover.screenshot({ path: join(OUT_DIR, 'mission-cover-scoped.png') });
    await cover.evaluate(() => window.__game.toggleScope());
    const blocked = await shootAt(cover, covered.lowerTorso, HOLD_300M);
    log(`shot at the lower torso behind cover: "${blocked}"`);
    check(/^Hit cover/.test(blocked), 'a shot at a soldier\'s hidden lower torso is stopped by the cover');
    check((await gameState(cover)).targetsLeft === 5, 'the cover took the bullet: no target down');
    await waitGameSeconds(cover, BOLT_GAME_S);

    // A vehicle target: the engine hit disables it; the dead engine block then stops bullets.
    const engine = st.vehicles[0].engine;
    const vehicleHit = await shootAt(cover, engine, HOLD_300M);
    log(`shot at the engine: "${vehicleHit}"`);
    check(vehicleHit === 'VEHICLE DISABLED', 'a shot into the engine disables the vehicle');
    st = await gameState(cover);
    check(st.targetsLeft === 4 && st.vehicles[0].disabled, 'the disabled vehicle counts as a target down (4 left)');
    await waitGameSeconds(cover, BOLT_GAME_S);
    const again = await shootAt(cover, engine, HOLD_300M);
    log(`second shot at the dead engine: "${again}"`);
    check(again === 'Hit cover (metal)', 'the disabled engine is solid metal: the next bullet is stopped, not passed through');
    check((await gameState(cover)).targetsLeft === 4, 'a bullet on the dead engine downs nothing more');
    await waitGameSeconds(cover, 1);
    await cover.screenshot({ path: join(OUT_DIR, 'mission-vehicle.png') });
    await cover.close();

    // 9. The largest mission: 10 soldiers, 3 vehicle targets, many buildings and vehicles.
    const big = await openPage();
    // Record whether the "Preparing mission…" text was ever in the page (the mission builds for a moment before the first frame).
    await big.addInitScript(() => {
      window.__sawPrep = false;
      new MutationObserver(() => {
        if (document.querySelector('.prep')?.textContent === 'Preparing mission…') window.__sawPrep = true;
      }).observe(document, { childList: true, subtree: true });
    });
    await startGame(big, `m=${MISSION_MAX}&debug=1`);
    check((await big.evaluate(() => window.__sawPrep)) === true, 'the page said "Preparing mission…" while the mission was built');
    check((await big.locator('.prep').count()) === 0, 'the "Preparing mission…" text is gone once the mission runs');
    st = await gameState(big);
    check(st.targetsLeft === 13 && st.soldiers.length === 10 && st.vehicles.length === 3, 'the largest mission has 13 targets (10 soldiers, 3 vehicles)');
    await animationFrames(big, 5);
    const bigPerf = await animationFrames(big, 60);
    st = await gameState(big);
    log(
      `largest mission: ${st.render.calls} draw calls, ${st.render.triangles} triangles; ${bigPerf.frames} frames in ${Math.round(bigPerf.ms)} ms (${((bigPerf.frames / bigPerf.ms) * 1000).toFixed(0)} fps, ${launched.renderer}, headless)`,
    );
    check(st.render.calls <= MAX_DRAW_CALLS, `the largest mission stays within the draw-call budget (${st.render.calls} <= ${MAX_DRAW_CALLS})`);
    check(st.render.calls > 100, `the draw-call reading counts the world pass as well as the rifle (${st.render.calls} > 100)`);
    const bigPng = await analyzePng(big, await shoot(big, { hideHud: true, path: join(OUT_DIR, 'mission-max.png') }));
    check(bigPng.distinctAll >= 6, `the largest mission canvas is not one colour (${bigPng.distinctAll} distinct sampled colours)`);
    await big.close();

    // 10. The other themes load and draw (wind, props, a vehicle target).
    for (const code of MISSION_THEMES) {
      const themed = await openPage();
      await startGame(themed, `m=${code}&debug=1`);
      st = await gameState(themed);
      check(st.targetsLeft === 5, `mission ${code}: 5 targets standing`);
      await animationFrames(themed, 5);
      const name = code.split('.')[1] === 'a' ? 'arctic' : 'valley';
      const themedPng = await analyzePng(themed, await shoot(themed, { hideHud: true, path: join(OUT_DIR, `mission-${name}.png`) }));
      check(themedPng.distinctAll >= 6, `the ${name} mission canvas is not one colour (${themedPng.distinctAll} distinct sampled colours)`);
      log(`${name} mission draw calls ${(await gameState(themed)).render.calls}`);
      await themed.close();
    }

    // 10b. Every firing position in every theme (3 x 3 small missions with 1 soldier and 1 enemy sniper): each builds without a console
    // error, draws something that is not one colour, and stays inside the draw-call budget (the reading covers the world pass and the rifle).
    for (const [themeCode, themeName] of SMALL_THEMES) {
      for (const [positionCode, positionName] of SMALL_POSITIONS) {
        const label = `${themeName} from the ${positionName}`;
        const problemsBefore = problems.length;
        const small = await openPage();
        await startGame(small, `m=${smallMission(themeCode, positionCode)}&debug=1`);
        await animationFrames(small, 6);
        st = await gameState(small);
        check(st.targetsLeft === 2 && st.soldiers.length === 1 && st.snipers.length === 1, `${label}: 1 soldier and 1 enemy sniper stand`);
        check(st.render.calls > 20 && st.render.calls <= MAX_DRAW_CALLS, `${label}: ${st.render.calls} draw calls (within 20..${MAX_DRAW_CALLS})`);
        const smallPng = await analyzePng(small, await shoot(small, { hideHud: true, path: join(OUT_DIR, `small-${themeName}-${positionName}.png`) }));
        check(smallPng.distinctAll >= 6, `${label}: the canvas is not blank (${smallPng.distinctAll} distinct sampled colours)`);
        check(problems.length === problemsBefore, `${label}: no console errors${problems.length > problemsBefore ? `: ${problems.slice(problemsBefore).join(' | ')}` : ''}`);
        await small.close();
      }
    }

    // 10c. The render quality settings and the depth buffer: every level (and the older ?post= flags) starts without a console error, draws,
    // stays in the draw-call budget, and the post chain's float depth is reversed (only ?post=off, which draws onto the canvas, keeps the logarithmic one).
    for (const [query, levels, reversed] of [
      ['quality=high', ['high'], true],
      ['quality=medium', ['medium'], true],
      ['quality=low', ['low'], true],
      ['post=low', ['low'], true],
      ['post=off', ['low'], false],
      ['', ['medium', 'low'], true], // auto: starts on medium (a very slow machine drops to low in the first seconds)
    ]) {
      const label = `quality ${query || 'auto'}`;
      const problemsBefore = problems.length;
      const qpage = await openPage();
      await startGame(qpage, `m=${smallMission('d', 'r')}&debug=1${query ? `&${query}` : ''}`);
      await animationFrames(qpage, 8);
      const q = await qpage.evaluate(() => ({
        info: window.__perf ? window.__perf.quality() : null,
        reversed: window.__perf ? window.__perf.renderer.capabilities.reversedDepthBuffer : null,
        log: window.__perf ? window.__perf.renderer.capabilities.logarithmicDepthBuffer : null,
      }));
      check(q.info !== null && levels.includes(q.info.level), `${label}: the level is ${levels.join(' or ')} (${q.info && q.info.level})`);
      check(q.reversed === reversed && q.log === !reversed, `${label}: ${reversed ? 'reversed' : 'logarithmic'} depth buffer (reversed ${q.reversed}, logarithmic ${q.log})`);
      st = await gameState(qpage);
      check(st.render.calls > 20 && st.render.calls <= MAX_DRAW_CALLS, `${label}: ${st.render.calls} draw calls (within 20..${MAX_DRAW_CALLS})`);
      const qPng = await analyzePng(qpage, await shoot(qpage, { hideHud: true, path: join(OUT_DIR, `quality-${query.replace(/[^a-z]/g, '') || 'auto'}.png`) }));
      check(qPng.distinctAll >= 6, `${label}: the canvas is not blank (${qPng.distinctAll} distinct sampled colours)`);
      check(problems.length === problemsBefore, `${label}: no console errors${problems.length > problemsBefore ? `: ${problems.slice(problemsBefore).join(' | ')}` : ''}`);
      await qpage.close();
    }

    // 11. The start menu. First without ?debug=1: it shows, fits 1280x720, exposes no hook and starts the defaults.
    const plainMenu = await openPage();
    await plainMenu.goto(preview.url, { waitUntil: 'load' });
    await plainMenu.waitForSelector('.menu-start'); // built: only now does "no hook" mean something
    await imagesLoaded(plainMenu);
    check((await plainMenu.locator('.menu-start').count()) === 1, 'the start menu shows a Start button');
    check((await plainMenu.locator('.menu-random').count()) === 1, 'the start menu shows a Random mission button');
    check((await plainMenu.locator('.menu-card').count()) === 3, 'the start menu shows 3 theme cards');
    check((await plainMenu.evaluate(() => window.__menu)) === undefined, 'window.__menu is undefined without ?debug=1');
    check((await plainMenu.evaluate(() => window.__game)) === undefined, 'the start menu runs no game');
    const fit = await plainMenu.evaluate(() => ({ scroll: document.querySelector('.menu').scrollHeight, client: document.querySelector('.menu').clientHeight }));
    check(fit.scroll <= fit.client, `the menu fits 1280x720 without scrolling (${fit.scroll} <= ${fit.client})`);
    const defaults = await menuDom(plainMenu);
    log(`menu defaults: ${JSON.stringify(defaults)}`);
    check(
      defaults.theme === 'desert' && defaults.range === '600–1000 m' && defaults.soldiers === '3' && defaults.vehicleTargets === '0',
      'the menu opens with the defaults (desert, 600–1000 m, 3 soldiers, 0 vehicle targets)',
    );
    check(
      defaults.wind === '4.5 m/s · 10 mph' && defaults.clock === "from 9 o'clock (left)" && defaults.rifle === '308' &&
        defaults.buildings === 'few' && defaults.vehicles === 'few',
      'the menu opens with the defaults (4.5 m/s · 10 mph from 9 o\'clock, .308, few buildings, few vehicles)',
    );
    check(
      defaults.position === 'ridge' && defaults.suppressed === false && defaults.assists === false && defaults.snipers === '1 sniper' &&
        defaults.suppressedText === 'Off' && defaults.assistsText === 'Off',
      'the menu opens with ridge, suppressor off, 1 enemy sniper, aim assists off',
    );
    check(defaults.positionNote === 'Elevated ridge. A clear view into the valley below.', `the ridge description shows under the firing position (${defaults.positionNote})`);
    check(defaults.rifleArt === '308', 'the rifle panel shows the .308 concept art');
    const artDefault = await rifleArtCovers(plainMenu);
    check(artDefault.loaded && artDefault.covers && artDefault.zoomed, `the .308 art is a crop of the concept picture (${JSON.stringify(artDefault)})`);
    const menuPng = await plainMenu.screenshot({ path: join(OUT_DIR, 'menu.png') });
    const menuLook = await analyzePng(plainMenu, menuPng);
    check(menuLook.distinctAll >= 20, `the menu screenshot has content (${menuLook.distinctAll} distinct sampled colours)`);

    // Smaller than 1280x720 it scrolls instead of clipping: Start can still be reached.
    await plainMenu.setViewportSize({ width: 1280, height: 480 });
    const short = await plainMenu.evaluate(() => ({ scroll: document.querySelector('.menu').scrollHeight, client: document.querySelector('.menu').clientHeight }));
    check(short.scroll > short.client, `at 1280x480 the menu scrolls (${short.scroll} > ${short.client})`);
    await plainMenu.locator('.menu-start').scrollIntoViewIfNeeded();
    const startBox = await plainMenu.locator('.menu-start').boundingBox();
    check(startBox !== null && startBox.y >= 0 && startBox.y + startBox.height <= 480, 'at 1280x480 Start can be scrolled into view');
    await plainMenu.screenshot({ path: join(OUT_DIR, 'menu-short.png') });
    await plainMenu.setViewportSize(VIEWPORT);

    // Keyboard only: Enter on the focused Start button starts the default mission (no debug hook without ?debug=1).
    await plainMenu.locator('.menu-start').focus();
    await Promise.all([plainMenu.waitForURL(/\?m=v6\.[^&]+$/), plainMenu.keyboard.press('Enter')]);
    await plainMenu.waitForSelector('.hud');
    check(MISSION_DEFAULT_RE.test(missionCode(plainMenu) ?? ''), `Enter on Start runs the default mission (${missionCode(plainMenu)})`);
    const enterFrames = await animationFrames(plainMenu, 3);
    check(enterFrames.frames >= 3, 'the default mission runs');
    check((await plainMenu.locator('.hud-line', { hasText: 'Targets 4/4' }).count()) === 1, 'default mission: HUD says "Targets 4/4" (3 soldiers + 1 enemy sniper)');
    check((await plainMenu.locator('.threat-panel').count()) === 1, 'the default mission (1 enemy sniper) has a threat panel');
    check(
      (await plainMenu.locator('.hud-line', { hasText: "Wind 4.5 m/s from 9 o'clock (left)" }).count()) === 1,
      'default mission: HUD says "Wind 4.5 m/s from 9 o\'clock (left)"',
    );
    check((await plainMenu.evaluate(() => window.__game)) === undefined, 'a mission URL without ?debug=1 exposes no debug hook');
    const defaultPng = await analyzePng(plainMenu, await shoot(plainMenu, { hideHud: true, path: join(OUT_DIR, 'mission-default.png') }));
    check(defaultPng.distinctAll >= 6, `the default mission canvas is not one colour (${defaultPng.distinctAll} distinct sampled colours)`);
    await plainMenu.close();

    // The controls (with ?debug=1, which exposes window.__menu): Tab order, then every control by real input.
    const controls = await openPage();
    await controls.goto(`${preview.url}?debug=1`, { waitUntil: 'load' });
    await controls.waitForSelector('.menu-start');
    await imagesLoaded(controls);
    check((await controls.evaluate(() => typeof window.__menu?.get)) === 'function', 'window.__menu exists with ?debug=1');
    const tabbed = [];
    for (let i = 0; i < MENU_TAB_ORDER.length; i++) {
      await controls.keyboard.press('Tab');
      tabbed.push(
        await controls.evaluate(() => {
          const e = document.activeElement;
          return e.matches('input[type=radio], input[type=checkbox]') ? `${e.type}:${e.name}` : e.id || e.getAttribute('class');
        }),
      );
    }
    check(JSON.stringify(tabbed) === JSON.stringify(MENU_TAB_ORDER), `Tab visits the controls in reading order (${tabbed.join(' > ')})`);

    // Range band: min and max stay linked. Keyboard on the real sliders (End/Home).
    await controls.locator('#menu-range-min').focus();
    await controls.keyboard.press('End');
    let cfg = await menuConfig(controls);
    check(cfg.rangeMin === 1500 && cfg.rangeMax === 1500, 'moving min to the end pushes max along (1500–1500)');
    check((await controls.locator('#menu-range-value').textContent()) === '1500 m', 'the range label shows one distance when both ends are equal');
    await controls.locator('#menu-range-max').focus();
    await controls.keyboard.press('Home');
    cfg = await menuConfig(controls);
    check(cfg.rangeMin === 100 && cfg.rangeMax === 100, 'moving max to the start pushes min along (100–100)');
    await controls.keyboard.press('ArrowRight');
    await controls.keyboard.press('ArrowRight');
    cfg = await menuConfig(controls);
    check(cfg.rangeMin === 100 && cfg.rangeMax === 120, 'max moves in 10 m steps without touching min (100–120)');
    check((await controls.locator('#menu-range-value').textContent()) === '100–120 m', 'the range label reads 100–120 m');

    // Wind: the clock dial by mouse and keyboard, and the speed with its mph.
    await controls.locator('.menu-dial-pos[data-clock="3"]').click();
    cfg = await menuConfig(controls);
    check(cfg.windClock === 3, 'clicking 3 on the dial sets wind from 3 o\'clock');
    check((await controls.locator('#menu-dial-value').textContent()) === "from 3 o'clock (right)", 'the dial label reads "from 3 o\'clock (right)"');
    check((await controls.locator('.menu-dial-arrow').getAttribute('transform')) === 'rotate(90)', 'the wind arrow turns with the clock (3 o\'clock: 90 degrees)');
    await controls.keyboard.press('ArrowRight');
    check((await menuConfig(controls)).windClock === 4, 'ArrowRight on the dial moves one position clockwise');
    await controls.locator('#menu-wind-speed').focus();
    await controls.keyboard.press('End');
    check((await controls.locator('#menu-wind-speed-value').textContent()) === '12.0 m/s · 27 mph', 'the wind speed shows m/s and mph (12.0 m/s · 27 mph)');
    check((await menuConfig(controls)).windSpeedMps === 12, 'the speed slider reaches 12 m/s');

    // Counts, rifle, densities.
    await controls.locator('#menu-soldiers').focus();
    await controls.keyboard.press('End');
    await controls.locator('#menu-vehicle-targets').focus();
    await controls.keyboard.press('End');
    cfg = await menuConfig(controls);
    check(cfg.soldiers === 10 && cfg.vehicleTargets === 3, 'the sliders reach 10 soldiers and 3 vehicle targets');
    await controls.locator('label.menu-seg-option', { has: controls.locator('input[name=rifle][value="338"]') }).click();
    await controls.locator('label.menu-seg-option', { has: controls.locator('input[name=buildings][value=many]') }).click();
    await controls.locator('label.menu-seg-option', { has: controls.locator('input[name=vehicles][value=none]') }).click();
    cfg = await menuConfig(controls);
    check(cfg.rifle === '338' && cfg.buildings === 'many' && cfg.vehicles === 'none', 'the rifle toggle and the none/few/many controls work by mouse');
    await controls.screenshot({ path: join(OUT_DIR, 'menu-controls.png') });

    // __menu.set redraws the controls.
    await controls.evaluate(() =>
      window.__menu.set({ soldiers: 5, theme: 'valley', windSpeedMps: 0, position: 'mountain', suppressed: true, enemySnipers: 3, assists: true, camo: true }),
    );
    const afterSet = await menuDom(controls);
    check(afterSet.soldiers === '5' && afterSet.theme === 'valley' && afterSet.wind === '0.0 m/s · 0 mph', '__menu.set updates the controls');
    check(
      afterSet.position === 'mountain' && afterSet.suppressed === true && afterSet.snipers === '3 snipers' && afterSet.assists === true && afterSet.camo === true && afterSet.camoText === 'On',
      '__menu.set updates the new controls (mountain, suppressor on, 3 snipers, assists on, ghillie suit on)',
    );
    await controls.close();

    // The new controls, each by real input: the firing position, the enemy snipers slider, the suppressor and aim assists switches
    // and the rifle (whose concept art follows it). `__menu.get()` reflects every one, and Start carries them in the v6 mission code.
    const added = await openPage();
    await added.goto(`${preview.url}?debug=1`, { waitUntil: 'load' });
    await added.waitForSelector('.menu-start');
    await imagesLoaded(added);
    // Firing position: click an option, then the arrow keys move the native radio group.
    await clickSeg(added, 'position', 'mountain');
    check((await menuConfig(added)).position === 'mountain', 'clicking Mountain sets the firing position');
    check(
      (await menuDom(added)).positionNote === 'Steep rocky spur. A pronounced downhill shot into the basin.',
      'the mountain description shows under the firing position',
    );
    await added.keyboard.press('ArrowLeft');
    check((await menuConfig(added)).position === 'ridge', 'ArrowLeft on the firing position moves to Ridge');
    await clickSeg(added, 'position', 'valley');
    check((await menuConfig(added)).position === 'valley', 'clicking Valley sets the firing position');
    const valleyNote = (await menuDom(added)).positionNote ?? '';
    check(/near-level sightline/.test(valleyNote) && !/sand|wash|dune/i.test(valleyNote), `the valley description is theme-neutral (${valleyNote})`);
    // Enemy snipers: the real slider, by keyboard.
    await added.locator('#menu-snipers').focus();
    await added.keyboard.press('End');
    check((await menuConfig(added)).enemySnipers === 3, 'End on the enemy snipers slider gives 3');
    check((await added.locator('#menu-snipers-value').textContent()) === '3 snipers', 'the snipers value reads "3 snipers"');
    await added.keyboard.press('Home');
    check((await menuConfig(added)).enemySnipers === 0, 'Home on the enemy snipers slider gives 0 (training)');
    check((await added.locator('#menu-snipers-value').textContent()) === '0 · training', 'the snipers value reads "0 · training"');
    check(((await added.locator('.menu-slider-note').textContent()) ?? '').includes('0 = training, no incoming fire'), 'the slider explains "0 = training, no incoming fire"');
    await added.keyboard.press('ArrowRight');
    await added.keyboard.press('ArrowRight');
    check((await menuConfig(added)).enemySnipers === 2, 'two ArrowRights on the snipers slider give 2');
    // Suppressor and aim assists: click the switch, then Space on the focused checkbox.
    await clickSwitch(added, 'suppressed');
    check((await menuConfig(added)).suppressed === true && (await menuDom(added)).suppressedText === 'On', 'clicking the suppressor switch turns it on');
    await clickSwitch(added, 'suppressed');
    check((await menuConfig(added)).suppressed === false && (await menuDom(added)).suppressedText === 'Off', 'clicking it again turns it off');
    await added.locator('input[name=suppressed]').focus();
    await added.keyboard.press('Space');
    check((await menuConfig(added)).suppressed === true, 'Space on the focused suppressor checkbox turns it on');
    check(((await added.locator('label.menu-toggle', { has: added.locator('input[name=suppressed]') }).locator('xpath=..').textContent()) ?? '').includes('Reduced noise / flash'), 'the suppressor switch says "Reduced noise / flash"');
    // The ghillie suit switch: off by default, click, then Space on the focused checkbox.
    check((await menuConfig(added)).camo === false && (await menuDom(added)).camoText === 'Off', 'the ghillie suit switch starts off');
    await clickSwitch(added, 'camo');
    check((await menuConfig(added)).camo === true && (await menuDom(added)).camoText === 'On', 'clicking the ghillie suit switch turns it on');
    check(((await added.locator('label.menu-toggle', { has: added.locator('input[name=camo]') }).locator('xpath=..').textContent()) ?? '').includes('Hard to spot until you fire'), 'the ghillie suit switch says what it does');
    await added.locator('input[name=camo]').focus();
    await added.keyboard.press('Space');
    check((await menuConfig(added)).camo === false, 'Space on the focused ghillie suit checkbox turns it off');
    await clickSwitch(added, 'camo');
    await clickSwitch(added, 'assists');
    check((await menuConfig(added)).assists === true && (await menuDom(added)).assistsText === 'On', 'clicking the aim assists switch turns it on');
    check(((await added.locator('label.menu-toggle', { has: added.locator('input[name=assists]') }).locator('xpath=..').textContent()) ?? '').includes('Trajectory, aim marker and spotter'), 'the aim assists switch says what it gives');
    // The rifle art follows the rifle.
    await clickSeg(added, 'rifle', '338');
    check((await menuDom(added)).rifleArt === '338', 'choosing the .338 shows the .338 concept art');
    const art338 = await rifleArtCovers(added);
    check(art338.loaded && art338.covers && art338.zoomed, `the .338 art is a crop of the concept picture (${JSON.stringify(art338)})`);
    const artBox = await added.locator('.menu-rifle-art').boundingBox();
    await clickSeg(added, 'rifle', '308');
    check(Math.abs(((await added.locator('.menu-rifle-art').boundingBox())?.height ?? 0) - artBox.height) < 0.5, 'the art box keeps its height when the rifle changes');
    await clickSeg(added, 'rifle', '338');
    // The longest texts everywhere (3 snipers, valley note, the longest direction label) still fit 1280x720 without scrolling.
    await added.locator('#menu-snipers').focus();
    await added.keyboard.press('End');
    await added.evaluate(() => window.__menu.set({ windClock: 10, position: 'mountain' }));
    const worstFit = await menuFits(added);
    check(worstFit.scroll <= worstFit.client, `the menu still fits 1280x720 with the longest texts (${worstFit.scroll} <= ${worstFit.client})`);
    await clickSeg(added, 'position', 'valley');
    await added.evaluate(() => window.__menu.set({ windClock: 9, enemySnipers: 2 }));
    await added.waitForTimeout(450);
    await added.screenshot({ path: join(OUT_DIR, 'menu-new-controls.png') });
    // Start: the mission URL's v6 code carries valley, suppressed, 2 snipers, assists, ghillie suit and fight back (fields 12..17 after the version).
    await clickStart(added, { debug: true });
    const addedCode = (missionCode(added) ?? '').split('.');
    check(
      addedCode[0] === 'v6' && addedCode[17] === '1' && addedCode[8] === '338' && addedCode[12] === 'v' && addedCode[13] === '1' && addedCode[14] === '2' && addedCode[15] === '1' && addedCode[16] === '1',
      `Start puts the new controls in the v6 mission code (${addedCode.join('.')})`,
    );
    await animationFrames(added, 3);
    check((await gameState(added)).targetsLeft >= 1, 'the mission started from the new controls runs');
    await added.waitForLoadState('networkidle');
    // And the code reads back into the menu: the way back (?last=) pre-fills the new controls too.
    await added.goto(`${preview.url}?last=${addedCode.join('.')}&debug=1`, { waitUntil: 'load' });
    await added.waitForSelector('.menu-start');
    await imagesLoaded(added);
    const addedBack = await menuConfig(added);
    check(
      addedBack.position === 'valley' && addedBack.suppressed === true && addedBack.enemySnipers === 2 && addedBack.assists === true && addedBack.camo === true && addedBack.rifle === '338',
      `coming back to the menu pre-fills the new controls (${addedBack.position}, suppressed ${addedBack.suppressed}, ${addedBack.enemySnipers} snipers, assists ${addedBack.assists}, ghillie ${addedBack.camo})`,
    );
    const addedDom = await menuDom(added);
    check(
      addedDom.position === 'valley' && addedDom.suppressed === true && addedDom.assists === true && addedDom.snipers === '2 snipers' && addedDom.rifleArt === '338',
      'the pre-filled menu shows them: Valley, suppressor On, 2 snipers, assists On, .338 art',
    );
    await added.close();

    // Each theme: click its card (the background follows), set counts, press the real Start button.
    for (const [i, theme] of ['desert', 'arctic', 'valley'].entries()) {
      const themed = await openPage();
      await themed.goto(`${preview.url}?debug=1`, { waitUntil: 'load' });
      await themed.waitForSelector('.menu-start');
      await imagesLoaded(themed);
      await themed.locator(`.menu-card[data-theme=${theme}]`).click();
      // No enemy snipers here: this loop counts the soldiers and vehicle targets, and snipers are targets of their own.
      await themed.evaluate(([soldiers, vehicleTargets]) => window.__menu.set({ soldiers, vehicleTargets, enemySnipers: 0 }), [2 + i, i]);
      cfg = await menuConfig(themed);
      check(cfg.theme === theme, `clicking the ${theme} card selects it`);
      await themed.waitForTimeout(450); // the background cross-fade
      const activeBackground = await themed.evaluate(() => document.querySelector('.menu-bg-img.is-active')?.getAttribute('src'));
      check(activeBackground?.includes(`card_${theme}`) === true, `the ${theme} card is the menu background (${activeBackground})`);
      await themed.screenshot({ path: join(OUT_DIR, `menu-${theme}.png`) });

      await clickStart(themed, { debug: true });
      check(THEME_NAMES[(missionCode(themed) ?? '').split('.')[1]] === theme, `Start opens a ${theme} mission (${missionCode(themed)})`);
      st = await gameState(themed);
      check(
        st.targetsLeft === cfg.soldiers + cfg.vehicleTargets + cfg.enemySnipers && st.soldiers.length === cfg.soldiers && st.vehicles.length === cfg.vehicleTargets && st.snipers.length === cfg.enemySnipers,
        `the ${theme} mission has the menu's targets (${cfg.soldiers} soldiers + ${cfg.vehicleTargets} vehicle targets + ${cfg.enemySnipers} enemy snipers = ${st.targetsLeft})`,
      );
      await animationFrames(themed, 5);
      const themedLook = await analyzePng(themed, await shoot(themed, { hideHud: true, path: join(OUT_DIR, `menu-${theme}-mission.png`) }));
      check(themedLook.distinctAll >= 6, `the ${theme} mission from the menu is not one colour (${themedLook.distinctAll} distinct sampled colours)`);
      await themed.close();
    }

    // Random mission: it fills every control; Start runs it; coming back pre-fills the menu with it (any off-grid values included).
    const random = await openPage();
    await random.goto(`${preview.url}?debug=1`, { waitUntil: 'load' });
    await random.waitForSelector('.menu-start');
    await imagesLoaded(random);
    await random.locator('.menu-random').click();
    const rollA = await menuConfig(random);
    await random.locator('.menu-random').click();
    let second = await menuConfig(random);
    check(JSON.stringify(rollA) !== JSON.stringify(second), 'two Random clicks give different missions');
    log(`random mission: ${JSON.stringify(second)}`);
    const shown = await menuDom(random);
    check(
      shown.theme === second.theme && shown.soldiers === String(second.soldiers) && shown.rifle === second.rifle &&
        shown.buildings === second.buildings && shown.vehicles === second.vehicles,
      'Random mission redraws the controls with the new settings',
    );
    check(
      shown.position === second.position && shown.suppressed === second.suppressed && shown.assists === second.assists &&
        shown.snipers === (second.enemySnipers === 0 ? '0 · training' : second.enemySnipers === 1 ? '1 sniper' : `${second.enemySnipers} snipers`) &&
        shown.rifleArt === second.rifle,
      'Random mission redraws the new controls too (position, suppressor, snipers, assists, rifle art)',
    );
    // Over many rolls Random reaches every kind of value of the new controls.
    const rolls = [];
    for (let i = 0; i < 24; i++) {
      await random.locator('.menu-random').click();
      rolls.push(await menuConfig(random));
    }
    check(new Set(rolls.map((r) => r.position)).size === 3, 'Random mission rolls every firing position');
    check(new Set(rolls.map((r) => r.enemySnipers)).size >= 3, 'Random mission rolls different enemy sniper counts');
    check(new Set(rolls.map((r) => r.suppressed)).size === 2 && new Set(rolls.map((r) => r.assists)).size === 2 && new Set(rolls.map((r) => r.camo)).size === 2, 'Random mission rolls the suppressor, aim assists and ghillie suit on and off');
    await random.locator('.menu-random').click();
    // The mission started below is this last roll, with its snipers pinned to 0, the objective to clearing the area and no base: it counts soldiers
    // and vehicle targets, and snipers (and an HVT with his bodyguards, and a base's guards) are targets of their own.
    await random.evaluate(() => window.__menu.set({ enemySnipers: 0, objective: 'clear', base: 'none' }));
    second = await menuConfig(random);
    await clickStart(random, { debug: true });
    st = await gameState(random);
    check(st.targetsLeft === second.soldiers + second.vehicleTargets + second.enemySnipers, `the random mission has the menu's targets (${st.targetsLeft})`);
    await animationFrames(random, 5);
    const randomLook = await analyzePng(random, await shoot(random, { hideHud: true, path: join(OUT_DIR, 'mission.png') }));
    check(randomLook.distinctAll >= 6, `the random mission canvas is not one colour (${randomLook.distinctAll} distinct sampled colours)`);

    const code = missionCode(random);
    const seed = Number(code.split('.')[11]); // the seed is the eleventh field after the version
    check(Number.isInteger(seed) && seed >= 1 && seed <= 0xffffffff, `Start put a fresh 32-bit seed in the URL (${seed})`);
    await random.goto(`${preview.url}?last=${code}&debug=1`, { waitUntil: 'load' });
    await random.waitForSelector('.menu-start');
    await imagesLoaded(random);
    const back = await menuConfig(random);
    const { seed: backSeed, ...backRest } = back;
    const { seed: wasSeed, ...secondRest } = second;
    check(backSeed === seed, 'the menu coming back from a mission carries that mission\'s seed');
    check(wasSeed !== undefined && JSON.stringify(backRest) === JSON.stringify(secondRest), 'coming back from a random mission pre-fills the menu with exactly its settings');
    await random.close();

    // 12. Leaving a mission does not lose the settings. (Each page waits for its sound files before it leaves: navigating away
    // sooner aborts them, which would count as failed requests.)
    // 12a. The browser's Back button: Start rewrites the menu's own history entry to ?last=<settings>.
    const custom = { theme: 'arctic', rangeMin: 400, rangeMax: 800, soldiers: 4, vehicleTargets: 1, windSpeedMps: 7.5, windClock: 3, rifle: '338', buildings: 'many', vehicles: 'none', enemySnipers: 0 };
    const backPage = await openPage();
    await backPage.goto(`${preview.url}?debug=1`, { waitUntil: 'load' });
    await backPage.waitForSelector('.menu-start');
    await imagesLoaded(backPage);
    await backPage.evaluate((c) => window.__menu.set(c), custom);
    const { seed: _s1, ...setBefore } = await menuConfig(backPage);
    check(Object.entries(custom).every(([k, v]) => setBefore[k] === v), 'the menu holds the non-default settings before Start');
    await clickStart(backPage, { debug: true });
    st = await gameState(backPage);
    check(st.targetsLeft === 5 && st.vehicles.length === 1 && st.snipers.length === 0, 'the mission started with those settings (4 soldiers + 1 vehicle target, 0 enemy snipers)');
    await backPage.waitForLoadState('networkidle');
    await backPage.goBack({ waitUntil: 'load' });
    await backPage.waitForSelector('.menu-start');
    await imagesLoaded(backPage);
    check(/\?last=v6\.a\.400\.800\.4\.1\.75\.3\.338\.m\.n\.\d+\.r\.0\.0\.0\.0\.1\.c\.n&debug=1$/.test(backPage.url()), `Back from the mission lands on ?last= with the settings (${new URL(backPage.url()).search})`);
    const { seed: _s2, ...setAfter } = await menuConfig(backPage);
    check(JSON.stringify(setAfter) === JSON.stringify(setBefore), 'Back from the mission: the menu is pre-filled with the settings it started with');
    const afterDom = await menuDom(backPage);
    check(afterDom.theme === 'arctic' && afterDom.range === '400–800 m' && afterDom.soldiers === '4' && afterDom.rifle === '338', 'Back from the mission: the controls show them too');
    await backPage.screenshot({ path: join(OUT_DIR, 'menu-back.png') });
    await backPage.close();

    // The same without ?debug=1: pick a theme card, Start, Back; the URL carries no debug flag.
    const backPlain = await openPage();
    await backPlain.goto(preview.url, { waitUntil: 'load' });
    await backPlain.waitForSelector('.menu-start');
    await imagesLoaded(backPlain);
    await backPlain.locator('.menu-card[data-theme=valley]').click();
    await clickStart(backPlain, { debug: false });
    await backPlain.waitForLoadState('networkidle');
    await backPlain.goBack({ waitUntil: 'load' });
    await backPlain.waitForSelector('.menu-start');
    await imagesLoaded(backPlain);
    check(/\?last=v6\.v\.[^&]+$/.test(backPlain.url()), `Back (no debug): ?last= with the valley mission, no debug=1 (${new URL(backPlain.url()).search})`);
    check((await menuDom(backPlain)).theme === 'valley', 'Back (no debug): the menu shows the valley theme the player had picked');
    await backPlain.close();

    // 12b. The HUD's Menu link (shown while the mouse is free): pre-filled menu, debug=1 kept.
    const hudPage = await openPage();
    await startGame(hudPage, `m=${MISSION_MENU_LINK}&debug=1`);
    await hudPage.waitForSelector('.hud-menu');
    check(await hudPage.locator('.hud-menu').isVisible(), 'the HUD shows a Menu link while the pointer is free');
    check((await hudPage.locator('.hud-menu').textContent()) === 'Menu', 'the HUD link reads "Menu"');
    const hudLook = await hudPage.evaluate(() => {
      const c = getComputedStyle(document.querySelector('.hud-panel'));
      return { edge: c.borderLeftWidth, edgeColor: c.borderLeftColor, glass: c.backgroundImage.startsWith('linear-gradient'), lines: document.querySelectorAll('.hud-panel .hud-line').length };
    });
    check(hudLook.edge === '3px' && hudLook.glass && hudLook.lines >= 6, `the HUD panel has the slate-glass look with a brass edge and keeps its six lines (${JSON.stringify(hudLook)})`);
    check((await hudPage.locator('.hud-menu').getAttribute('href')) === `/?last=${asV3(MISSION_MENU_LINK)}&debug=1`, 'the HUD Menu link points at the menu with this mission and debug=1');
    await hudPage.screenshot({ path: join(OUT_DIR, 'hud-menu.png') });
    await hudPage.evaluate(() => window.__game.toggleScope()); // the link must not sit over the scope lens
    await animationFrames(hudPage, 3);
    const linkBox = await hudPage.locator('.hud-menu').boundingBox();
    const scopedLens = await hudPage.locator('.scope-lens').boundingBox();
    check(linkBox !== null && scopedLens !== null && linkBox.y >= scopedLens.y + scopedLens.height, 'the Menu link is below the scope lens');
    await hudPage.screenshot({ path: join(OUT_DIR, 'hud-menu-scope.png') });
    await hudPage.waitForLoadState('networkidle');
    await Promise.all([hudPage.waitForURL(new RegExp(`\\?last=${asV3(MISSION_MENU_LINK).replaceAll('.', '\\.')}&debug=1$`)), hudPage.locator('.hud-menu').click()]);
    await hudPage.waitForSelector('.menu-start');
    await imagesLoaded(hudPage);
    const linked = await menuConfig(hudPage);
    check(
      linked.theme === 'desert' && linked.rangeMin === 300 && linked.rangeMax === 300 && linked.soldiers === 2 && linked.vehicleTargets === 0 && linked.rifle === '308' &&
        linked.windSpeedMps === 2 && linked.windClock === 6 && linked.buildings === 'none' && linked.vehicles === 'none' && linked.seed === 7,
      `the HUD Menu link opens the menu pre-filled with the mission (${JSON.stringify(linked)})`,
    );
    check((await hudPage.evaluate(() => window.__game)) === undefined, 'the menu from the HUD link runs no game');
    await hudPage.close();

    // 12c. Enemy snipers (spec B.4): 1 soldier + 2 snipers on rooftops. Glints, detection, incoming fire, cover, kills, results.
    const fight = await openPage();
    await startGame(fight, `m=${MISSION_SNIPERS}&debug=1`);
    await fight.evaluate(() => window.__game.unlockAudio());
    st = await gameState(fight);
    check(st.snipers.length === 2 && st.snipersLeft === 2 && st.soldiers.length === 1, 'the sniper mission has 1 soldier and 2 enemy snipers');
    // The two cheats are part of the hook with ?debug=1 (a plain page has no hook at all, a dev server's plain URL has the hook without them).
    check(
      (await fight.evaluate(() => [typeof window.__game.setDetection, typeof window.__game.setHealth])).join() === 'function,function',
      'with ?debug=1 the hook has the setDetection and setHealth cheats',
    );
    // The hint lists C (cover) because there are snipers, and no T/A/P because the assists are off; on one line.
    const fightHint = (await fight.locator('.hud-hint').textContent()) ?? '';
    check(/ C cover/.test(fightHint) && !/T\/A\/P/.test(fightHint), `the hint of a sniper mission lists C (cover) but not T/A/P (${fightHint})`);
    check((await fight.locator('.hud-hint').boundingBox()).height < 24, 'the hint is a single line');
    check(st.targetsLeft === 3, 'the snipers are targets: 3 targets standing');
    check((await fight.locator('.hud-line', { hasText: 'Targets 3/3' }).count()) === 1, 'HUD says "Targets 3/3"');
    // The hides are chosen by score (src/mission/hide.ts) and a roof is not automatic, but seed 2 of this band gives two roofs.
    check(st.snipers.every((k) => k.site === 'roof'), `both snipers lie on rooftops (${st.snipers.map((k) => k.site).join(', ')})`);
    check(st.health === 100 && st.detection === 0 && !st.covered, 'the fight starts at full health, undetected, exposed');
    await animationFrames(fight, 5);
    check((await fight.locator('.threat-panel').count()) === 1, 'the threat panel exists');
    const searching = (await fight.locator('.threat-panel').textContent()) ?? '';
    check(/EXPOSED/.test(searching) && /Health 100/.test(searching) && /2 snipers left/.test(searching) && /Enemy unaware( · PAUSED)?$/.test(searching), `the threat line reads "${searching}" (nothing has given the player away: the enemy is unaware)`);
    check(st.awareness === 'unaware', `the debug state reads awareness "${st.awareness}" at the start`);
    check(/PAUSED/.test(searching), 'the threat line says PAUSED while the pointer is free');
    st = await gameState(fight);
    check(st.snipers.some((k) => k.glint), 'a sniper scope glint is on screen (the scope sweeps toward the player)');
    // The aim points are where the bodies are: every sniper sits on a roof, so well above the ground.
    check(st.snipers.every((k) => k.head.y > 3), 'the snipers lie on roofs (head 3+ m up)');
    // Frozen while the pointer is free: nothing happens to the health even with the detection forced up.
    await fight.evaluate(() => window.__game.setDetection(100));
    await waitGameSeconds(fight, 5);
    check((await gameState(fight)).health === 100, 'paused (pointer free): a 100 % detection does nothing');
    // The real pointer lock (a click on the canvas) starts the clock.
    await fight.mouse.click(640, 360);
    await fight.waitForFunction(() => document.pointerLockElement !== null, undefined, { timeout: 5000 });
    check(true, 'a click locks the pointer');
    // Look at the nearer sniper through the scope at full zoom (25x), detected (steady glint), for the close-up screenshot.
    const nearSniper = [...st.snipers].sort((a, b) => Math.hypot(a.head.x, a.head.z) - Math.hypot(b.head.x, b.head.z))[0];
    await fight.evaluate(([x, y, z]) => {
      window.__game.setDetection(70);
      window.__game.toggleScope();
      for (let i = 0; i < 6; i++) window.__game.zoom(-1);
      window.__game.aimAt(x, y - 0.1, z);
    }, [nearSniper.head.x, nearSniper.head.y, nearSniper.head.z]);
    await animationFrames(fight, 8);
    check((await gameState(fight)).snipers.find((k) => k.id === nearSniper.id).glint, 'the nearer sniper\'s glint is on in the scope');
    await fight.screenshot({ path: join(OUT_DIR, 'snipers-scoped.png') });
    await fight.evaluate(() => window.__game.toggleScope());

    // Detected: the snipers fire. Health drops while exposed.
    await fight.evaluate(() => window.__game.setDetection(100));
    await animationFrames(fight, 3);
    const firing = (await fight.locator('.threat-panel').textContent()) ?? '';
    check(/SNIPER FIRING IN \d\.\d s/.test(firing) || /INCOMING BOMBARDMENT/.test(firing), `at 100 % detection the threat line counts down ("${firing}")`);
    check(!/PAUSED/.test(firing), 'the threat line is not paused once the pointer is locked');
    st = await gameState(fight);
    check(st.snipers.every((k) => k.glint), 'detected: the glints are steady (on for every sniper)');
    await fight.waitForFunction(() => window.__game.state().health < 100, undefined, { timeout: RESULT_TIMEOUT_MS });
    st = await gameState(fight);
    log(`exposed at 100 % detection: health ${st.health}`);
    check(st.health <= 82, `an exposed player is hit: -18 per sniper shot, -45 per bombardment (health ${st.health})`);
    await fight.screenshot({ path: join(OUT_DIR, 'snipers-hit.png') });

    // Cover (C): drops the scope, blocks firing, shows the cover mask; sniper fire no longer hurts.
    await fight.evaluate(() => window.__game.toggleScope());
    check((await fight.locator('.scope-overlay').isVisible()) === true, 'the scope is up before ducking');
    await fight.keyboard.press('KeyC');
    st = await gameState(fight);
    check(st.covered === true, 'C ducks into cover');
    check((await fight.locator('.scope-overlay').isVisible()) === false, 'ducking drops the scope');
    check((await fight.locator('.cover-mask').isVisible()) === true, 'the cover mask is shown');
    const shotsBefore = st.stats.shots;
    await fight.evaluate(() => {
      window.__game.fire();
      window.__game.toggleScope(); // right click is ignored in cover too
    });
    st = await gameState(fight);
    check(st.stats.shots === shotsBefore, 'no shooting from behind cover');
    check((await fight.locator('.scope-overlay').isVisible()) === false, 'no scope from behind cover');
    await fight.screenshot({ path: join(OUT_DIR, 'snipers-cover.png') });
    const healthInCover = st.health;
    // Keep the detection pinned at 100 %, as a player who keeps shooting would: the snipers keep firing, at the cover,
    // and a bombardment is called (12 s of detection in all, a 4 s warning): it still costs 5 in cover, nothing else does.
    await fight.evaluate(() => {
      window.__pin = setInterval(() => window.__game.setDetection(100), 50);
    });
    await fight.waitForFunction(() => /INCOMING BOMBARDMENT \d\.\d s — C: COVER/.test(document.querySelector('.threat-panel')?.textContent ?? ''), undefined, {
      timeout: RESULT_TIMEOUT_MS,
    });
    check(true, `a bombardment is announced with its countdown ("${await fight.locator('.threat-panel').textContent()}")`);
    check(((await fight.locator('.threat-panel').textContent()) ?? '').startsWith('IN COVER'), 'the warning shows while IN COVER');
    await fight.screenshot({ path: join(OUT_DIR, 'snipers-bombardment.png') });
    check((await gameState(fight)).health === healthInCover, 'sniper fire at a player in cover cost nothing so far');
    await fight.waitForFunction((was) => window.__game.state().health < was, healthInCover, { timeout: RESULT_TIMEOUT_MS });
    await fight.evaluate(() => clearInterval(window.__pin));
    st = await gameState(fight);
    log(`bombardment in cover: health ${healthInCover} -> ${st.health}`);
    check(healthInCover - st.health === 5, `the bombardment costs 5 in cover (health ${healthInCover} -> ${st.health})`);
    await fight.keyboard.press('KeyC');
    check((await gameState(fight)).covered === false && (await fight.locator('.cover-mask').isVisible()) === false, 'C again comes back up');

    // Kill everything. Health is topped up and the detection reset so the kills are not a race against the snipers.
    await fight.evaluate(() => {
      window.__game.setHealth(100);
      window.__game.setDetection(0);
    });
    st = await gameState(fight);
    const byRange = [...st.snipers].sort((a, b) => Math.hypot(a.head.x, a.head.z) - Math.hypot(b.head.x, b.head.z));
    for (const [n, sniper] of byRange.entries()) {
      const range = Math.hypot(sniper.upperTorso.x, sniper.upperTorso.z);
      const result = await shootAt(fight, sniper.upperTorso, holdFor(range));
      log(`sniper ${sniper.id} at ${range.toFixed(0)} m: "${result}"`);
      check(/^SNIPER DOWN/.test(result), `a shot at the upper torso of ${sniper.id} (${range.toFixed(0)} m) takes him out`);
      await waitForTargetsLeft(fight, 2 - n);
      st = await gameState(fight);
      check(st.snipersLeft === 1 - n, `${1 - n} enemy sniper(s) left`);
      check(st.snipers.find((k) => k.id === sniper.id).down && !st.snipers.find((k) => k.id === sniper.id).glint, 'the downed sniper has no glint');
      await waitGameSeconds(fight, BOLT_GAME_S);
    }
    await animationFrames(fight, 3);
    const cleared = (await fight.locator('.threat-panel').textContent()) ?? '';
    check(/ALL SNIPERS DOWN/.test(cleared), `with both snipers down the threat line says so ("${cleared}")`);
    check(st.complete === false, 'the soldier is still up: the mission is not complete yet');
    const soldier = st.soldiers[0];
    const soldierRange = Math.hypot(soldier.upperTorso.x, soldier.upperTorso.z);
    const soldierResult = await shootAt(fight, soldier.upperTorso, holdFor(soldierRange));
    check(/^HIT/.test(soldierResult), 'the soldier is hit');
    await fight.waitForSelector('.results', { timeout: RESULT_TIMEOUT_MS });
    st = await gameState(fight);
    check(st.complete && st.targetsLeft === 0 && !st.stats.failed, 'all targets down (soldier and both snipers): the mission is complete');
    check(((await fight.locator('.results-title').textContent()) ?? '') === 'Mission complete', 'the results say "Mission complete"');
    const sniperRows = await resultsRows(fight);
    check(sniperRows['Shots fired'] === '3' && sniperRows['Hits'] === '3', `results: 3 shots, 3 hits (${JSON.stringify(sniperRows)})`);
    await fight.screenshot({ path: join(OUT_DIR, 'snipers-complete.png') });
    await fight.close();

    // The last target is a sniper: the soldier first, then him. The threat line over the results must say the threat is over
    // (the mission completes in the tick of the kill, which pauses the fight): no "PAUSED", no frozen countdown.
    const lastSniper = await openPage();
    await startGame(lastSniper, `m=${MISSION_SNIPER_ONE}&debug=1`);
    await lastSniper.evaluate(() => window.__game.unlockAudio());
    await lastSniper.mouse.click(640, 360);
    await lastSniper.waitForFunction(() => document.pointerLockElement !== null, undefined, { timeout: 5000 });
    st = await gameState(lastSniper);
    const lastSoldier = st.soldiers[0];
    const lastOne = st.snipers[0];
    const soldierFirst = await shootAt(lastSniper, lastSoldier.upperTorso, holdFor(Math.hypot(lastSoldier.upperTorso.x, lastSoldier.upperTorso.z)));
    check(/^HIT/.test(soldierFirst), 'the soldier is hit first');
    await waitForTargetsLeft(lastSniper, 1);
    await waitGameSeconds(lastSniper, BOLT_GAME_S);
    await lastSniper.evaluate(() => window.__game.setDetection(60)); // a little noise, below the firing threshold
    const sniperLast = await shootAt(lastSniper, lastOne.upperTorso, holdFor(Math.hypot(lastOne.upperTorso.x, lastOne.upperTorso.z)));
    check(/^SNIPER DOWN/.test(sniperLast), 'the sniper is the last target and goes down');
    await lastSniper.waitForSelector('.results', { timeout: RESULT_TIMEOUT_MS });
    st = await gameState(lastSniper);
    check(st.complete && !st.stats.failed, 'the mission is complete');
    check(((await lastSniper.locator('.results-title').textContent()) ?? '') === 'Mission complete', 'the results say "Mission complete"');
    const overResults = (await lastSniper.locator('.threat-panel').textContent()) ?? '';
    check(/ALL SNIPERS DOWN/.test(overResults) && !/PAUSED|FIRING IN|BOMBARDMENT/.test(overResults), `the threat line over the results says the threat is over ("${overResults}")`);
    await lastSniper.screenshot({ path: join(OUT_DIR, 'snipers-last-target.png') });
    await lastSniper.close();

    // Mission failed: one sniper, little health, full detection: the first shot kills.
    const failing = await openPage();
    await startGame(failing, `m=${MISSION_SNIPER_ONE}&debug=1`);
    await failing.evaluate(() => window.__game.unlockAudio());
    await failing.mouse.click(640, 360);
    await failing.waitForFunction(() => document.pointerLockElement !== null, undefined, { timeout: 5000 });
    await failing.evaluate(() => {
      window.__game.setHealth(10);
      window.__game.setDetection(100);
    });
    await failing.waitForSelector('.results', { timeout: RESULT_TIMEOUT_MS });
    st = await gameState(failing);
    check(st.health === 0 && st.stats.failed && !st.complete && st.resultsShown, 'killed: the mission is failed, not complete, and the results are up');
    check(((await failing.locator('.results-title').textContent()) ?? '') === 'Mission failed', 'the results say "Mission failed"');
    check(/0 of 2 targets down/.test((await failing.locator('.results-summary').textContent()) ?? ''), 'the failed results say how many targets were down');
    const failedRows = await resultsRows(failing);
    check(failedRows['Shots fired'] === '0' && /^\d\d:\d\d$/.test(failedRows['Mission time'] ?? ''), `the failed results still show the stats (${JSON.stringify(failedRows)})`);
    check((await failing.locator('.threat-panel').textContent()) === 'MISSION FAILED · you were killed', 'the threat line says MISSION FAILED');
    const failedShots = st.stats.shots;
    await failing.evaluate(() => window.__game.fire());
    check((await gameState(failing)).stats.shots === failedShots, 'no shooting once the mission is failed');
    check((await failing.locator('.results-button').count()) === 2, 'failed results: Restart and Menu buttons');
    await failing.screenshot({ path: join(OUT_DIR, 'snipers-failed.png') });
    await failing.close();

    // The largest mission with 3 enemy snipers stays inside the draw-call budget.
    const bigFight = await openPage();
    await startGame(bigFight, `m=${MISSION_MAX_SNIPERS}&debug=1`);
    await animationFrames(bigFight, 5);
    st = await gameState(bigFight);
    check(st.targetsLeft === 16 && st.snipers.length === 3, 'the largest mission with 3 enemy snipers has 16 targets');
    log(`largest mission with 3 snipers: ${st.render.calls} draw calls, ${st.render.triangles} triangles`);
    check(st.render.calls <= MAX_DRAW_CALLS, `with 3 enemy snipers it stays within the draw-call budget (${st.render.calls} <= ${MAX_DRAW_CALLS})`);
    await bigFight.close();

    // 12c2. The ghillie suit (a v3 link): the threat line says so, a still player stays unaware however long he is exposed, and the
    // first shot gives him away (the muzzle report; the bullet's path adds more near a sniper): the snipers start searching.
    const ghillie = await openPage();
    await startGame(ghillie, `m=${MISSION_GHILLIE}&debug=1`);
    await ghillie.evaluate(() => window.__game.unlockAudio());
    await ghillie.mouse.click(640, 360);
    await ghillie.waitForFunction(() => document.pointerLockElement !== null, undefined, { timeout: 5000 });
    st = await gameState(ghillie);
    check(st.snipers.length === 1 && st.soldiers.length === 1 && st.awareness === 'unaware', 'the ghillie mission starts with the enemy unaware');
    await animationFrames(ghillie, 3);
    const hidden = (await ghillie.locator('.threat-panel').textContent()) ?? '';
    check(/Enemy unaware · ghillie suit( · PAUSED)?$/.test(hidden), `the threat line mentions the ghillie suit ("${hidden}")`);
    await waitGameSeconds(ghillie, 4);
    st = await gameState(ghillie);
    check(st.awareness === 'unaware' && st.detection > 0 && st.detection <= 30 && st.health === 100, `exposed and still: detection ${st.detection.toFixed(1)} % (30 % at most), still unaware, no damage`);
    await ghillie.screenshot({ path: join(OUT_DIR, 'ghillie-unaware.png') });
    const target = st.soldiers[0];
    const ghillieShot = await shootAt(ghillie, target.upperTorso, holdFor(Math.hypot(target.upperTorso.x, target.upperTorso.z)));
    check(/^HIT/.test(ghillieShot), 'the soldier is hit from the ghillie suit');
    // The report reaches the sniper only after its trip through the air (game/hearing.ts): his distance at the speed of sound, and a little more.
    const sniperHead = st.snipers[0].head;
    await waitGameSeconds(ghillie, Math.hypot(sniperHead.x, sniperHead.y, sniperHead.z) / 340 + 0.3);
    st = await gameState(ghillie);
    check(st.awareness === 'searching' || st.awareness === 'firing', `the shot gave him away: awareness "${st.awareness}"`);
    check(st.detection >= 28, `the muzzle report and the bullet raised the detection (${st.detection.toFixed(1)} %, 28 % of the report alone)`);
    if (st.awareness === 'searching') {
      const searchingGhillie = (await ghillie.locator('.threat-panel').textContent()) ?? '';
      check(/Enemy searching for you · C: cover( · PAUSED)?$/.test(searchingGhillie), `the threat line says the enemy is searching ("${searchingGhillie}")`);
    }
    await ghillie.close();

    // 12c3. The bullet cue, end to end (run.ts watch points -> BulletSystem closest pass -> Combat.onBulletEnd -> Encounter.bulletCue): a
    // suppressed shot is quiet (9 %, and nothing at all from a sniper more than 200 m off: game/hearing.ts), but a bullet that ends within a
    // few metres of a sniper is not: its crack and dust point back at the shooter (+25 % at 5 m or less). The pointer stays free, so the fight
    // is paused and only the shots move the detection.
    const cue = await openPage();
    await startGame(cue, `m=${MISSION_BULLET_CUE}&debug=1`);
    st = await gameState(cue);
    check(st.snipers.length === 1 && st.detection === 0 && st.awareness === 'unaware', 'the bullet cue mission starts undetected, the enemy unaware');
    const cueSniper = st.snipers[0];
    const cueRange = Math.hypot(cueSniper.head.x, cueSniper.head.z);
    const cueResult = await shootAt(cue, { x: cueSniper.head.x, y: cueSniper.head.y + 1.5, z: cueSniper.head.z }, holdFor(cueRange));
    check(/^MISS|^Hit cover/.test(cueResult), `a shot 1.5 m over the sniper's head passes him by ("${cueResult}")`);
    // Long enough for the report to have reached him, were it heard.
    await waitGameSeconds(cue, cueRange / 340 + 0.3);
    st = await gameState(cue);
    const cueExpected = cueRange <= 200 ? 34 : 25;
    check(
      st.snipersLeft === 1 && Math.abs(st.detection - cueExpected) < 1.5 && st.awareness === 'searching',
      `the suppressed shot (${cueRange <= 200 ? '9 %' : 'unheard at ' + Math.round(cueRange) + ' m'}) and the bullet that passed within a few metres of the sniper (+25 %) read ${st.detection.toFixed(1)} % (${cueExpected} expected), the enemy is searching`,
    );
    await cue.close();

    // 12d. Enemy snipers, aim assists and the first-person rifle in one mission: the panels share the screen without overlapping, the
    // rifle is not drawn in cover, the cover mask sits between the picture and the HUD, and the assists aim at enemy snipers too.
    const combo = await openPage();
    await startGame(combo, `m=${MISSION_SNIPERS_ASSISTS}&debug=1`);
    await combo.evaluate(() => window.__game.unlockAudio());
    st = await gameState(combo);
    check(st.snipers.length === 2 && st.soldiers.length === 1 && st.targetsLeft === 3, 'the combined mission has 1 soldier and 2 enemy snipers');
    check((await combo.locator('.assist-panel').count()) === 1 && (await combo.locator('.threat-panel').count()) === 1, 'both the assist panel and the threat panel are there');
    for (const key of ['KeyT', 'KeyA', 'KeyP']) await combo.keyboard.press(key); // every assist on: the assist panel is at its tallest
    await waitGameSeconds(combo, 0.4);
    // The panels, at 1280x720 and at 1024x640, with the longest threat line.
    checkPanelsClear(await panelRects(combo, LONGEST_THREAT), VIEWPORT.width, VIEWPORT.height, 'snipers + assists 1280x720');
    checkPanelsClear(await panelRects(combo, null), VIEWPORT.width, VIEWPORT.height, 'snipers + assists 1280x720 (live threat line)');
    await animationFrames(combo, 3);
    const callsUnscoped = (await gameState(combo)).render.calls;
    await combo.screenshot({ path: join(OUT_DIR, 'snipers-assists-rifle.png') });
    await combo.setViewportSize({ width: 1024, height: 640 });
    await animationFrames(combo, 4);
    checkPanelsClear(await panelRects(combo, LONGEST_THREAT), 1024, 640, 'snipers + assists 1024x640');
    checkPanelsClear(await panelRects(combo, null), 1024, 640, 'snipers + assists 1024x640 (live threat line)');
    await combo.screenshot({ path: join(OUT_DIR, 'snipers-assists-1024.png') });
    await combo.setViewportSize(VIEWPORT);
    await animationFrames(combo, 4);

    // Cover: no rifle (fewer draw calls), the mask between the picture and the HUD, the threat line on top.
    check(await combo.locator('.assist-spotter').isVisible(), 'before ducking the spotter text is shown');
    const markerBeforeCover = await combo.locator('.aim-marker').isVisible();
    log(`before ducking the aim marker is ${markerBeforeCover ? 'shown' : 'not shown (the view is off its point)'}`);
    await combo.keyboard.press('KeyC');
    await animationFrames(combo, 4);
    st = await gameState(combo);
    check(st.covered, 'C ducks into cover in the combined mission');
    log(`draw calls: ${callsUnscoped} with the rifle, ${st.render.calls} in cover`);
    check(callsUnscoped - st.render.calls >= 4, `the rifle is not drawn in cover (${callsUnscoped} draw calls up, ${st.render.calls} ducked)`);
    const stacking = await combo.evaluate(() => {
      const z = (selector) => Number(getComputedStyle(document.querySelector(selector)).zIndex);
      return { scope: z('.scope-overlay'), marker: z('.aim-marker'), mask: z('.cover-mask'), hud: z('.hud'), assist: z('.assist-panel'), flash: z('.damage-flash'), threat: z('.threat-panel') };
    });
    check(stacking.mask > stacking.scope && stacking.mask > stacking.marker, `the cover mask is above the scope overlay and the aim marker (z ${stacking.mask} > ${stacking.scope}, ${stacking.marker})`);
    check(stacking.mask < stacking.hud && stacking.mask < stacking.assist && stacking.mask < stacking.threat && stacking.mask < stacking.flash, `the cover mask is below the HUD, the assist panel, the damage flash and the threat line (z ${stacking.mask} < ${stacking.hud}, ${stacking.assist}, ${stacking.flash}, ${stacking.threat})`);
    check((await combo.locator('.cover-mask').isVisible()) && (await combo.locator('.hud-panel').isVisible()) && (await combo.locator('.threat-panel').isVisible()), 'in cover the mask, the status panel and the threat line show together');
    check(!(await combo.locator('.assist-spotter').isVisible()) && !(await combo.locator('.aim-marker').isVisible()), 'in cover the spotter text and the aim marker are hidden');
    await combo.screenshot({ path: join(OUT_DIR, 'snipers-assists-cover.png') });
    await combo.keyboard.press('KeyC');
    await animationFrames(combo, 4);
    st = await gameState(combo);
    check(!st.covered && st.render.calls >= callsUnscoped - 2, `back up from cover the rifle is drawn again (${st.render.calls} draw calls)`);
    check(await combo.locator('.assist-spotter').isVisible(), 'back up from cover the spotter text is shown again');

    // The assists aim at enemy snipers: scoped on the nearer one, the marker is on the crosshair's neighbourhood and the spotter calls him.
    const prey = [...st.snipers].sort((a, b) => Math.hypot(a.upperTorso.x, a.upperTorso.z) - Math.hypot(b.upperTorso.x, b.upperTorso.z))[0];
    const preyRange = Math.hypot(prey.upperTorso.x, prey.upperTorso.z);
    await combo.evaluate(([x, y, z]) => {
      window.__game.toggleScope();
      window.__game.aimAt(x, y, z);
    }, [prey.upperTorso.x, prey.upperTorso.y, prey.upperTorso.z]);
    await waitGameSeconds(combo, 0.5);
    const markerOf = async () => {
      const box = await combo.locator('.aim-marker').boundingBox();
      return { x: box.x + box.width / 2 - VIEWPORT.width / 2, y: box.y + box.height / 2 - VIEWPORT.height / 2 };
    };
    check(await combo.locator('.aim-marker').isVisible(), 'A shows the aim marker with the crosshair on an enemy sniper');
    const mark = await markerOf();
    check(Math.abs(mark.x) < 60 && Math.abs(mark.y) < 60, `the marker is near the crosshair, on the sniper (${mark.x.toFixed(0)}, ${mark.y.toFixed(0)} px from the centre)`);
    const calls = parseSpotter((await combo.locator('.assist-spotter').textContent()) ?? '');
    check(calls !== null && Math.abs(calls.rangeM - preyRange) < 3, `the spotter calls the sniper (${(await combo.locator('.assist-spotter').textContent()) ?? ''}; he is ${preyRange.toFixed(0)} m out)`);
    const comboLens = await combo.locator('.scope-lens').boundingBox();
    const comboAssist = await combo.locator('.assist-panel').boundingBox();
    const lensCx = comboLens.x + comboLens.width / 2;
    const lensCy = comboLens.y + comboLens.height / 2;
    const nearPx = Math.min(Math.max(lensCx, comboAssist.x), comboAssist.x + comboAssist.width);
    const nearPy = Math.min(Math.max(lensCy, comboAssist.y), comboAssist.y + comboAssist.height);
    check(Math.hypot(nearPx - lensCx, nearPy - lensCy) > comboLens.width / 2, 'with the spotter on, the assist panel does not cover the scope lens');
    // The longest threat line stays on one line and clear of the lens (the circle, not just its box) at 1280x720 scoped.
    const lensRadius = comboLens.width / 2;
    const longest = (await panelRects(combo, LONGEST_THREAT)).threat;
    const nearTx = Math.min(Math.max(lensCx, longest.left), longest.right);
    const nearTy = Math.min(Math.max(lensCy, longest.top), longest.bottom);
    check(longest.bottom - longest.top < 26, `the longest threat line is one line (${(longest.bottom - longest.top).toFixed(1)} px tall)`);
    check(Math.hypot(nearTx - lensCx, nearTy - lensCy) > lensRadius, `the longest threat line does not touch the scope lens (nearest point ${Math.hypot(nearTx - lensCx, nearTy - lensCy).toFixed(1)} px from its centre, radius ${lensRadius.toFixed(1)})`);
    const comboHint = await combo.locator('.hud-hint').boundingBox();
    check(comboHint.height < 24 && comboHint.y >= comboLens.y + comboLens.height, `the hint with C and T/A/P is one line below the lens (top ${comboHint.y.toFixed(0)}, ${comboHint.height.toFixed(0)} px tall)`);
    check(/ C cover.*T\/A\/P assists/.test((await combo.locator('.hud-hint').textContent()) ?? ''), 'the hint lists both C (cover) and T/A/P');
    await combo.screenshot({ path: join(OUT_DIR, 'snipers-assists-scoped.png') });
    // Follow the call: the crosshair that far above (and beside) the upper torso puts the marker on it, and the shot takes him out.
    const preyBearing = Math.atan2(prey.upperTorso.x, -prey.upperTorso.z);
    const aimPoint = {
      x: prey.upperTorso.x + calls.rangeM * Math.tan(calls.rightMil / 1000) * Math.cos(preyBearing),
      y: prey.upperTorso.y + calls.rangeM * Math.tan(calls.upMil / 1000),
      z: prey.upperTorso.z + calls.rangeM * Math.tan(calls.rightMil / 1000) * Math.sin(preyBearing),
    };
    await combo.evaluate(([x, y, z]) => window.__game.aimAt(x, y, z), [aimPoint.x, aimPoint.y, aimPoint.z]);
    await waitGameSeconds(combo, 0.4);
    const mark2 = await markerOf();
    check(Math.hypot(mark2.x, mark2.y) < 6, `with the crosshair where the spotter said, the marker sits on it (${mark2.x.toFixed(1)}, ${mark2.y.toFixed(1)} px off the centre)`);
    const assistedKill = await shootAt(combo, aimPoint, 0);
    log(`assisted shot at the sniper: "${assistedKill}"`);
    check(/^SNIPER DOWN/.test(assistedKill), 'the shot taken as the spotter called it takes the enemy sniper out');
    await waitGameSeconds(combo, 0.5);
    const next = parseSpotter((await combo.locator('.assist-spotter').textContent()) ?? '');
    check(next !== null && Math.abs(next.rangeM - preyRange) > 5, 'the dead sniper is no longer a target: the spotter moved on to another');
    await combo.close();

    // The largest mission with everything on: mountain, suppressor, 3 snipers, assists with the trajectory line drawn.
    const everything = await openPage();
    await startGame(everything, `m=${MISSION_MAX_ALL}&debug=1`);
    await everything.keyboard.press('KeyT');
    await animationFrames(everything, 8);
    st = await gameState(everything);
    log(`largest mission with everything on: ${st.render.calls} draw calls, ${st.render.triangles} triangles`);
    check(st.snipers.length === 3 && st.targetsLeft === 16, 'the largest mission with everything on has 3 snipers and 16 targets');
    check(st.render.calls > 100 && st.render.calls <= MAX_DRAW_CALLS, `with everything on it stays within the draw-call budget (${st.render.calls} <= ${MAX_DRAW_CALLS})`);
    // The worst view is not always the opening one: scoped on every target in turn (the sun-shadow box follows the crosshair, so each view
    // draws other casters), with the rifle off and the trajectory line on.
    const everyPoint = [...st.soldiers.map((k) => k.upperTorso), ...st.vehicles.map((v) => v.engine), ...st.snipers.map((k) => k.upperTorso)];
    await everything.evaluate(() => window.__game.toggleScope());
    let worstCalls = 0;
    for (const point of everyPoint) {
      await everything.evaluate(([x, y, z]) => window.__game.aimAt(x, y, z), [point.x, point.y, point.z]);
      await animationFrames(everything, 4);
      worstCalls = Math.max(worstCalls, (await gameState(everything)).render.calls);
    }
    log(`largest mission with everything on, scoped on each of its ${everyPoint.length} targets: at most ${worstCalls} draw calls`);
    check(everyPoint.length === 16 && worstCalls <= MAX_DRAW_CALLS, `scoped on any target with everything on it stays within the draw-call budget (${worstCalls} <= ${MAX_DRAW_CALLS})`);
    await everything.close();

    // 12b. The high-value target: he walks his compound with his guards; once he is in plain view the world is paused again (as it is
    // without pointer lock), he is aimed at through the hook with the hold for his range, one shot takes him down, and "HVT eliminated"
    // comes up with the range of the shot.
    const hvtPage = await openPage();
    await startGame(hvtPage, `m=${MISSION_HVT}&debug=1`);
    await animationFrames(hvtPage, 3);
    st = await gameState(hvtPage);
    check(st.hvt !== null && st.hvt.status === 'idle' && st.hvt.guardsAlive >= 2, `the HVT mission has an idle HVT with his guards (${JSON.stringify(st.hvt && { status: st.hvt.status, guards: st.hvt.guardsAlive })})`);
    check(/Eliminate the HVT: officer in the red beret/.test((await hvtPage.locator('.hud-objective').textContent()) ?? ''), 'the HUD names the objective');
    await hvtPage.evaluate(() => {
      window.__game.keepRunning(true);
      window.__game.toggleScope();
    });
    // Let him walk (game time) until he is in plain view, clear of his guards and of the house.
    let hvtState = null;
    let walked = 0;
    for (let i = 0; i < 240 && !hvtState; i++) {
      await waitGameSeconds(hvtPage, 0.25);
      const h = (await gameState(hvtPage)).hvt;
      walked = Math.max(walked, h.speed);
      if (h.exposed && h.status === 'idle' && walked > 1) hvtState = h;
    }
    check(hvtState !== null, `the HVT walks his route and comes into plain view (top speed ${walked.toFixed(2)} m/s)`);
    const hvtRange = Math.hypot(hvtState.x, hvtState.z);
    // Back to the paused world of a check without pointer lock (he stays where he stands while the bullet flies), and aim.
    await hvtPage.evaluate(() => {
      window.__game.keepRunning(false);
      window.__game.aimAtHvt('chest');
    });
    const hvtChest = (await gameState(hvtPage)).hvt.upperTorso;
    await shootAt(hvtPage, hvtChest, holdFor(hvtRange));
    await hvtPage.waitForFunction(() => window.__game.state().hvt.status === 'down', undefined, { timeout: RESULT_TIMEOUT_MS });
    check(/HVT DOWN/.test((await hvtPage.locator('.hud-result').textContent()) ?? ''), `the HUD says HVT DOWN (${await hvtPage.locator('.hud-result').textContent()})`);
    await hvtPage.waitForSelector('.results', { timeout: RESULT_TIMEOUT_MS });
    const hvtTitle = (await hvtPage.locator('.results-title').textContent()) ?? '';
    const hvtRows = await resultsRows(hvtPage);
    check(hvtTitle === 'HVT eliminated' && /^Eliminated at \d+ m$/.test(hvtRows.HVT ?? ''), `the results say "HVT eliminated" with the range (${hvtTitle}: ${hvtRows.HVT})`);
    await hvtPage.screenshot({ path: join(OUT_DIR, 'hvt-results.png') });
    await hvtPage.close();

    // 13. A failed start and a failed frame leave a way out. These pages break on purpose, so they log errors the
    // other pages must not: they are opened without the `problems` listeners.
    const noGl = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    await noGl.addInitScript(() => {
      HTMLCanvasElement.prototype.getContext = () => null; // no WebGL: the renderer cannot be created
    });
    await noGl.goto(`${preview.url}?m=${MISSION_SINGLE}`, { waitUntil: 'load' });
    await noGl.waitForSelector('.fatal');
    check(/Could not start the game/.test((await noGl.locator('.fatal-text').textContent()) ?? ''), 'a failed start shows "Could not start the game: ..."');
    check((await noGl.locator('.prep').count()) === 0, 'a failed start removes the "Preparing mission…" text');
    check((await noGl.locator('.fatal-link').getAttribute('href')) === '/', 'the error panel links back to the menu (/)');
    await noGl.screenshot({ path: join(OUT_DIR, 'fatal-start.png') });
    await Promise.all([noGl.waitForURL((u) => u.pathname === '/' && u.search === ''), noGl.locator('.fatal-link').click()]);
    await noGl.waitForSelector('.menu-start');
    await imagesLoaded(noGl);
    check((await noGl.locator('.menu-start').count()) === 1, 'Back to menu from a failed start opens the menu');
    await noGl.close();

    const brokenFrame = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const frameErrors = [];
    brokenFrame.on('console', (message) => {
      if (message.type() === 'error') frameErrors.push(message.text());
    });
    await brokenFrame.goto(`${preview.url}?m=${MISSION_SINGLE}&debug=1`, { waitUntil: 'load' });
    await brokenFrame.waitForFunction(() => Boolean(window.__game), undefined, { timeout: 15_000 });
    await animationFrames(brokenFrame, 3);
    await brokenFrame.waitForLoadState('networkidle');
    await brokenFrame.evaluate(() => {
      WebGL2RenderingContext.prototype.clear = () => {
        throw new Error('smoke: broken frame');
      };
    });
    await brokenFrame.waitForSelector('.fatal');
    check(/The game stopped: smoke: broken frame/.test((await brokenFrame.locator('.fatal-text').textContent()) ?? ''), 'an error in a frame shows the error panel');
    await brokenFrame.waitForTimeout(600);
    check(frameErrors.filter((m) => /broken frame/.test(m)).length === 1, `the loop stopped after the first failed frame (${frameErrors.length} error logged)`);
    check((await brokenFrame.locator('.fatal-link').getAttribute('href')) === '/', 'the frame-error panel links back to the menu too');
    await brokenFrame.screenshot({ path: join(OUT_DIR, 'fatal-frame.png') });
    await Promise.all([brokenFrame.waitForURL((u) => u.pathname === '/' && u.search === ''), brokenFrame.locator('.fatal-link').click()]);
    await brokenFrame.waitForSelector('.menu-start');
    await imagesLoaded(brokenFrame);
    check((await brokenFrame.locator('.menu-start').count()) === 1, 'Back to menu from a failed frame opens the menu');
    await brokenFrame.close();

    check(problems.length === 0, `no console errors or failed requests${problems.length ? `: ${problems.join(' | ')}` : ''}`);

    writeFileSync(join(OUT_DIR, 'smoke.json'), JSON.stringify({ frames, naked, scope, result, nearResult, againResult }, null, 2));
    log('screenshots in test-results/: naked, scope, result, standing-100m, hit-100m, reset-100m, rifle-unscoped, rifle-scoped, rifle-suppressed, mission-start, mission-hit, mission-results, assists-trajectory, assists-arc, assists-marker, assists-all, assists-results, mission-cover, mission-cover-scoped, mission-vehicle, mission-max, mission-arctic, mission-valley, menu, menu-short, menu-controls, menu-new-controls, menu-<theme>, menu-<theme>-mission, mission-default, mission, menu-back, hud-menu, hud-menu-scope, snipers-scoped, snipers-hit, snipers-cover, snipers-bombardment, snipers-complete, snipers-last-target, snipers-failed, snipers-assists-rifle, snipers-assists-1024, ghillie-unaware, snipers-assists-cover, snipers-assists-scoped, hvt-results, fatal-start, fatal-frame (.png)');
  } finally {
    await cleanup();
  }
}

run().then(
  () => {
    log('SMOKE OK');
    process.exit(0);
  },
  (error) => {
    console.error(`[smoke] FAILED: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  },
);
