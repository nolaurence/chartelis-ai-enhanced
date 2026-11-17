// Real-runtime development smoke test against the system Codex CLI.
// No model/API calls: handshake, thread lifecycle and history only.
// Uses an isolated CODEX_HOME so the developer's real history is untouched.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { createInterface } from 'node:readline';

// Mirror the Rust discovery order: PATH first (.exe preferred, then .cmd/.bat),
// then well-known install locations.
function discover() {
  const names = process.platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex.bat'] : ['codex'];
  const dirs = (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean);
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (home) dirs.push(join(home, '.codex', 'bin'), join(home, '.local', 'bin'));
  if (process.platform === 'win32' && process.env.APPDATA) dirs.push(join(process.env.APPDATA, 'npm'));
  return (async () => {
    for (const dir of dirs) for (const name of names) {
      const candidate = join(dir, name);
      try { if ((await stat(candidate)).isFile()) return candidate; } catch { /* keep searching */ }
    }
    return null;
  })();
}

function launchCommand(binary) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary)) {
    // cmd.exe /s strips the outer quote pair; verbatim args avoid Node's
    // MSVCRT escaping, which cmd.exe does not understand.
    return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `""${binary}" app-server"`], verbatim: true };
  }
  return { command: binary, args: ['app-server'], verbatim: false };
}

const binary = await discover();
if (!binary) {
  console.log('codex not found on this machine; skipping the runtime smoke test.');
  process.exit(0);
}
console.log(`using ${binary}`);
const temporary = await mkdtemp(join(tmpdir(), 'chartelis-codex-smoke-'));

async function verify(project) {
  const workspace = join(temporary, project);
  const home = join(temporary, `codex-home-${project}`);
  await mkdir(workspace); await mkdir(home);
  const { command, args, verbatim } = launchCommand(binary);
  const child = spawn(command, args, {
    cwd: workspace, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    windowsVerbatimArguments: verbatim,
    env: { ...process.env, CODEX_HOME: home },
  });
  const pending = new Map();
  const notifications = [];
  let nextId = 1;
  const request = (method, params, timeout = 30_000) => new Promise((done, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, timeout);
    pending.set(id, { done: value => { clearTimeout(timer); done(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  const reader = createInterface({ input: child.stdout });
  reader.on('line', line => {
    if (!line.trim()) return;
    let frame;
    try { frame = JSON.parse(line); } catch { return; }
    if (frame.id !== undefined && frame.method === undefined) {
      const entry = pending.get(frame.id);
      if (!entry) return;
      pending.delete(frame.id);
      if (frame.error) entry.reject(new Error(`${frame.error.message ?? 'error'} (${frame.error.code})`));
      else entry.done(frame.result);
    } else if (frame.method) {
      notifications.push(frame);
    }
  });
  const stderrLines = [];
  const stderrReader = createInterface({ input: child.stderr });
  stderrReader.on('line', line => { stderrLines.push(line); if (stderrLines.length > 40) stderrLines.shift(); });
  try {
    const initialized = await request('initialize', {
      clientInfo: { name: 'chartelis-smoke', title: 'Chartelis smoke', version: '0.0.0' },
      capabilities: { experimentalApi: true, optOutNotificationMethods: ['turn/diff/updated'] },
    });
    assert.ok(initialized.userAgent, 'initialize returns userAgent');
    assert.ok(initialized.codexHome, 'initialize returns codexHome');
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');

    const account = await request('account/read', {});
    console.log(`${project}: auth ${account.account ? account.account.type : 'none'} (requiresOpenaiAuth=${account.requiresOpenaiAuth})`);

    const started = await request('thread/start', { cwd: workspace });
    assert.ok(started.thread?.id, 'thread/start returns a thread id');
    assert.equal(started.cwd, workspace);
    assert.ok(started.sandbox, 'thread/start reports the sandbox policy');
    assert.ok(started.approvalPolicy, 'thread/start reports the approval policy');
    const threadId = started.thread.id;

    // Empty threads live in memory only; codex persists them with the first
    // turn. The list must answer, but need not contain the new thread yet.
    const listed = await request('thread/list', { cwd: workspace, limit: 10 });
    assert.ok(Array.isArray(listed.data), 'thread/list answers for the workspace');

    const read = await request('thread/read', { threadId, includeTurns: false });
    assert.equal(read.thread.id, threadId);

    // Empty threads are not persisted until the first turn, so resume may
    // legitimately report "no rollout found". Persisted threads must resume.
    let resumed = null;
    try {
      resumed = await request('thread/resume', { threadId, excludeTurns: true });
      assert.equal(resumed.thread.id, threadId);
    } catch (error) {
      if (!/no rollout found/i.test(error.message)) throw error;
      console.log(`${project}: empty thread has no rollout yet (expected)`);
    }
    if (resumed) {
      // History reads are dual-mode, exactly like t3code: legacy threads use
      // thread/read, paginated threads use thread/turns/list. Some builds
      // (e.g. 0.167.x) stub the paginated API; the editor then falls back to
      // the rollout file, so accept that answer here too.
      const historyMode = resumed.thread.historyMode ?? started.thread.historyMode;
      try {
        if (historyMode === 'paginated') {
          const turns = await request('thread/turns/list', { threadId, limit: 50, sortDirection: 'asc', itemsView: 'full' });
          assert.ok(Array.isArray(turns.data), 'thread/turns/list paginates history');
        } else {
          const full = await request('thread/read', { threadId, includeTurns: true });
          assert.ok(Array.isArray(full.thread.turns), 'thread/read returns legacy turns');
        }
      } catch (error) {
        if (!/not supported/i.test(error.message)) throw error;
        const { readFile } = await import('node:fs/promises');
        const text = await readFile(resumed.thread.path ?? started.thread.path, 'utf8');
        const entries = text.split('\n').filter(Boolean).map(line => JSON.parse(line));
        assert.ok(entries.some(entry => entry.type === 'session_meta'), 'rollout fallback has session meta');
      }
      console.log(`${project}: historyMode=${historyMode}`);
    }

    const models = await request('model/list', { limit: 50 });
    assert.ok(Array.isArray(models.data), 'model/list returns a catalog');

    assert.deepEqual(await readdir(workspace), [], 'codex writes no state into the project directory');
    console.log(`${project}: handshake, thread lifecycle, history and model catalog OK (${notifications.length} notifications)`);
  } catch (error) {
    error.message += `\nstderr tail:\n${stderrLines.join('\n')}`;
    throw error;
  } finally {
    reader.close(); stderrReader.close();
    if (child.exitCode === null) {
      const stopped = once(child, 'exit');
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        await once(killer, 'exit');
      } else {
        child.kill('SIGKILL');
      }
      await stopped;
    }
  }
}
try {
  await verify('project-a'); await verify('工程-b');
} finally {
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir()));
  await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
}
