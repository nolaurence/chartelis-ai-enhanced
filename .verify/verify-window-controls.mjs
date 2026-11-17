// Visual check for the cross-platform titlebar: Windows caption buttons pinned to the
// window corner (even with the AI panel open) and macOS left-side traffic-light reserve.
// Renders the real app in Chrome with a stubbed Tauri bridge so desktop branches mount.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const testReal = fs.realpathSync(path.join(root, 'node_modules/@playwright/test'));
const { chromium } = require(createRequire(path.join(testReal, 'index.js')).resolve('playwright-core'));

const out = path.join(root, '.verify', 'shots');
fs.mkdirSync(out, { recursive: true });

function installStub() {
  localStorage.setItem('chartelis.language', 'zh-CN');
  window.isTauri = true;
  let cb = 0;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    transformCallback: (fn) => { const id = ++cb; window['__cb' + id] = fn; return id; },
    unregisterCallback: () => {},
    invoke: async (cmd) => {
      if (cmd === 'take_pending_files') return [];
      if (cmd === 'plugin:window|is_maximized' || cmd === 'plugin:window|is_fullscreen') return false;
      if (cmd === 'plugin:event|listen') return 1;
      return null;
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const failures = [];
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' · ' + detail : ''}`); if (!ok) failures.push(name); };

// ---------- Windows ----------
const page = await browser.newPage({ viewport: { width: 1280, height: 880 }, deviceScaleFactor: 2 });
await page.addInitScript(installStub);
page.on('pageerror', e => console.log('PAGEERROR', e.message));
await page.goto('http://127.0.0.1:1420', { waitUntil: 'load' });
await page.waitForSelector('.window-controls', { timeout: 15000 });
await page.waitForTimeout(600);

const bar = { x: 0, y: 0, width: 1280, height: 110 };
const corner = { x: 1280 - 460, y: 0, width: 460, height: 110 };
const shot = (p, name, clip) => p.screenshot({ path: path.join(out, name), clip });
const settle = (p = page) => p.waitForTimeout(250);
const geom = () => page.evaluate(() => {
  const c = document.querySelector('.window-corner')?.getBoundingClientRect();
  const t = document.querySelector('.topbar');
  return { cornerRight: c?.right, cornerHeight: c?.height, topbarPadRight: t ? getComputedStyle(t).paddingRight : null, vw: innerWidth };
});

await shot(page, '01-light-topbar.png', bar);
await page.hover('.window-close'); await settle();
await shot(page, '02-light-close-hover.png', corner);
await page.hover('.window-controls button:first-child'); await settle();
await shot(page, '03-light-min-hover.png', corner);
await page.mouse.move(640, 400); await settle();
await page.screenshot({ path: path.join(out, '00-light-full.png') });
let g = await geom();
check('win corner flush right (ai closed)', g.cornerRight === g.vw, JSON.stringify(g));
check('win topbar reserves corner (ai closed)', g.topbarPadRight === '140px', g.topbarPadRight);

await page.click('button[aria-label="切换深色主题"]'); await settle();
await shot(page, '04-dark-topbar.png', bar);
await page.hover('.window-close'); await settle();
await shot(page, '05-dark-close-hover.png', corner);
await page.click('button[aria-label="切换浅色主题"]'); await settle();

await page.click('button[aria-label="收起顶栏"]'); await settle();
await shot(page, '06-strip-light.png', { x: 0, y: 0, width: 1280, height: 60 });
await page.hover('.window-close'); await settle();
await shot(page, '07-strip-close-hover.png', { x: 1280 - 300, y: 0, width: 300, height: 60 });
g = await geom();
check('win compact corner height 32', g.cornerHeight === 32, String(g.cornerHeight));
await page.click('button[aria-label="展开顶栏"]'); await settle();

// AI panel open: corner must stay at the window edge, above the panel's titlebar band.
await page.click('button[aria-label="AI 助手"]');
await page.waitForSelector('.ai-panel:not([hidden])'); await settle();
g = await geom();
check('win corner flush right (ai open)', g.cornerRight === g.vw, JSON.stringify(g));
check('win topbar yields when ai open', g.topbarPadRight === '18px', g.topbarPadRight);
const band = await page.evaluate(() => {
  const h = document.querySelector('.ai-heading').getBoundingClientRect();
  const c = document.querySelector('.window-corner').getBoundingClientRect();
  return { headingTop: h.top, cornerBottom: c.bottom };
});
check('win ai heading below corner band', band.headingTop >= band.cornerBottom, JSON.stringify(band));
await page.screenshot({ path: path.join(out, '09-ai-open-full.png') });
await shot(page, '10-ai-corner.png', corner);
await page.hover('.window-close'); await settle();
await shot(page, '11-ai-close-hover.png', corner);
await page.mouse.move(640, 400);
await page.click('button[aria-label="收起顶栏"]'); await settle();
await shot(page, '12-ai-strip.png', { x: 1280 - 460, y: 0, width: 460, height: 60 });
g = await geom();
check('win compact corner flush right (ai open)', g.cornerRight === g.vw && g.cornerHeight === 32, JSON.stringify(g));
await page.click('button[aria-label="展开顶栏"]'); await settle();
await page.click('button[aria-label="关闭 AI 助手"]'); await settle();

await page.click('button[aria-label="视图"]'); await settle();
await page.click('.app-menu-panel button:has-text("大纲")'); await settle();
await page.setViewportSize({ width: 830, height: 700 }); await settle();
await shot(page, '08-narrow-topbar.png', { x: 0, y: 0, width: 830, height: 110 });
g = await geom();
check('win corner flush right (narrow)', g.cornerRight === g.vw, JSON.stringify(g));
await page.close();

// ---------- macOS (simulated platform; traffic lights are native, so only the reserve is visible) ----------
const mac = await browser.newPage({ viewport: { width: 1280, height: 880 }, deviceScaleFactor: 2 });
await mac.addInitScript(() => { Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' }); });
await mac.addInitScript(installStub);
mac.on('pageerror', e => console.log('MAC PAGEERROR', e.message));
await mac.goto('http://127.0.0.1:1420', { waitUntil: 'load' });
await mac.waitForSelector('.mac-desktop .topbar', { timeout: 15000 });
await mac.waitForTimeout(600);
check('mac renders no custom caption buttons', await mac.locator('.window-controls').count() === 0);
const macPad = () => mac.evaluate(() => ({
  topbarLeft: getComputedStyle(document.querySelector('.topbar')).paddingLeft,
  sidebarTop: document.querySelector('.sidebar-inner') ? getComputedStyle(document.querySelector('.sidebar-inner')).paddingTop : null,
}));
let m = await macPad();
check('mac topbar reserves traffic lights', m.topbarLeft === '94px', m.topbarLeft);
await shot(mac, 'm1-mac-topbar.png', bar);
await mac.click('button[aria-label="视图"]'); await settle(mac);
await mac.click('.app-menu-panel button:has-text("大纲")'); await settle(mac);
m = await macPad();
check('mac sidebar hosts lights (topbar unreserved)', m.topbarLeft === '18px' && m.sidebarTop === '64px', JSON.stringify(m));
await shot(mac, 'm2-mac-sidebar.png', { x: 0, y: 0, width: 900, height: 220 });
await mac.click('button[aria-label="收起顶栏"]'); await settle(mac);
const stripH = await mac.evaluate(() => document.querySelector('.window-strip').getBoundingClientRect().height);
check('mac collapsed strip keeps light height', stripH === 64, String(stripH));
await shot(mac, 'm3-mac-strip.png', { x: 0, y: 0, width: 900, height: 100 });
await mac.click('button[aria-label="展开顶栏"]'); await settle(mac);
await mac.click('button[aria-label="AI 助手"]'); await settle(mac);
await mac.screenshot({ path: path.join(out, 'm4-mac-ai-open.png') });
await mac.close();

await browser.close();
if (failures.length) { console.log('FAILURES:', failures.join(', ')); process.exit(1); }
console.log('SHOTS OK ->', out);
