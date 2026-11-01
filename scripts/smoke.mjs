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
/** The game's own frame-time cap (MAX_FRAME_DT in src/main.ts): game time advances at most this per frame. */
const MAX_FRAME_DT_S = 0.1;
/** Dummy fall (0.4 s) plus the 3 s it lies there before standing up again (src/scene/target.ts), with a margin. */
const DUMMY_RESET_GAME_S = 3.8;

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

    check(problems.length === 0, `no console errors or failed requests${problems.length ? `: ${problems.join(' | ')}` : ''}`);

    writeFileSync(join(OUT_DIR, 'smoke.json'), JSON.stringify({ frames, naked, scope, result, nearResult, againResult }, null, 2));
    log('screenshots in test-results/: naked, scope, result, standing-100m, hit-100m, reset-100m (.png)');
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
