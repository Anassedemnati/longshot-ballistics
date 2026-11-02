import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
mkdirSync('test-results/visual',{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
try {
const page=await browser.newPage({viewport:{width:1280,height:800}});
page.on('console',m=>{if(m.type()==='error')console.error(m.text());});
page.on('pageerror',e=>console.error(e.message));
await page.goto('http://127.0.0.1:5173/?debug=1&theme=outpost&range=150&position=ridge&suppressed=1');
await page.waitForFunction(()=>!!window.__game || document.querySelector('#app')?.textContent?.includes('Could not start'));
console.log(await page.locator('#app').textContent());
if(!await page.evaluate(()=>!!window.__game)) throw new Error('Game startup failed');
await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
await page.screenshot({path:'test-results/visual/outpost.png',timeout:60000});
await page.evaluate(()=>window.__game.toggleScope());
await page.screenshot({path:'test-results/visual/opponents.png',timeout:60000});
console.log('Saved outpost and scoped opponents screenshots');
} finally {await browser.close();}
