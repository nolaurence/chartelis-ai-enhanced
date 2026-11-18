import { useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { Check, ChevronDown, Copy, FileText, History, LoaderCircle, MessageSquarePlus, RefreshCw, Send, Settings2, Sparkles, Square, Terminal, X } from 'lucide-react';
import { t, useLanguage } from './i18n';
import { renderAIMarkdown } from './ai-markdown';
import {
  codex, defaultThreadSettings, interruptTurn, listModels, listThreads, loadHistory, loadThreadSettings,
  readAccount, resumeThread, saveThreadSettings, sendTurn, startThread,
  type ApprovalRequest, type CodexAccount, type CodexModel, type CodexStatus, type CodexThread, type ThreadSettings,
} from './codex-client';
import { mapLiveItem, type DisplayItem, type PlanStep } from './codex-items';
import './ai.css';

// Serialize lifecycle operations, including React StrictMode cleanup.
let operations = Promise.resolve<unknown>(undefined);
function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = operations.then(operation, operation);
  operations = result.catch(() => {});
  return result;
}

type Phase = 'idle' | 'checking' | 'install' | 'unsupported' | 'starting' | 'auth' | 'ready' | 'error';

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent);
const installCommand = isMac ? 'curl -fsSL https://chatgpt.com/codex/install.sh | sh' : 'irm https://chatgpt.com/codex/install.ps1 | iex';

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return <button className="icon-button" aria-label={t('复制命令')} title={t('复制命令')} onClick={() => {
    void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {});
  }}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>;
}

function CommandHint({ command }: { command: string }) {
  return <div className="ai-command"><code>{command}</code><CopyButton text={command} /></div>;
}

function relativeTime(seconds: number | undefined): string {
  if (!seconds) return '';
  const delta = Math.max(0, Date.now() / 1000 - seconds);
  if (delta < 60) return t('刚刚');
  if (delta < 3600) return t('{0} 分钟前', Math.floor(delta / 60));
  if (delta < 86400) return t('{0} 小时前', Math.floor(delta / 3600));
  if (delta < 86400 * 30) return t('{0} 天前', Math.floor(delta / 86400));
  return new Date(seconds * 1000).toLocaleDateString();
}

const approvalLabels: Record<string, string> = {
  untrusted: '仅自动批准可信操作',
  'on-request': '按需询问',
  never: '从不询问',
};
const sandboxLabels: Record<string, string> = {
  'read-only': '只读',
  'workspace-write': '可写工作区',
  'danger-full-access': '完全访问',
};

function ApprovalCard({ approval, onDecide, onAnswer }: {
  approval: ApprovalRequest;
  onDecide(approval: ApprovalRequest, decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel'): void;
  onAnswer(approval: ApprovalRequest, answers: Record<string, string[]>): void;
}) {
  const { method, params } = approval;
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  if (method === 'item/tool/requestUserInput') {
    const questions: any[] = Array.isArray(params?.questions) ? params.questions : [];
    const complete = questions.every(question => (answers[question.id]?.length ?? 0) > 0 && answers[question.id][0] !== '');
    return <div className="ai-approval" role="alertdialog" aria-label={t('助手提问')}>
      {questions.map(question => <div key={question.id} className="ai-approval-question">
        <p>{question.header ? `${question.header} · ` : ''}{question.question}</p>
        {Array.isArray(question.options) && question.options.length ? <div className="ai-approval-options">
          {question.options.map((option: any) => <button key={option.label} className={`ai-chip ${answers[question.id]?.[0] === option.label ? 'is-selected' : ''}`} title={option.description} onClick={() => setAnswers(current => ({ ...current, [question.id]: [option.label] }))}>{option.label}</button>)}
        </div> : <input className="ai-approval-input" value={answers[question.id]?.[0] ?? ''} onChange={event => setAnswers(current => ({ ...current, [question.id]: [event.target.value] }))} />}
      </div>)}
      <div className="ai-approval-actions"><button className="primary-button" disabled={!complete} onClick={() => onAnswer(approval, answers)}>{t('提交回答')}</button></div>
    </div>;
  }
  const legacy = method === 'execCommandApproval' || method === 'applyPatchApproval';
  const command = legacy
    ? (Array.isArray(params?.command) ? params.command.join(' ') : params?.command ?? '')
    : params?.command ?? '';
  const changes = method === 'applyPatchApproval' && params?.changes ? Object.keys(params.changes) : [];
  return <div className="ai-approval" role="alertdialog" aria-label={t('工具审批')}>
    <div className="ai-approval-title"><Terminal size={14} />{method.includes('fileChange') || method === 'applyPatchApproval' ? t('请求修改文件') : t('请求执行命令')}</div>
    {command && <pre className="ai-approval-command">{String(command)}</pre>}
    {changes.length > 0 && <ul className="ai-approval-files">{changes.map(path => <li key={path}>{path}</li>)}</ul>}
    {params?.reason && <p className="ai-approval-reason">{String(params.reason)}</p>}
    <div className="ai-approval-actions">
      <button className="primary-button" onClick={() => onDecide(approval, 'accept')}>{t('批准')}</button>
      <button onClick={() => onDecide(approval, 'acceptForSession')}>{t('本会话批准')}</button>
      <button onClick={() => onDecide(approval, 'decline')}>{t('拒绝')}</button>
      <button className="ai-danger" onClick={() => onDecide(approval, 'cancel')}>{t('拒绝并停止')}</button>
    </div>
  </div>;
}

function ItemView({ item }: { item: DisplayItem }) {
  switch (item.kind) {
    case 'user':
      return <div className="ai-item ai-user"><div className="ai-bubble">{item.text}</div></div>;
    case 'agent':
      return <div className="ai-item ai-agent"><div className="ai-md" dangerouslySetInnerHTML={{ __html: renderAIMarkdown(item.text) }} /></div>;
    case 'reasoning':
      return <details className="ai-item ai-reasoning"><summary>{t('思考过程')}</summary><div className="ai-md" dangerouslySetInnerHTML={{ __html: renderAIMarkdown(item.summary.join('\n\n')) }} /></details>;
    case 'command':
      return <div className={`ai-item ai-tool is-${item.status}`}>
        <div className="ai-tool-title"><Terminal size={13} /><code>{item.command || t('命令')}</code><span className="ai-tool-state">{item.status === 'inProgress' ? t('执行中…') : item.status === 'failed' ? t('失败') : item.status === 'declined' ? t('已拒绝') : item.exitCode != null && item.exitCode !== 0 ? t('退出码 {0}', item.exitCode) : t('完成')}</span></div>
        {item.output && <details className="ai-tool-output"><summary>{t('输出')}</summary><pre>{item.output}</pre></details>}
      </div>;
    case 'fileChange':
      return <div className={`ai-item ai-tool is-${item.status}`}>
        <div className="ai-tool-title"><FileText size={13} /><span>{t('文件修改')}</span><span className="ai-tool-state">{item.status === 'inProgress' ? t('进行中…') : item.status === 'declined' ? t('已拒绝') : t('完成')}</span></div>
        <ul className="ai-files">{item.changes.map(change => <li key={change.path}><code>{change.path}</code><span className={`ai-file-kind is-${change.type}`}>{change.type === 'add' ? t('新增') : change.type === 'delete' ? t('删除') : t('更新')}</span></li>)}</ul>
        {item.changes.some(change => change.diff) && <details className="ai-tool-output"><summary>{t('差异')}</summary>{item.changes.map(change => change.diff ? <pre key={change.path}>{change.diff}</pre> : null)}</details>}
      </div>;
    case 'tool':
      return <div className={`ai-item ai-tool is-${item.status}`}>
        <div className="ai-tool-title"><Sparkles size={13} /><code>{item.name}</code><span className="ai-tool-state">{item.status === 'inProgress' ? t('调用中…') : item.status === 'failed' ? t('失败') : t('完成')}</span></div>
        {item.detail && <details className="ai-tool-output"><summary>{t('参数')}</summary><pre>{item.detail}</pre></details>}
        {item.output && <details className="ai-tool-output"><summary>{t('结果')}</summary><pre>{item.output}</pre></details>}
      </div>;
    case 'webSearch':
      return <div className="ai-item ai-info">🔍 {t('搜索：{0}', item.query)}</div>;
    case 'error':
      return <div className="ai-item ai-error" role="alert">{item.message}</div>;
    case 'info':
      return <div className="ai-item ai-info">{item.text}</div>;
  }
}

export default function AIAssistant({ open, directory, canReload, onClose, onChooseFolder, onReload }: {
  open: boolean; directory?: string;
  canReload: boolean;
  onClose(): void; onChooseFolder(): void; onReload(): void;
}) {
  const { resolved: language } = useLanguage();
  const [activated, setActivated] = useState(false);
  const [retry, setRetry] = useState(0);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const [status, setStatus] = useState<CodexStatus | null>(null);
  const [account, setAccount] = useState<CodexAccount | null>(null);
  const [threads, setThreads] = useState<CodexThread[]>([]);
  const [thread, setThread] = useState<CodexThread | null>(null);
  const [items, setItems] = useState<DisplayItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [plan, setPlan] = useState<PlanStep[] | null>(null);
  const [usage, setUsage] = useState<{ total: number; window?: number } | null>(null);
  const [models, setModels] = useState<CodexModel[]>([]);
  const [settings, setSettings] = useState<ThreadSettings>({ ...defaultThreadSettings });
  const [showSettings, setShowSettings] = useState(false);
  const [showThreads, setShowThreads] = useState(false);
  const [draft, setDraft] = useState('');
  const [loadingHistory, setLoadingHistory] = useState(false);

  const threadRef = useRef<CodexThread | null>(null);
  const settingsRef = useRef(settings);
  const turnIdRef = useRef<string | null>(null);
  const directoryRef = useRef(directory);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  threadRef.current = thread;
  settingsRef.current = settings;
  directoryRef.current = directory;
  useEffect(() => { if (open) setActivated(true); }, [open]);

  const upsert = (item: DisplayItem) => setItems(current => {
    const index = current.findIndex(entry => entry.id === item.id);
    if (index === -1) return [...current, item];
    const next = current.slice();
    next[index] = item;
    return next;
  });
  const appendText = (id: string, kind: 'agent' | 'command', delta: string) => setItems(current => {
    const index = current.findIndex(entry => entry.id === id);
    if (index === -1) {
      return kind === 'agent' ? [...current, { kind: 'agent', id, text: delta }] : [...current, { kind: 'command', id, command: '', output: delta, status: 'inProgress', exitCode: null }];
    }
    const target = current[index];
    const next = current.slice();
    if (target.kind === 'agent') next[index] = { ...target, text: target.text + delta };
    else if (target.kind === 'command') next[index] = { ...target, output: target.output + delta };
    return next;
  });

  // Lifecycle: discover → start → auth → catalog. Hiding the panel keeps the
  // runtime and conversation alive; switching folders restarts it.
  useEffect(() => {
    if (!isTauri()) return;
    let current = true;
    setPhase('idle'); setError(''); setThread(null); setItems([]); setApprovals([]); setPlan(null); setUsage(null); setBusy(false); setNotice(''); setThreads([]);
    threadRef.current = null; turnIdRef.current = null;
    if (!activated || !directory) return;
    setSettings(loadThreadSettings(directory));
    void enqueue(async () => {
      if (!current) return;
      setPhase('checking');
      const found = await codex.status();
      if (!current) return;
      setStatus(found);
      if (!found.installed) { setPhase('install'); return; }
      if (!found.supported) { setPhase('unsupported'); return; }
      setPhase('starting');
      await codex.start(directory);
      if (!current) return;
      const auth = await readAccount();
      if (!current) return;
      if (!auth.account && auth.requiresOpenaiAuth) { setPhase('auth'); return; }
      setAccount(auth.account);
      const [recent, catalog] = await Promise.all([listThreads(directory), listModels().catch(() => [] as CodexModel[])]);
      if (!current) return;
      setThreads(recent);
      setModels(catalog);
      setPhase('ready');
      if (recent.length) {
        // Continue the latest conversation for this folder.
        const target = recent[0];
        try {
          const resumed = await resumeThread(target.id, settingsRef.current);
          if (!current) return;
          const full = { ...target, ...resumed.thread };
          setThread(full); threadRef.current = full;
          setLoadingHistory(true);
          const history = await loadHistory(full);
          if (!current) return;
          setItems(history);
        } catch { if (current) { setThread(null); threadRef.current = null; } }
        finally { if (current) setLoadingHistory(false); }
      }
    }).catch(reason => { if (current) { setError(String(reason)); setPhase('error'); } });
    return () => {
      current = false;
      void enqueue(() => codex.stop()).catch(() => {});
    };
  }, [directory, activated, retry]);

  // Live protocol events for the running session.
  useEffect(() => {
    if (phase !== 'ready' || !isTauri()) return;
    let active = true;
    let unlisten: UnlistenFn | undefined;
    const handleRequest = (id: number | string, method: string, params: any) => {
      const known = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'execCommandApproval', 'applyPatchApproval', 'item/tool/requestUserInput'];
      if (known.includes(method)) setApprovals(current => [...current, { id, method, params }]);
      else void codex.reject(id, 'Chartelis does not implement this request').catch(() => {});
    };
    void codex.events(event => {
      if (!active) return;
      if (event.type === 'exit') { setPhase('error'); setError(t('助手已停止，请重新连接')); setBusy(false); return; }
      if (event.type === 'request') { handleRequest(event.id, event.method, event.params); return; }
      const { method, params } = event;
      const threadId = threadRef.current?.id;
      const mine = !params?.threadId || params.threadId === threadId;
      switch (method) {
        case 'item/started':
        case 'item/completed': {
          if (!mine) return;
          const item = mapLiveItem(params.item);
          if (item) upsert(item);
          return;
        }
        case 'item/agentMessage/delta':
          if (mine && typeof params.delta === 'string') appendText(params.itemId, 'agent', params.delta);
          return;
        case 'item/reasoning/summaryPartAdded':
        case 'item/reasoning/summaryTextDelta': {
          if (!mine) return;
          const index = Number(params.summaryIndex ?? 0);
          setItems(current => {
            const position = current.findIndex(entry => entry.id === params.itemId);
            const delta = method.endsWith('TextDelta') ? String(params.delta ?? '') : '';
            if (position === -1) {
              const summary = Array(index + 1).fill('');
              summary[index] = delta;
              return [...current, { kind: 'reasoning', id: params.itemId, summary }];
            }
            const target = current[position];
            if (target.kind !== 'reasoning') return current;
            const summary = target.summary.slice();
            while (summary.length <= index) summary.push('');
            summary[index] += delta;
            const next = current.slice();
            next[position] = { ...target, summary };
            return next;
          });
          return;
        }
        case 'item/commandExecution/outputDelta':
          if (mine && typeof params.delta === 'string') appendText(params.itemId, 'command', params.delta);
          return;
        case 'item/fileChange/patchUpdated': {
          if (!mine) return;
          const changes = Array.isArray(params.changes) ? params.changes.map((change: any) => ({ path: String(change.path ?? ''), type: change.kind?.type ?? 'update', diff: typeof change.diff === 'string' ? change.diff : undefined })) : [];
          setItems(current => {
            const position = current.findIndex(entry => entry.id === params.itemId);
            if (position === -1) return [...current, { kind: 'fileChange', id: params.itemId, changes, status: 'inProgress' }];
            const target = current[position];
            if (target.kind !== 'fileChange') return current;
            const next = current.slice();
            next[position] = { ...target, changes };
            return next;
          });
          return;
        }
        case 'turn/started':
          if (!mine) return;
          turnIdRef.current = params.turn?.id ?? null;
          setBusy(true); setNotice('');
          return;
        case 'turn/completed': {
          if (!mine) return;
          setBusy(false); setNotice('');
          turnIdRef.current = null;
          const turn = params.turn ?? {};
          if (turn.error?.message) upsert({ kind: 'error', id: `error-${turn.id ?? Date.now()}`, message: String(turn.error.message) });
          else if (turn.status === 'interrupted') upsert({ kind: 'info', id: `interrupted-${turn.id ?? Date.now()}`, text: t('已停止生成') });
          const folder = directoryRef.current;
          if (folder) void listThreads(folder).then(setThreads).catch(() => {});
          return;
        }
        case 'turn/plan/updated':
          if (mine && Array.isArray(params.plan)) setPlan(params.plan);
          return;
        case 'thread/tokenUsage/updated': {
          if (!mine) return;
          const total = params.tokenUsage?.total?.totalTokens;
          if (typeof total === 'number') setUsage({ total, window: params.tokenUsage?.modelContextWindow });
          return;
        }
        case 'thread/name/updated':
          if (params.threadId === threadId) setThread(current => current ? { ...current, name: params.threadName ?? null } : current);
          return;
        case 'serverRequest/resolved':
          setApprovals(current => current.filter(approval => String(approval.id) !== String(params.requestId)));
          return;
        case 'error': {
          if (!mine) return;
          const message = String(params.error?.message ?? t('发生未知错误'));
          if (params.willRetry) setNotice(t('正在重试：{0}', message));
          else upsert({ kind: 'error', id: `error-${params.turnId ?? Date.now()}`, message });
          return;
        }
        case 'warning':
        case 'configWarning':
          if (params?.message) setNotice(String(params.message));
          else if (params?.summary) setNotice(String(params.summary));
          return;
        case 'account/updated':
          void readAccount().then(auth => setAccount(auth.account)).catch(() => {});
          return;
        default:
          return;
      }
    }).then(unsubscribe => { if (active) unlisten = unsubscribe; else unsubscribe(); });
    return () => { active = false; unlisten?.(); };
  }, [phase, directory]);

  // Keep the view pinned to the newest content unless the user scrolled up.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller && stickToBottom.current) scroller.scrollTop = scroller.scrollHeight;
  }, [items, approvals, busy, plan, loadingHistory]);

  const ready = phase === 'ready';

  const updateSettings = (patch: Partial<ThreadSettings>) => {
    setSettings(current => {
      const next = { ...current, ...patch };
      if (directoryRef.current) saveThreadSettings(directoryRef.current, next);
      return next;
    });
  };

  const openThread = async (target: CodexThread) => {
    setShowThreads(false);
    if (busy || !directoryRef.current) return;
    setItems([]); setApprovals([]); setPlan(null); setUsage(null); setNotice('');
    setLoadingHistory(true);
    try {
      const resumed = await resumeThread(target.id, settingsRef.current);
      const full = { ...target, ...resumed.thread };
      setThread(full); threadRef.current = full;
      setItems(await loadHistory(full));
    } catch (reason) {
      upsert({ kind: 'error', id: `resume-${Date.now()}`, message: String(reason) });
    } finally { setLoadingHistory(false); }
  };

  const newConversation = () => {
    if (busy) return;
    setShowThreads(false);
    setThread(null); threadRef.current = null; turnIdRef.current = null;
    setItems([]); setApprovals([]); setPlan(null); setUsage(null); setNotice('');
    composerRef.current?.focus();
  };

  const send = async () => {
    const text = draft.trim();
    const folder = directoryRef.current;
    if (!text || busy || !ready || !folder) return;
    setDraft('');
    setBusy(true);
    try {
      let current = threadRef.current;
      if (!current) {
        const started = await startThread(folder, settingsRef.current);
        current = started.thread;
        setThread(current); threadRef.current = current;
        setThreads(list => [current!, ...list.filter(entry => entry.id !== current!.id)]);
      }
      const response = await sendTurn(current.id, text, settingsRef.current);
      turnIdRef.current = response.turn?.id ?? null;
    } catch (reason) {
      setBusy(false);
      upsert({ kind: 'error', id: `send-${Date.now()}`, message: String(reason) });
    }
  };

  const stop = () => {
    const current = threadRef.current;
    if (!current || !turnIdRef.current) return;
    void interruptTurn(current.id, turnIdRef.current).catch(reason => setNotice(String(reason)));
  };

  const decide = (approval: ApprovalRequest, decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel') => {
    const legacy = approval.method === 'execCommandApproval' || approval.method === 'applyPatchApproval';
    const mapped = legacy
      ? ({ accept: 'approved', acceptForSession: 'approved_for_session', decline: { denied: { rejection: '' } }, cancel: 'abort' } as const)[decision]
      : decision;
    void codex.respond(approval.id, { decision: mapped })
      .then(() => setApprovals(current => current.filter(entry => entry.id !== approval.id)))
      .catch(reason => setNotice(String(reason)));
  };

  const answer = (approval: ApprovalRequest, answers: Record<string, string[]>) => {
    const payload = Object.fromEntries(Object.entries(answers).map(([id, values]) => [id, { answers: values }]));
    void codex.respond(approval.id, { answers: payload })
      .then(() => setApprovals(current => current.filter(entry => entry.id !== approval.id)))
      .catch(reason => setNotice(String(reason)));
  };

  const threadTitle = thread?.name || thread?.preview?.split('\n')[0]?.slice(0, 60) || t('新建对话');

  return <aside id="ai-assistant" className="ai-panel" aria-label={t('AI 助手')} hidden={!open} data-tauri-drag-region={isTauri() ? true : undefined}>
    <div className="ai-heading"><span><Sparkles size={17} />{t('AI 助手')}</span><div>
      <button className="icon-button" disabled={!ready || busy} title={t('新建对话')} aria-label={t('新建对话')} onClick={newConversation}><MessageSquarePlus size={17} /></button>
      <button className={`icon-button ${showThreads ? 'is-active' : ''}`} disabled={!ready} title={t('历史对话')} aria-label={t('历史对话')} aria-expanded={showThreads} onClick={() => { setShowThreads(value => !value); setShowSettings(false); }}><History size={16} /></button>
      <button className={`icon-button ${showSettings ? 'is-active' : ''}`} disabled={!ready} title={t('助手设置')} aria-label={t('助手设置')} aria-expanded={showSettings} onClick={() => { setShowSettings(value => !value); setShowThreads(false); }}><Settings2 size={16} /></button>
      <button className="icon-button" title={t('关闭 AI 助手')} aria-label={t('关闭 AI 助手')} onClick={onClose}><X size={17} /></button>
    </div></div>
    {directory && <div className="ai-workspace" title={directory}><span>{directory.split(/[\\/]/).filter(Boolean).at(-1) || directory}</span><button disabled={!canReload} title={t('重新加载当前文稿')} aria-label={t('重新加载当前文稿')} onClick={onReload}><RefreshCw size={14} /></button></div>}

    {showThreads && ready && <div className="ai-popover ai-threads" role="menu">
      <button className="ai-threads-new" onClick={newConversation}><MessageSquarePlus size={14} />{t('新建对话')}</button>
      {threads.length ? threads.map(entry => <button key={entry.id} role="menuitem" className={`ai-thread-entry ${entry.id === thread?.id ? 'is-current' : ''}`} onClick={() => void openThread(entry)}>
        <span className="ai-thread-name">{entry.name || entry.preview?.split('\n')[0]?.slice(0, 60) || t('未命名对话')}</span>
        <span className="ai-thread-time">{relativeTime(entry.updatedAt)}</span>
      </button>) : <p className="ai-popover-empty">{t('这个文件夹还没有历史对话')}</p>}
    </div>}

    {showSettings && ready && <div className="ai-popover ai-settings">
      <label>{t('模型')}<select value={settings.model ?? ''} onChange={event => updateSettings({ model: event.target.value || undefined })}>
        <option value="">{t('默认（Codex 选择）')}</option>
        {models.map(model => <option key={model.model} value={model.model}>{model.displayName || model.model}{model.isDefault ? ` · ${t('默认')}` : ''}</option>)}
      </select></label>
      <label>{t('审批策略')}<select value={settings.approvalPolicy} onChange={event => updateSettings({ approvalPolicy: event.target.value as ThreadSettings['approvalPolicy'] })}>
        {Object.entries(approvalLabels).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
      </select></label>
      <label>{t('沙箱')}<select value={settings.sandbox} onChange={event => updateSettings({ sandbox: event.target.value as ThreadSettings['sandbox'] })}>
        {Object.entries(sandboxLabels).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
      </select></label>
      <p className="ai-settings-note">{t('设置保存在本机，按文件夹记住；从下一个回合生效。')}</p>
      {status?.version && <p className="ai-settings-meta">{status.version}{account?.email ? ` · ${account.email}` : account?.type === 'apiKey' ? ' · API Key' : ''}</p>}
    </div>}

    <div className="ai-body">
      {!isTauri() ? <div className="ai-empty"><Sparkles size={26} /><h3>{t('请在桌面版使用 AI 助手')}</h3><p>{t('桌面版直接调用系统安装的 Codex CLI，工作区跟随打开的文件夹。')}</p></div>
        : !directory ? <div className="ai-empty"><Sparkles size={26} /><h3>{t('为助手打开一个文件夹')}</h3><p>{t('助手将在这个工程中读取和修改文件。')}</p><button className="primary-button" onClick={onChooseFolder}>{t('打开文件夹')}</button></div>
          : phase === 'install' ? <div className="ai-empty ai-guide"><h3>{t('未找到 Codex CLI')}</h3>
            <p>{t('Chartelis 直接使用系统里安装的 Codex CLI。请先安装：')}</p>
            <CommandHint command="npm install -g @openai/codex" />
            <p>{t('或使用官方安装脚本：')}</p>
            <CommandHint command={installCommand} />
            <p><a href="https://developers.openai.com/codex/cli" target="_blank" rel="noopener noreferrer">{t('Codex CLI 文档')}</a></p>
            <button className="primary-button" onClick={() => setRetry(value => value + 1)}>{t('重新检测')}</button>
          </div>
            : phase === 'unsupported' ? <div className="ai-empty ai-guide"><h3>{t('Codex 版本过旧')}</h3>
              <p>{t('检测到 {0}，需要 0.156.0 或更高版本。请升级：', status?.version ?? '')}</p>
              <CommandHint command="npm install -g @openai/codex@latest" />
              <button className="primary-button" onClick={() => setRetry(value => value + 1)}>{t('重新检测')}</button>
            </div>
              : phase === 'auth' ? <div className="ai-empty ai-guide"><h3>{t('需要登录 Codex')}</h3>
                <p>{t('在终端运行以下命令完成登录，然后重试：')}</p>
                <CommandHint command="codex login" />
                <button className="primary-button" onClick={() => setRetry(value => value + 1)}>{t('重新检测')}</button>
              </div>
                : phase === 'error' ? <div className="ai-empty" role="alert"><p className="ai-error">{error}</p><button className="primary-button" onClick={() => setRetry(value => value + 1)}>{t('重新连接')}</button></div>
                  : phase === 'checking' || phase === 'starting' || phase === 'idle' ? <div className="ai-empty" role="status"><LoaderCircle className="ai-loading" size={24} /><p>{phase === 'checking' ? t('正在检测 Codex CLI…') : t('正在启动助手…')}</p></div>
                    : <div className="ai-chat">
                      <button className="ai-thread-bar" onClick={() => { setShowThreads(value => !value); setShowSettings(false); }} aria-expanded={showThreads}>
                        <span>{threadTitle}</span><ChevronDown size={14} />
                      </button>
                      <div className="ai-messages" ref={scrollRef} onScroll={() => {
                        const scroller = scrollRef.current;
                        if (scroller) stickToBottom.current = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 48;
                      }}>
                        {loadingHistory && <div className="ai-history-loading" role="status"><LoaderCircle className="ai-loading" size={16} />{t('正在读取历史…')}</div>}
                        {!loadingHistory && !items.length && !busy && <div className="ai-welcome"><Sparkles size={22} /><p>{t('让 Codex 在这个文件夹里帮你读写文稿、整理资料或回答问题。')}</p></div>}
                        {items.map(item => <ItemView key={item.id} item={item} />)}
                        {plan && plan.length > 0 && <div className="ai-item ai-plan"><div className="ai-tool-title">{t('计划')}</div><ul>{plan.map((step, index) => <li key={index} className={`is-${step.status}`}><span className="ai-plan-mark">{step.status === 'completed' ? '✓' : step.status === 'inProgress' ? '→' : '·'}</span>{step.step}</li>)}</ul></div>}
                        {approvals.map(approval => <ApprovalCard key={String(approval.id)} approval={approval} onDecide={decide} onAnswer={answer} />)}
                        {busy && !approvals.length && <div className="ai-thinking" role="status"><LoaderCircle className="ai-loading" size={14} />{t('Codex 正在工作…')}</div>}
                        {notice && <div className="ai-notice" role="status">{notice}</div>}
                      </div>
                      <div className="ai-composer">
                        <textarea ref={composerRef} value={draft} rows={2} placeholder={t('向 Codex 提问…（Enter 发送，Shift+Enter 换行）')} aria-label={t('输入消息')}
                          onChange={event => setDraft(event.target.value)}
                          onKeyDown={event => {
                            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
                          }} />
                        {busy
                          ? <button className="ai-send is-stop" aria-label={t('停止生成')} title={t('停止生成')} onClick={stop}><Square size={15} /></button>
                          : <button className="ai-send" aria-label={t('发送')} title={t('发送')} disabled={!draft.trim()} onClick={() => void send()}><Send size={15} /></button>}
                      </div>
                      <div className="ai-statusline">
                        <button onClick={() => { setShowSettings(value => !value); setShowThreads(false); }}>{settings.model || t('默认模型')} · {t(approvalLabels[settings.approvalPolicy])} · {t(sandboxLabels[settings.sandbox])}</button>
                        {usage && <span title={t('上下文用量')}>{usage.window ? `${Math.round(usage.total / 1000)}k / ${Math.round(usage.window / 1000)}k` : `${Math.round(usage.total / 1000)}k tokens`}</span>}
                      </div>
                    </div>}
    </div>
    {directory && <p className="ai-footnote">{t('助手使用已保存的文件。修改后可重新加载文稿。')}</p>}
  </aside>;
}
