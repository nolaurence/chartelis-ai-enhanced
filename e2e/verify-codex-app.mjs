// Desktop end-to-end check for the Codex assistant against the real system
// CLI. Requires the dev app running with the WebView2 debugger:
//   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9223'
//   pnpm desktop
// Then: node e2e/verify-codex-app.mjs
// No model/API calls: discovery, handshake, thread/model APIs, rollout fence,
// concurrency, live event channel, UI guidance, and process cleanup.
import { chromium, expect } from '@playwright/test';
import { execSync } from 'node:child_process';

const directory = process.env.CODEX_VERIFY_DIR || 'F:\\projects\\Chartelis';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
const page = browser.contexts()[0].pages()[0];
const invoke = (command, args) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [command, args]);
const load = () => page.evaluate(() => import('/src/codex-client.ts'));

// Only the npm-installed codex this app launches; other installs are not ours.
const ourCodexPids = () => {
  try {
    return execSync('wmic process where "name=\'codex.exe\'" get processid,commandline /format:csv', { encoding: 'utf8' })
      .split('\n').map(line => line.trim()).filter(Boolean).slice(1)
      .filter(line => /node_modules[\\/]@openai[\\/]codex/i.test(line))
      .map(line => line.split(',').at(-2));
  } catch { return []; }
};

try {
  await page.goto('http://127.0.0.1:1420');

  // 1. Discovery and version gate.
  const status = await invoke('codex_status');
  console.log('status =', JSON.stringify(status));
  expect(status.installed).toBe(true);
  expect(status.supported).toBe(true);

  // 2. Start, handshake, protocol round-trips, rollout fence, concurrency.
  await invoke('codex_start', { directory });
  const account = await invoke('codex_request', { method: 'account/read', params: {} });
  console.log('account =', JSON.stringify(account));
  expect(account).toHaveProperty('requiresOpenaiAuth');
  const threads = await invoke('codex_request', { method: 'thread/list', params: { cwd: directory, limit: 10 } });
  expect(Array.isArray(threads.data)).toBe(true);
  const models = await invoke('codex_request', { method: 'model/list', params: { limit: 20 } });
  expect(models.data.length).toBeGreaterThan(0);
  console.log(`threads=${threads.data.length} models=${models.data.length}`);
  let fence = '';
  try { await invoke('codex_read_rollout', { path: 'C:\\Windows\\win.ini' }); } catch (error) { fence = String(error); }
  expect(fence).toContain('只允许读取 Codex 会话记录');
  const [concurrent] = await Promise.all([
    invoke('codex_request', { method: 'model/list', params: { limit: 5 } }),
    invoke('codex_request', { method: 'thread/list', params: { cwd: directory, limit: 5 } }),
  ]);
  expect(concurrent.data.length).toBeGreaterThan(0);
  console.log('PASS: discovery, handshake, protocol, rollout fence, concurrency');

  // 3. Live event channel: subscribe, then provoke real notifications.
  const seen = await page.evaluate(async () => {
    const codex = await import('/src/codex-client.ts');
    const seen = [];
    const stop = await codex.codex.events(event => seen.push(event.type === 'notification' ? event.method : event.type));
    await codex.codex.request('thread/start', { cwd: 'F:\\projects\\Chartelis' });
    await new Promise(done => setTimeout(done, 1200));
    stop();
    return seen;
  });
  console.log('events =', JSON.stringify(seen));
  expect(seen.some(name => typeof name === 'string' && name.includes('/'))).toBe(true);
  console.log('PASS: live event channel');

  // 4. Frontend modules against the real runtime: history + settings.
  const history = await page.evaluate(async cwd => {
    const codex = await import('/src/codex-client.ts');
    const threads = await codex.listThreads(cwd);
    const target = threads.find(thread => thread.path);
    if (!target) return { threads: threads.length, items: 0 };
    const items = await codex.loadHistory(target);
    codex.saveThreadSettings(cwd, { model: 'gpt-6-astra', approvalPolicy: 'on-request', sandbox: 'workspace-write' });
    return { threads: threads.length, items: items.length, settings: codex.loadThreadSettings(cwd) };
  }, directory);
  console.log('history =', JSON.stringify(history));
  expect(history.settings.model).toBe('gpt-6-astra');

  // 5. Assistant panel renders in the desktop app.
  await page.getByRole('button', { name: 'AI 助手', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'AI 助手' })).toBeVisible();
  await page.getByRole('button', { name: '关闭 AI 助手' }).click();
  await expect(page.getByRole('complementary', { name: 'AI 助手' })).toBeHidden();
  console.log('PASS: assistant panel opens and closes');

  // 6. Process cleanup: our codex tree must die with the app.
  await invoke('codex_start', { directory });
  await page.waitForTimeout(1200);
  const before = ourCodexPids();
  await page.getByRole('button', { name: '关闭窗口', exact: true }).click();
  await new Promise(done => setTimeout(done, 5000));
  const after = ourCodexPids();
  const leaked = after.filter(pid => before.includes(pid));
  console.log(`codex pids while running=${JSON.stringify(before)} after exit=${JSON.stringify(after)}`);
  expect(leaked).toEqual([]);
  console.log('PASS: app exit cleans up the whole codex tree');
  console.log('PASS: desktop end-to-end Codex integration.');
} finally {
  await browser.close().catch(() => {});
}
