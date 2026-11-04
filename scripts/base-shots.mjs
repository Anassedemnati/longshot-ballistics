// Screenshots of the military base for a person to inspect (dev only):
//   node scripts/base-shots.mjs [baseUrl] [themes] [kinds|all]
//   e.g. node scripts/base-shots.mjs http://127.0.0.1:4184/ dav all
// The server must already run (`npx vite --port 4184 --strictPort --host 127.0.0.1`); never use the ports of
// someone's own dev server. themes: d = desert, a = arctic, v = valley. Writes test-results/base/<theme>-<kind>.png
// (close-ups), <theme>-base-<d>m.png and <theme>-outpost-<d>m.png (long-lens overviews), and prints the draw calls
// of the base merged (scene/baseMesh.ts) and drawn prop by prop.
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const [baseUrl = 'http://127.0.0.1:4184/', themes = 'dav', only = 'all'] = process.argv.slice(2);
const OUT = 'test-results/base';
const THEMES = { d: 'desert', a: 'arctic', v: 'valley' };
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

const settle = (page, ms) => page.evaluate((wait) => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, wait)))), ms);

async function open(theme, size) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.error(`[${theme}]`, e.message));
  page.on('console', (m) => m.type() === 'error' && console.error(`[${theme}]`, m.text()));
  await page.goto(`${baseUrl}?basePreview=1&theme=${theme}&size=${size}&seed=7`);
  await page.waitForFunction(() => window.__preview?.ready, undefined, { timeout: 120_000 });
  await settle(page, 2500); // textures
  return page;
}

try {
  for (const t of themes) {
    const theme = THEMES[t];
    const page = await open(theme, 'base');
    const info = await page.evaluate(() => ({ props: window.__preview.props, colliders: window.__preview.colliders }));
    for (const d of [300, 600]) {
      await page.evaluate((dist) => window.__preview.overview(dist, dist * 0.08), d);
      await settle(page, 300);
      await page.screenshot({ path: `${OUT}/${theme}-base-${d}m.png` });
    }
    await page.evaluate(() => window.__preview.overview(450, 36));
    const calls = {};
    for (const mode of ['none', 'merged', 'single']) {
      await page.evaluate((m) => window.__preview.setMode(m), mode);
      calls[mode] = await page.evaluate(() => window.__preview.calls());
    }
    await page.evaluate(() => window.__preview.setMode('merged'));
    console.log(`${theme}: base of ${info.props} props, ${info.colliders} colliders; draw calls (overview, shadows included): no base ${calls.none.calls}, merged ${calls.merged.calls}, prop by prop ${calls.single.calls}`);
    const kinds = only === 'all' ? await page.evaluate(() => window.__preview.kinds) : only.split(',');
    for (const kind of kinds) {
      await page.evaluate((k) => window.__preview.focus(k), kind);
      await settle(page, 200);
      await page.screenshot({ path: `${OUT}/${theme}-${kind}.png` });
    }
    await page.close();
    const outpost = await open(theme, 'outpost');
    await outpost.evaluate(() => window.__preview.overview(300, 26));
    await settle(outpost, 300);
    await outpost.screenshot({ path: `${OUT}/${theme}-outpost-300m.png` });
    await outpost.close();
  }
} finally {
  await browser.close();
}
