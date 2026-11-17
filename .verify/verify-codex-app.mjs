// Full-stack verification inside the running Tauri dev app (CDP on 9223).
// Exercises the real Rust transport against the system codex; no model calls.
import { chromium, expect } from '@playwright/test';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
const page = browser.contexts()[0].pages()[0];
const invoke = (command, args) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [command, args]);

try {
  // 1. Discovery through the real command fence.
  const status = await invoke('codex_status');
  console.log('status =', JSON.stringify(status));
  expect(status.installed).toBe(true);
  expect(status.supported).toBe(true);
  expect(status.version).toMatch(/^codex-cli /);

  // 2. Start against a real folder; handshake must succeed.
  const directory = 'F:\\projects\\Chartelis\\.verify\\codex-e2e';
  await invoke('codex_start', { directory });
  console.log('codex_start OK');

  // 3. Protocol round-trips through Rust.
  const account = await invoke('codex_request', { method: 'account/read', params: {} });
  console.log('account =', JSON.stringify(account));
  expect(account).toHaveProperty('requiresOpenaiAuth');
  const threads = await invoke('codex_request', { method: 'thread/list', params: { cwd: directory, limit: 10 } });
  expect(Array.isArray(threads.data)).toBe(true);
  const models = await invoke('codex_request', { method: 'model/list', params: { limit: 20 } });
  expect(models.data.length).toBeGreaterThan(0);
  console.log(`threads=${threads.data.length} models=${models.data.length} first=${models.data[0].model}`);

  // 4. Rollout fence rejects paths outside the codex home sessions dir.
  let fenceError = '';
  try { await invoke('codex_read_rollout', { path: 'C:\\Windows\\win.ini' }); } catch (error) { fenceError = String(error); }
  expect(fenceError).toContain('只允许读取 Codex 会话记录');
  console.log('rollout fence OK:', fenceError);

  // 5. Concurrent requests must not deadlock the state lock.
  const [a, b] = await Promise.all([
    invoke('codex_request', { method: 'model/list', params: { limit: 5 } }),
    invoke('codex_request', { method: 'thread/list', params: { cwd: directory, limit: 5 } }),
  ]);
  expect(a.data.length).toBeGreaterThan(0);
  expect(Array.isArray(b.data)).toBe(true);
  console.log('concurrent requests OK');

  // 6. UI renders the assistant panel (no folder selected → guidance).
  await page.getByRole('button', { name: 'AI 助手', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'AI 助手' });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('heading', { name: '为助手打开一个文件夹' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/codex-assistant-desktop.png' });
  await page.getByRole('button', { name: '关闭 AI 助手' }).click();
  console.log('UI panel OK');

  // 7. Stop kills the process; a following request reports not running.
  await invoke('codex_stop');
  let stoppedError = '';
  try { await invoke('codex_request', { method: 'account/read', params: {} }); } catch (error) { stoppedError = String(error); }
  expect(stoppedError).toContain('助手未运行');
  console.log('stop OK');
  console.log('PASS: full-stack codex integration inside the real desktop app.');
} finally {
  await invoke('codex_stop').catch(() => {});
  browser.close();
}
