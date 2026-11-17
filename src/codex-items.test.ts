import { describe, expect, it } from 'vitest';
import { mapLiveItem, rolloutToItems } from './codex-items';

describe('live ThreadItem mapping', () => {
  it('maps messages, commands, file changes and reasoning', () => {
    expect(mapLiveItem({ id: 'u', type: 'userMessage', content: [{ type: 'text', text: '你好' }] }))
      .toEqual({ kind: 'user', id: 'u', text: '你好' });
    expect(mapLiveItem({ id: 'a', type: 'agentMessage', text: '**回答**' }))
      .toEqual({ kind: 'agent', id: 'a', text: '**回答**' });
    expect(mapLiveItem({ id: 'c', type: 'commandExecution', command: 'ls -la', cwd: '/tmp', status: 'completed', aggregatedOutput: 'file.md', exitCode: 0 }))
      .toMatchObject({ kind: 'command', id: 'c', command: 'ls -la', output: 'file.md', status: 'completed', exitCode: 0 });
    expect(mapLiveItem({ id: 'f', type: 'fileChange', status: 'inProgress', changes: [{ path: 'a.md', kind: { type: 'add' }, diff: '+hi' }] }))
      .toMatchObject({ kind: 'fileChange', id: 'f', status: 'inProgress', changes: [{ path: 'a.md', type: 'add', diff: '+hi' }] });
    expect(mapLiveItem({ id: 'r', type: 'reasoning', summary: ['想了想'] }))
      .toEqual({ kind: 'reasoning', id: 'r', summary: ['想了想'] });
    expect(mapLiveItem({ id: 'x', type: 'somethingNew' })).toBeNull();
    expect(mapLiveItem(null)).toBeNull();
  });

  it('keeps empty agent messages so deltas have a target', () => {
    expect(mapLiveItem({ id: 'a', type: 'agentMessage', text: '' })).toEqual({ kind: 'agent', id: 'a', text: '' });
  });
});

describe('rollout history mapping', () => {
  const entries = [
    { type: 'session_meta', payload: { session_id: 's' } },
    { type: 'response_item', payload: { type: 'message', id: 'm0', role: 'developer', content: [{ type: 'input_text', text: 'system prompt' }] } },
    { type: 'response_item', payload: { type: 'message', id: 'm1', role: 'user', content: [{ type: 'input_text', text: '<environment_context>noise</environment_context>' }] } },
    { type: 'response_item', payload: { type: 'message', id: 'm2', role: 'user', content: [{ type: 'input_text', text: '帮我改文件' }] } },
    { type: 'response_item', payload: { type: 'reasoning', id: 'r1', summary: [{ type: 'summary_text', text: '计划' }] } },
    { type: 'response_item', payload: { type: 'function_call', id: 'fc1', call_id: 'call-1', name: 'shell', arguments: '{"command":["bash","-lc","ls"]}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'call-1', output: 'a.md\nb.md' } },
    { type: 'response_item', payload: { type: 'message', id: 'm3', role: 'assistant', content: [{ type: 'output_text', text: '改好了' }] } },
    { type: 'event_msg', payload: { type: 'turn_aborted' } },
  ];

  it('filters wrappers and developer noise, pairs tool outputs', () => {
    const items = rolloutToItems(entries);
    expect(items.map(item => item.kind)).toEqual(['user', 'reasoning', 'command', 'agent', 'info']);
    const command = items[2];
    expect(command).toMatchObject({ kind: 'command', command: 'bash -lc ls', output: 'a.md\nb.md' });
    expect(items[0]).toMatchObject({ kind: 'user', text: '帮我改文件' });
    expect(items[3]).toMatchObject({ kind: 'agent', text: '改好了' });
  });

  it('maps apply_patch and unknown tools generically', () => {
    const items = rolloutToItems([
      { type: 'response_item', payload: { type: 'function_call', call_id: 'p1', name: 'apply_patch', arguments: '{"input":"*** Begin Patch"}' } },
      { type: 'response_item', payload: { type: 'function_call', call_id: 'p2', name: 'update_plan', arguments: '{"plan":[]}' } },
    ]);
    expect(items[0]).toMatchObject({ kind: 'tool', name: 'apply_patch', detail: '*** Begin Patch' });
    expect(items[1]).toMatchObject({ kind: 'tool', name: 'update_plan' });
  });
});
