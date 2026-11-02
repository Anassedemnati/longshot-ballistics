// Visual check: screenshots of the look of every theme (and firing position) for a person to inspect.
//   node scripts/visual-check.mjs [baseUrl] [themes] [positions]
//   e.g. node scripts/visual-check.mjs http://127.0.0.1:4175/ dav vrm
// The server must already run (`npx vite --port 4175`, or `vite preview` on a build); never use the ports of
// someone's own dev server. themes: d = desert, a = arctic, v = valley; positions: v = valley floor, r = ridge,
// m = mountain. Writes test-results/visual/<theme>-<position>-{open,aim,scope}.png and prints the draw calls.
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const [baseUrl = 'http://127.0.0.1:4175/', themes = 'dav', positions = 'r'] = process.argv.slice(2);
const OUT = 'test-results/visual';
mkdirSync(OUT, { recursive: true });

const SOFTWARE_GL = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
let browser = await chromium.launch({ channel: 'chrome', headless: true });
const probe = await browser.newPage();
if (!(await probe.evaluate(() => Boolean(document.createElement('canvas').getContext('webgl2'))))) {
  await browser.close();
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: SOFTWARE_GL });
  console.log('no system WebGL: using SwiftShader');
}
await probe.close().catch(() => {});

/** Let `n` frames draw, then wait a moment (the rangefinder and the shadow focus follow the view a frame later). */
const frames = (page, n, waitMs) =>
  page.evaluate(
    ([count, wait]) =>
      new Promise((resolve) => {
        let c = 0;
        const tick = () => (++c >= count ? setTimeout(resolve, wait) : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    [n, waitMs],
  );

try {
  for (const theme of themes) {
    for (const position of positions) {
      const name = `${theme}-${position}`;
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      page.on('console', (m) => {
        if (m.type() === 'error') console.error(`[${name}]`, m.text());
      });
      page.on('pageerror', (e) => console.error(`[${name}]`, e.message));
      // 4 soldiers and a vehicle target at 150-400 m among many buildings and vehicles: a lot to shade.
      await page.goto(`${baseUrl}?m=v2.${theme}.150.400.4.1.45.9.308.m.m.3.${position}.0.1.0&debug=1`);
      await page.waitForFunction(() => !!window.__game || document.querySelector('#app')?.textContent?.includes('Could not start'), undefined, { timeout: 180_000 });
      if (!(await page.evaluate(() => !!window.__game))) throw new Error(`${name}: the game did not start`);
      await frames(page, 3, 1200);
      await page.screenshot({ path: `${OUT}/${name}-open.png`, timeout: 120_000 });

      const state = await page.evaluate(() => window.__game.state());
      const soldier = state.soldiers[0];
      await page.evaluate((p) => window.__game.aimAt(p.x, p.y, p.z), soldier.upperTorso);
      await frames(page, 4, 800);
      await page.screenshot({ path: `${OUT}/${name}-aim.png`, timeout: 120_000 });

      await page.evaluate(() => window.__game.toggleScope());
      await page.evaluate(() => window.__game.zoom(-3));
      await frames(page, 6, 1200);
      await page.screenshot({ path: `${OUT}/${name}-scope.png`, timeout: 120_000 });
      const calls = (await page.evaluate(() => window.__game.state())).render.calls;
      console.log(`${name}: ${calls} draw calls (scoped on a soldier) -> ${OUT}/${name}-{open,aim,scope}.png`);
      await page.close();
    }
  }
} finally {
  await browser.close();
}
