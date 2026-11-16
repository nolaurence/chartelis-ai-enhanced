import { useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { FolderOpen, LoaderCircle, MessageSquarePlus, RefreshCw, Settings2, Sparkles, X } from 'lucide-react';
import { t, useLanguage } from './i18n';
import './ai.css';

// Serialize lifecycle and native view operations, including React StrictMode cleanup.
let operations = Promise.resolve<unknown>(undefined);
function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = operations.then(operation, operation);
  operations = result.catch(() => {});
  return result;
}
const palette = ['paper', 'surface', 'sidebar', 'text', 'muted', 'line', 'hover', 'accent', 'selected', 'accent-soft'];

export default function AIAssistant({ open, obscured, directory, canReload, onClose, onChooseFolder, onReload }: {
  open: boolean; obscured: boolean; directory?: string;
  canReload: boolean;
  onClose(): void; onChooseFolder(): void; onReload(): void;
}) {
  const { resolved: language } = useLanguage();
  const [activated, setActivated] = useState(false);
  const [retry, setRetry] = useState(0);
  const [readyRoot, setReadyRoot] = useState('');
  const [error, setError] = useState('');
  const container = useRef<HTMLDivElement>(null);
  const languageRef = useRef(language);
  languageRef.current = language;
  const ready = !!directory && readyRoot === directory && !error;
  useEffect(() => { if (open) setActivated(true); }, [open]);

  useEffect(() => {
    if (!isTauri()) return;
    let current = true;
    setReadyRoot(''); setError('');
    if (activated && directory) {
      void enqueue(async () => {
        if (!current) return;
        await invoke('harness_start', { directory, language: languageRef.current });
        if (current) setReadyRoot(directory);
      }).catch(reason => { if (current) setError(String(reason)); });
    }
    return () => {
      current = false;
      void enqueue(() => invoke('harness_stop')).catch(() => {});
    };
  }, [directory, activated, retry]);

  useEffect(() => {
    if (!isTauri()) return;
    let frame = 0, active = true, pending = false;
    const update = () => {
      if (pending || !active) return;
      pending = true;
      void enqueue(async () => {
        pending = false;
        if (!active) return;
        const bounds = container.current?.getBoundingClientRect();
        const style = getComputedStyle(document.documentElement);
        await invoke('harness_view', { view: {
          visible: open && !obscured && ready && !!bounds?.width && !!bounds?.height,
          x: bounds?.x || 0, y: bounds?.y || 0, width: bounds?.width || 0, height: bounds?.height || 0,
          dark: style.colorScheme === 'dark',
          colors: Object.fromEntries(palette.map(key => [key, style.getPropertyValue(`--${key}`).trim()])),
        } });
      }).catch(reason => { if (active) setError(String(reason)); });
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(update); };
    const resize = new ResizeObserver(schedule);
    if (container.current) resize.observe(container.current);
    resize.observe(document.documentElement);
    const theme = new MutationObserver(schedule);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme'] });
    window.addEventListener('resize', schedule);
    schedule();
    return () => {
      active = false; cancelAnimationFrame(frame); resize.disconnect(); theme.disconnect();
      window.removeEventListener('resize', schedule);
      void enqueue(() => invoke('harness_view', { view: { visible: false, x: 0, y: 0, width: 0, height: 0, dark: false, colors: {} } })).catch(() => {});
    };
  }, [open, obscured, ready]);

  useEffect(() => {
    if (!ready || !isTauri()) return;
    let active = true;
    const timer = setInterval(() => {
      void invoke<boolean>('harness_alive').then(alive => {
        if (active && !alive) setError(t('助手已停止，请重新连接'));
      }).catch(reason => { if (active) setError(String(reason)); });
    }, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [ready]);
  const action = (action: 'new' | 'settings') => {
    void enqueue(() => invoke('harness_action', { action })).catch(reason => setError(String(reason)));
  };

  return <aside id="ai-assistant" className="ai-panel" aria-label={t('AI 助手')} hidden={!open} data-tauri-drag-region={isTauri() ? true : undefined}>
    <div className="ai-heading"><span><Sparkles size={17} />{t('AI 助手')}</span><div>
      <button className="icon-button" disabled={!ready} title={t('新建对话')} aria-label={t('新建对话')} onClick={() => action('new')}><MessageSquarePlus size={17} /></button>
      <button className="icon-button" disabled={!ready} title={t('助手设置')} aria-label={t('助手设置')} onClick={() => action('settings')}><Settings2 size={16} /></button>
      <button className="icon-button" title={t('关闭 AI 助手')} aria-label={t('关闭 AI 助手')} onClick={onClose}><X size={17} /></button>
    </div></div>
    {directory && <div className="ai-workspace" title={directory}><FolderOpen size={14} /><span>{directory.split(/[\\/]/).filter(Boolean).at(-1) || directory}</span><button disabled={!canReload} title={t('重新加载当前文稿')} aria-label={t('重新加载当前文稿')} onClick={onReload}><RefreshCw size={14} /></button></div>}
    <div className="ai-native-view" ref={container}>
      {!isTauri() ? <div className="ai-empty"><Sparkles size={26} /><h3>{t('请在桌面版使用 AI 助手')}</h3><p>{t('桌面版内置 dsh，工作区跟随打开的文件夹。')}</p></div>
        : !directory ? <div className="ai-empty"><FolderOpen size={26} /><h3>{t('为助手打开一个文件夹')}</h3><p>{t('助手将在这个工程中读取和修改文件。')}</p><button className="primary-button" onClick={onChooseFolder}>{t('打开文件夹')}</button></div>
          : error ? <div className="ai-empty" role="alert"><p className="ai-error">{error}</p><button className="primary-button" onClick={() => setRetry(value => value + 1)}>{t('重新连接')}</button></div>
            : !ready ? <div className="ai-empty" role="status"><LoaderCircle className="ai-loading" size={24} /><p>{t('正在启动助手…')}</p></div> : null}
    </div>
    {directory && <p className="ai-footnote">{t('助手使用已保存的文件。修改后可重新加载文稿。')}</p>}
  </aside>;
}
