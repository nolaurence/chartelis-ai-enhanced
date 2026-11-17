// Browser-preview check for the Codex assistant panel. The real protocol is
// covered by scripts/smoke-codex.mjs; UI logic by src/AIAssistant.test.tsx.
import { chromium, expect } from '@playwright/test';
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1320, height: 960 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:1420');
  await page.keyboard.press('Control+n');
  await page.getByRole('textbox', { name: 'Markdown 编辑器', exact: true }).fill('文稿原文保持不变');
  await page.getByRole('button', { name: 'AI 助手', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'AI 助手' });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('heading', { name: '请在桌面版使用 AI 助手' })).toBeVisible();
  await expect(panel).toContainText('Codex CLI');
  await page.screenshot({ path: 'artifacts/ai-assistant-light.png' });
  await page.getByRole('button', { name: '切换深色主题' }).click();
  await page.screenshot({ path: 'artifacts/ai-assistant-dark.png' });
  await page.getByRole('button', { name: '关闭 AI 助手' }).click();
  await expect(panel).toBeHidden();
  await page.getByRole('button', { name: 'AI 助手', exact: true }).click();
  await expect(panel).toBeVisible();
  await page.setViewportSize({ width: 720, height: 900 });
  await expect(panel).toBeVisible();
  const right = await panel.evaluate(el => el.getBoundingClientRect().right);
  expect(right).toBeLessThanOrEqual(720);
  await expect(page.getByRole('textbox', { name: 'Markdown 编辑器', exact: true })).toHaveText('文稿原文保持不变');
  expect(errors).toEqual([]);
  console.log('PASS: assistant panel opens with desktop/Codex guidance, theme switch, close/reopen and compact layout.');
} finally { await browser.close(); }
