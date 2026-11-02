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
/** Missions of the smoke (URL codec in src/mission/config.ts: v1.<theme>.<min>.<max>.<soldiers>.<vehicle targets>.<wind x10>.<clock>.<rifle>.<buildings>.<vehicles>.<seed>). */
const MISSION_OPEN = 'v1.d.300.300.3.0.0.9.308.n.n.1'; // 3 soldiers at 300 m, calm, no cover
const MISSION_SINGLE = 'v1.d.300.300.1.0.0.9.308.n.n.1'; // one soldier straight ahead
const MISSION_COVER = 'v1.d.300.300.3.2.0.12.308.m.m.5'; // 3 soldiers + 2 vehicle targets, many buildings and vehicles
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

    // 6. A real mission: three soldiers at 300 m, calm air. Down them one by one.
    const mission = await openPage();
    await startGame(mission, `m=${MISSION_OPEN}&debug=1`);
    await mission.evaluate(() => window.__game.unlockAudio());
    let st = await gameState(mission);
    check(st.targetsLeft === 3 && st.soldiers.length === 3, 'a non-legacy mission starts with 3 targets standing');
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
    check(/^(29\d|30\d) m$/.test(rows['Longest hit'] ?? ''), `results: longest hit about 300 m (${rows['Longest hit']})`);
    check(/^\d\d:\d\d$/.test(rows['Mission time'] ?? ''), `results: mission time as mm:ss (${rows['Mission time']})`);
    check((await mission.locator('.results-button').count()) === 2, 'results: Restart and Menu buttons');
    check((await mission.evaluate(() => document.pointerLockElement)) === null, 'the pointer is not locked on the results screen');
    await mission.screenshot({ path: join(OUT_DIR, 'mission-results.png') });
    await Promise.all([mission.waitForURL(/\?last=v1\.d\.300\.300\.3\.0\.0\.9\.308\.n\.n\.1/), mission.locator('.results-menu').click()]);
    check((await mission.locator('.menu-placeholder-start').count()) === 1, 'Menu returns to the start screen with the mission in ?last=');
    check((await mission.evaluate(() => window.__game)) === undefined, 'the start screen runs no game');
    await mission.close();

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

    // 9. The other themes load and draw (wind, props, a vehicle target).
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

    check(problems.length === 0, `no console errors or failed requests${problems.length ? `: ${problems.join(' | ')}` : ''}`);

    writeFileSync(join(OUT_DIR, 'smoke.json'), JSON.stringify({ frames, naked, scope, result, nearResult, againResult }, null, 2));
    log('screenshots in test-results/: naked, scope, result, standing-100m, hit-100m, reset-100m, mission-start, mission-hit, mission-results, mission-cover, mission-cover-scoped, mission-vehicle, mission-arctic, mission-valley (.png)');
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
