// System Codex CLI client. The Rust backend owns the process and the JSONL
// transport; this module owns protocol semantics (t3code-compatible).
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { mapLiveItem, rolloutToItems, type DisplayItem, type PlanStep } from './codex-items';

export interface CodexStatus { installed: boolean; supported: boolean; path: string | null; version: string | null }

export interface CodexThread {
  id: string; name?: string | null; preview?: string; cwd?: string;
  createdAt?: number; updatedAt?: number; historyMode?: string; path?: string | null;
  model?: string; status?: { type: string; activeFlags?: string[] };
}

export interface CodexModel { model: string; displayName?: string; description?: string; isDefault?: boolean; hidden?: boolean; defaultReasoningEffort?: string | null; supportedReasoningEfforts?: { effort: string }[] }

export interface CodexAccount { type: string; email?: string | null; planType?: string }

export type CodexEvent =
  | { type: 'notification'; method: string; params: any }
  | { type: 'request'; id: number | string; method: string; params: any }
  | { type: 'exit'; code: number | null; stderr: string };

export interface ApprovalRequest { id: number | string; method: string; params: any }

export type ApprovalPolicy = 'untrusted' | 'on-request' | 'never';
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export interface ThreadSettings { model?: string; effort?: string; approvalPolicy: ApprovalPolicy; sandbox: SandboxMode }
export const defaultThreadSettings: ThreadSettings = { approvalPolicy: 'on-request', sandbox: 'workspace-write' };

export const codex = {
  status: () => invoke<CodexStatus>('codex_status'),
  start: (directory: string) => invoke<void>('codex_start', { directory }),
  stop: () => invoke<void>('codex_stop'),
  request: <T = any>(method: string, params: unknown = {}) => invoke<T>('codex_request', { method, params }),
  respond: (id: number | string, result: unknown) => invoke<void>('codex_respond', { id, result }),
  reject: (id: number | string, message: string) => invoke<void>('codex_reject', { id, message }),
  readRollout: (path: string) => invoke<{ entries: any[]; truncated: boolean }>('codex_read_rollout', { path }),
  events: (handler: (event: CodexEvent) => void): Promise<UnlistenFn> =>
    listen<CodexEvent>('codex-event', event => handler(event.payload)),
};

// thread/start takes the string enum; turn/start takes the policy object.
export function sandboxPolicy(sandbox: SandboxMode) {
  if (sandbox === 'read-only') return { type: 'readOnly' };
  if (sandbox === 'danger-full-access') return { type: 'dangerFullAccess' };
  return { type: 'workspaceWrite' };
}

function settingsParams(settings: ThreadSettings) {
  return {
    ...(settings.model ? { model: settings.model } : {}),
    approvalPolicy: settings.approvalPolicy,
    sandbox: settings.sandbox,
  };
}

export const listThreads = async (directory: string): Promise<CodexThread[]> => {
  const page = await codex.request<{ data?: CodexThread[] }>('thread/list', { cwd: directory, limit: 50, sortKey: 'updated_at', sortDirection: 'desc' });
  return page.data ?? [];
};

export const startThread = (directory: string, settings: ThreadSettings) =>
  codex.request<{ thread: CodexThread }>('thread/start', { cwd: directory, ...settingsParams(settings) });

export const resumeThread = (threadId: string, settings: ThreadSettings) =>
  codex.request<{ thread: CodexThread }>('thread/resume', { threadId, excludeTurns: true, ...settingsParams(settings) });

export const sendTurn = (threadId: string, text: string, settings: ThreadSettings) =>
  codex.request<{ turn: { id: string } }>('turn/start', {
    threadId, input: [{ type: 'text', text }], summary: 'detailed',
    ...(settings.effort ? { effort: settings.effort } : {}),
    approvalPolicy: settings.approvalPolicy, approvalsReviewer: 'user',
    sandboxPolicy: sandboxPolicy(settings.sandbox),
    ...(settings.model ? { model: settings.model } : {}),
  });

export const interruptTurn = (threadId: string, turnId: string) =>
  codex.request('turn/interrupt', { threadId, turnId });

export const readAccount = () =>
  codex.request<{ account: CodexAccount | null; requiresOpenaiAuth: boolean }>('account/read', {});

export const listModels = async (): Promise<CodexModel[]> => {
  const page = await codex.request<{ data?: CodexModel[] }>('model/list', { limit: 100 });
  return (page.data ?? []).filter(model => !model.hidden);
};

/**
 * Load persisted history the way t3code does: legacy threads via thread/read,
 * paginated threads via thread/turns/list. Builds that stub the paginated API
 * (0.167.x answers "not supported yet") fall back to the rollout file.
 */
export async function loadHistory(thread: CodexThread): Promise<DisplayItem[]> {
  try {
    if (thread.historyMode === 'paginated') {
      const items: DisplayItem[] = [];
      const seen = new Set<string | null>();
      let cursor: string | null = null;
      do {
        if (seen.has(cursor)) break;
        seen.add(cursor);
        const page: { data?: { items?: any[] }[]; nextCursor?: string | null } = await codex.request('thread/turns/list', { threadId: thread.id, cursor, limit: 100, sortDirection: 'asc', itemsView: 'full' });
        for (const turn of page.data ?? []) for (const raw of turn.items ?? []) {
          const item = mapLiveItem(raw);
          if (item) items.push(item);
        }
        cursor = page.nextCursor ?? null;
      } while (cursor);
      return items;
    }
    const read = await codex.request<{ thread?: { turns?: { items?: any[] }[] } }>('thread/read', { threadId: thread.id, includeTurns: true });
    const items: DisplayItem[] = [];
    for (const turn of read.thread?.turns ?? []) for (const raw of turn.items ?? []) {
      const item = mapLiveItem(raw);
      if (item) items.push(item);
    }
    return items;
  } catch (error) {
    if (!/not supported/i.test(String(error))) throw error;
    if (!thread.path) return [];
    const { entries } = await codex.readRollout(thread.path);
    return rolloutToItems(entries);
  }
}

export interface TurnPlan { steps: PlanStep[]; explanation?: string }

export function settingsKey(directory: string) { return `chartelis.codex:${directory}`; }

export function loadThreadSettings(directory: string): ThreadSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(settingsKey(directory)) || 'null');
    if (saved && typeof saved === 'object') {
      const approvalPolicy: ApprovalPolicy = ['untrusted', 'on-request', 'never'].includes(saved.approvalPolicy) ? saved.approvalPolicy : defaultThreadSettings.approvalPolicy;
      const sandbox: SandboxMode = ['read-only', 'workspace-write', 'danger-full-access'].includes(saved.sandbox) ? saved.sandbox : defaultThreadSettings.sandbox;
      return {
        model: typeof saved.model === 'string' && saved.model ? saved.model : undefined,
        effort: typeof saved.effort === 'string' && saved.effort ? saved.effort : undefined,
        approvalPolicy, sandbox,
      };
    }
  } catch { /* Corrupt preference falls back to defaults. */ }
  return { ...defaultThreadSettings };
}

export function saveThreadSettings(directory: string, settings: ThreadSettings) {
  try { localStorage.setItem(settingsKey(directory), JSON.stringify(settings)); } catch { /* Preference stays in memory. */ }
}
