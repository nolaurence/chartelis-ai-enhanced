// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AIAssistant from './AIAssistant';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => undefined) }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke }));
vi.mock('./i18n', () => ({ t: (text: string) => text, useLanguage: () => ({ resolved: 'zh-CN' }) }));

let root: Root;
let element: HTMLDivElement;
const base = { obscured: false, canReload: false, onClose() {}, onChooseFolder() {}, onReload() {} };
async function show(open: boolean, directory?: string) {
  await act(async () => { root.render(<AIAssistant {...base} open={open} directory={directory} />); });
  await act(async () => { await vi.advanceTimersByTimeAsync(32); });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => setTimeout(() => fn(0), 16));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 768, y: 146, width: 512, height: 700, left: 768, top: 146, right: 1280, bottom: 846, toJSON() {} });
  invoke.mockReset().mockResolvedValue(undefined);
  element = document.createElement('div'); document.body.append(element); root = createRoot(element);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  element.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('assistant workspace lifecycle', () => {
  it('starts on demand, preserves a hidden conversation, and stops before switching projects', async () => {
    await show(false, 'F:/project-a');
    expect(invoke.mock.calls.some(([command]) => command === 'harness_start')).toBe(false);
    await show(true, 'F:/project-a');
    expect(invoke).toHaveBeenCalledWith('harness_start', { directory: 'F:/project-a', language: 'zh-CN' });
    invoke.mockClear();
    await show(false, 'F:/project-a');
    expect(invoke.mock.calls.some(([command]) => command === 'harness_stop')).toBe(false);
    expect(invoke.mock.calls.filter(([command]) => command === 'harness_view').at(-1)?.[1]).toMatchObject({ view: { visible: false } });
    await show(true, 'F:/project-b');
    const lifecycle = invoke.mock.calls.map(([command]) => command).filter(command => command === 'harness_stop' || command === 'harness_start');
    expect(lifecycle).toEqual(['harness_stop', 'harness_start']);
    expect(invoke).toHaveBeenCalledWith('harness_start', { directory: 'F:/project-b', language: 'zh-CN' });
    invoke.mockClear();
    await show(true);
    expect(invoke).toHaveBeenCalledWith('harness_stop');
    expect(invoke.mock.calls.some(([command]) => command === 'harness_start')).toBe(false);
    expect(element.textContent).toContain('为助手打开一个文件夹');
  });

  it('does not show a late startup failure from the previous folder', async () => {
    let reject!: (error: Error) => void;
    invoke.mockImplementation(async command => {
      if (command === 'harness_start' && !reject) return new Promise((_, failure) => { reject = failure; });
    });
    await show(true, 'F:/project-a');
    await show(true, 'F:/project-b');
    await act(async () => { reject(new Error('Old workspace failed')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(32); });
    expect(element.textContent).not.toContain('Old workspace failed');
    expect(invoke).toHaveBeenCalledWith('harness_start', { directory: 'F:/project-b', language: 'zh-CN' });
    expect(invoke.mock.calls.filter(([command]) => command === 'harness_view').at(-1)?.[1]).toMatchObject({ view: { visible: true } });
  });
});
