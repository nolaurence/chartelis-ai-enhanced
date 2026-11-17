// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AIAssistant from './AIAssistant';

const state = vi.hoisted(() => ({
  invoke: vi.fn(async (_command: string, _args?: any): Promise<any> => undefined),
  handler: null as null | ((event: any) => void),
  unlisten: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: state.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_event: string, handler: (event: any) => void) => { state.handler = (payload: any) => handler({ payload }); return state.unlisten; }),
}));
vi.mock('./i18n', () => ({ t: (text: string, ...values: unknown[]) => text.replace(/\{(\d+)\}/g, (_match, index) => String(values[Number(index)] ?? '')), useLanguage: () => ({ resolved: 'zh-CN' }) }));

function requestResult(method: string, params: any): any {
  switch (method) {
    case 'account/read': return { account: { type: 'apiKey' }, requiresOpenaiAuth: true };
    case 'thread/list': return { data: [] };
    case 'model/list': return { data: [{ model: 'gpt-test', isDefault: true }] };
    case 'thread/start': return { thread: { id: 'thread-1', cwd: params.cwd, historyMode: 'paginated' } };
    case 'turn/start': return { turn: { id: 'turn-1' } };
    case 'thread/resume': return { thread: { id: params.threadId, historyMode: 'paginated' } };
    case 'thread/read': return { thread: { turns: [] } };
    default: return {};
  }
}

let root: Root;
let element: HTMLDivElement;
const base = { canReload: false, onClose() {}, onChooseFolder() {}, onReload() {} };
async function flush() { for (let i = 0; i < 12; i++) await act(async () => {}); }
async function show(open: boolean, directory?: string) {
  await act(async () => { root.render(<AIAssistant {...base} open={open} directory={directory} />); });
  await flush();
}
const commands = () => state.invoke.mock.calls.map(([command]) => command);
const requests = () => state.invoke.mock.calls.filter(([command]) => command === 'codex_request').map(([, args]) => args.method);

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.handler = null;
  state.unlisten.mockClear();
  state.invoke.mockReset().mockImplementation(async (command: string, args?: any) => {
    if (command === 'codex_status') return { installed: true, supported: true, path: 'codex', version: 'codex-cli 0.167.2' };
    if (command === 'codex_request') return requestResult(args.method, args.params);
    return undefined;
  });
  element = document.createElement('div'); document.body.append(element); root = createRoot(element);
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  element.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('codex assistant lifecycle', () => {
  it('starts on demand, keeps a hidden session, and restarts when switching projects', async () => {
    await show(false, 'F:/project-a');
    expect(commands()).not.toContain('codex_start');
    await show(true, 'F:/project-a');
    expect(state.invoke).toHaveBeenCalledWith('codex_start', { directory: 'F:/project-a' });
    expect(requests()).toContain('account/read');
    state.invoke.mockClear();
    await show(false, 'F:/project-a');
    expect(commands()).not.toContain('codex_stop');
    await show(true, 'F:/project-b');
    const lifecycle = commands().filter(command => command === 'codex_stop' || command === 'codex_start');
    expect(lifecycle).toEqual(['codex_stop', 'codex_start']);
    expect(state.invoke).toHaveBeenCalledWith('codex_start', { directory: 'F:/project-b' });
    state.invoke.mockClear();
    await show(true);
    expect(commands()).toContain('codex_stop');
    expect(commands()).not.toContain('codex_start');
    expect(element.textContent).toContain('为助手打开一个文件夹');
  });

  it('guides installation when the system has no codex', async () => {
    state.invoke.mockImplementation(async (command: string) => {
      if (command === 'codex_status') return { installed: false, supported: false, path: null, version: null };
      return undefined;
    });
    await show(true, 'F:/project-a');
    expect(element.textContent).toContain('未找到 Codex CLI');
    expect(element.textContent).toContain('npm install -g @openai/codex');
    expect(commands()).not.toContain('codex_start');
  });

  it('guides login when codex is unauthenticated', async () => {
    state.invoke.mockImplementation(async (command: string, args?: any) => {
      if (command === 'codex_status') return { installed: true, supported: true, path: 'codex', version: 'codex-cli 0.167.2' };
      if (command === 'codex_request' && args.method === 'account/read') return { account: null, requiresOpenaiAuth: true };
      if (command === 'codex_request') return requestResult(args.method, args.params);
      return undefined;
    });
    await show(true, 'F:/project-a');
    expect(element.textContent).toContain('需要登录 Codex');
    expect(element.textContent).toContain('codex login');
  });
});

describe('codex conversation', () => {
  it('sends a turn, streams the reply, and answers approvals', async () => {
    await show(true, 'F:/project-a');
    const composer = element.querySelector('textarea');
    expect(composer).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(composer, '帮我润色这段文字');
      composer!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const send = [...element.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === '发送')!;
    await act(async () => { send.click(); });
    await flush();
    expect(requests()).toContain('thread/start');
    const turn = state.invoke.mock.calls.find(([command, args]) => command === 'codex_request' && args.method === 'turn/start');
    expect(turn?.[1].params).toMatchObject({ threadId: 'thread-1', input: [{ type: 'text', text: '帮我润色这段文字' }] });

    // Stream a user echo, an agent delta and the authoritative completion.
    await act(async () => {
      state.handler!({ type: 'notification', method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: '帮我润色这段文字' }] } } });
      state.handler!({ type: 'notification', method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'a1', type: 'agentMessage', text: '' } } });
      state.handler!({ type: 'notification', method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'a1', delta: '好的，' } });
    });
    expect(element.textContent).toContain('好的，');
    await act(async () => {
      state.handler!({ type: 'notification', method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'a1', type: 'agentMessage', text: '好的，这是润色后的版本。' } } });
    });
    expect(element.textContent).toContain('这是润色后的版本。');

    // A command approval arrives; approving answers the server request.
    await act(async () => {
      state.handler!({ type: 'request', id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'c1', command: 'ls -la', reason: '列出文件' } });
    });
    expect(element.textContent).toContain('请求执行命令');
    expect(element.textContent).toContain('ls -la');
    const approve = [...element.querySelectorAll('button')].find(button => button.textContent === '批准')!;
    await act(async () => { approve.click(); });
    await flush();
    expect(state.invoke).toHaveBeenCalledWith('codex_respond', { id: 7, result: { decision: 'accept' } });
    expect(element.textContent).not.toContain('请求执行命令');

    // Turn completion clears the busy state.
    await act(async () => {
      state.handler!({ type: 'notification', method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } } });
    });
    expect([...element.querySelectorAll('button')].some(button => button.getAttribute('aria-label') === '发送')).toBe(true);
  });

  it('rejects unknown server requests instead of hanging the agent', async () => {
    await show(true, 'F:/project-a');
    await act(async () => {
      state.handler!({ type: 'request', id: 9, method: 'attestation/generate', params: {} });
    });
    await flush();
    expect(state.invoke).toHaveBeenCalledWith('codex_reject', { id: 9, message: expect.any(String) });
  });
});
