// Normalized chat items. Live app-server ThreadItems and persisted rollout
// entries both map into this union so one renderer covers history and stream.

export type ItemStatus = 'inProgress' | 'completed' | 'failed' | 'declined' | 'interrupted';

export interface FileChange { path: string; type: string; diff?: string }
export interface PlanStep { step: string; status: string }

export type DisplayItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'agent'; id: string; text: string }
  | { kind: 'reasoning'; id: string; summary: string[] }
  | { kind: 'command'; id: string; command: string; cwd?: string; output: string; status: ItemStatus; exitCode?: number | null }
  | { kind: 'fileChange'; id: string; changes: FileChange[]; status: ItemStatus }
  | { kind: 'tool'; id: string; name: string; detail: string; output: string; status: ItemStatus }
  | { kind: 'webSearch'; id: string; query: string }
  | { kind: 'error'; id: string; message: string }
  | { kind: 'info'; id: string; text: string };

const asStatus = (value: unknown): ItemStatus =>
  value === 'inProgress' || value === 'failed' || value === 'declined' || value === 'interrupted' ? value : 'completed';

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : '';
  return content.map(part => {
    if (typeof part === 'string') return part;
    if (part && typeof part === 'object') {
      const record = part as Record<string, unknown>;
      if (typeof record.text === 'string') return record.text;
    }
    return '';
  }).filter(Boolean).join('\n');
}

function commandOf(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(' ');
  return typeof value === 'string' ? value : '';
}

/** Map a live ThreadItem (item/started, item/completed) to a display item. */
export function mapLiveItem(item: any): DisplayItem | null {
  if (!item || typeof item !== 'object' || typeof item.id !== 'string') return null;
  const id = item.id;
  switch (item.type) {
    case 'userMessage': {
      const text = textOf(item.content);
      return text ? { kind: 'user', id, text } : null;
    }
    case 'agentMessage':
      return { kind: 'agent', id, text: typeof item.text === 'string' ? item.text : '' };
    case 'reasoning': {
      const summary = Array.isArray(item.summary) ? item.summary.filter((part: unknown) => typeof part === 'string') : [];
      const content = Array.isArray(item.content) ? item.content.filter((part: unknown) => typeof part === 'string') : [];
      const parts = summary.length ? summary : content;
      return parts.length ? { kind: 'reasoning', id, summary: parts } : null;
    }
    case 'commandExecution':
      return { kind: 'command', id, command: commandOf(item.command), cwd: item.cwd, output: item.aggregatedOutput ?? '', status: asStatus(item.status), exitCode: item.exitCode ?? null };
    case 'fileChange':
      return {
        kind: 'fileChange', id, status: asStatus(item.status),
        changes: Array.isArray(item.changes) ? item.changes.map((change: any) => ({ path: String(change.path ?? ''), type: change.kind?.type ?? 'update', diff: typeof change.diff === 'string' ? change.diff : undefined })) : [],
      };
    case 'mcpToolCall':
      return { kind: 'tool', id, name: `${item.server ?? ''}.${item.tool ?? ''}`, detail: JSON.stringify(item.arguments ?? {}), output: item.error?.message ?? (item.result ? JSON.stringify(item.result.content ?? item.result) : ''), status: asStatus(item.status) };
    case 'dynamicToolCall':
      return { kind: 'tool', id, name: String(item.tool ?? ''), detail: JSON.stringify(item.arguments ?? {}), output: item.contentItems ? JSON.stringify(item.contentItems) : '', status: asStatus(item.status) };
    case 'webSearch':
      return { kind: 'webSearch', id, query: String(item.query ?? item.action?.query ?? '') };
    case 'contextCompaction':
      return { kind: 'info', id, text: '上下文已压缩 / Context compacted' };
    case 'enteredReviewMode':
      return { kind: 'info', id, text: '进入审查模式 / Entered review mode' };
    case 'exitedReviewMode':
      return { kind: 'info', id, text: '退出审查模式 / Exited review mode' };
    case 'plan':
      return typeof item.text === 'string' && item.text ? { kind: 'info', id, text: item.text } : null;
    case 'collabAgentToolCall':
      return { kind: 'tool', id, name: String(item.tool ?? 'agent'), detail: typeof item.prompt === 'string' ? item.prompt : '', output: '', status: asStatus(item.status) };
    case 'subAgentActivity':
      return { kind: 'info', id, text: String(item.agentPath ?? item.kind ?? 'subagent') };
    case 'imageGeneration':
      return { kind: 'info', id, text: item.savedPath ? `图片已生成 / Image saved: ${item.savedPath}` : '图片生成 / Image generation' };
    case 'imageView':
      return { kind: 'info', id, text: String(item.path ?? '') };
    default:
      return null;
  }
}

// Rollout user messages can carry injected wrapper blocks; they are context
// for the model, not anything the user typed.
const wrapper = /^<(environment_context|user_instructions|turn_context|skills_instructions|multi_agent_role|permissions|goal_context)>/;

function parseArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return { input: raw }; } }
  return {};
}

const shellTools = new Set(['shell', 'exec_command', 'container.exec', 'local_shell', 'exec', 'unified_exec']);

/** Map persisted rollout entries (codex_read_rollout) to display items. */
export function rolloutToItems(entries: any[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  const byCallId = new Map<string, DisplayItem>();
  entries.forEach((entry, index) => {
    const payload = entry?.payload;
    if (!payload || typeof payload !== 'object') return;
    const id = typeof payload.id === 'string' ? payload.id : `rollout-${index}`;
    if (entry.type === 'event_msg') {
      if (payload.type === 'turn_aborted') items.push({ kind: 'info', id: `abort-${index}`, text: '回合已中断 / Turn interrupted' });
      return;
    }
    if (entry.type !== 'response_item') return;
    switch (payload.type) {
      case 'message': {
        const text = textOf(payload.content);
        if (!text || wrapper.test(text.trim())) return;
        if (payload.role === 'user') items.push({ kind: 'user', id, text });
        else if (payload.role === 'assistant') items.push({ kind: 'agent', id, text });
        return;
      }
      case 'reasoning': {
        const summary = Array.isArray(payload.summary)
          ? payload.summary.map((part: any) => typeof part === 'string' ? part : part?.text ?? '').filter(Boolean)
          : [];
        if (summary.length) items.push({ kind: 'reasoning', id, summary });
        return;
      }
      case 'local_shell_call': {
        const command = commandOf(payload.action?.command ?? payload.command);
        const item: DisplayItem = { kind: 'command', id, command, output: '', status: 'completed', exitCode: null };
        items.push(item);
        if (payload.call_id) byCallId.set(payload.call_id, item);
        return;
      }
      case 'function_call':
      case 'custom_tool_call': {
        const name = String(payload.name ?? '');
        const args = parseArguments(payload.arguments ?? payload.input);
        let item: DisplayItem;
        if (shellTools.has(name)) {
          item = { kind: 'command', id, command: commandOf(args.command ?? args.cmd ?? payload.input), output: '', status: 'completed', exitCode: null };
        } else if (name === 'apply_patch') {
          item = { kind: 'tool', id, name, detail: String(args.input ?? args.patch ?? payload.input ?? ''), output: '', status: 'completed' };
        } else {
          item = { kind: 'tool', id, name, detail: JSON.stringify(args), output: '', status: 'completed' };
        }
        items.push(item);
        if (payload.call_id) byCallId.set(payload.call_id, item);
        return;
      }
      case 'function_call_output': {
        const target = typeof payload.call_id === 'string' ? byCallId.get(payload.call_id) : undefined;
        if (!target) return;
        const output = typeof payload.output === 'string' ? payload.output : textOf((payload.output as any)?.content ?? payload.output);
        if (target.kind === 'command' || target.kind === 'tool') target.output = output;
        return;
      }
      default:
        return;
    }
  });
  return items;
}
