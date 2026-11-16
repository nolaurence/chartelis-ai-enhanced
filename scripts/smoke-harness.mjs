// Real-runtime development smoke test. No browser automation or model/API calls.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, realpath, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { createInterface } from 'node:readline';

const runtime = resolve(import.meta.dirname, '../.tools/dsh');
const temporary = await mkdtemp(join(tmpdir(), 'chartelis-dsh-smoke-'));
async function verify(project) {
  const workspace = join(temporary, project);
  const home = join(temporary, `state-${project}`);
  await mkdir(workspace); await mkdir(home);
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(done => reservation.close(done));
  const child = spawn(join(runtime, 'node.exe'), [join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'web', '--patch', join(runtime, 'cordis.patch.yml'), '--no-open', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', DSH_HOME: home, CHARTELIS_WORKSPACE: workspace, CHARTELIS_LANGUAGE: 'zh-CN', DSH_TELEMETRY_DISABLED: '1' },
  });
  const readers = [child.stdout, child.stderr].map(input => createInterface({ input }));
  try {
    const url = await new Promise((done, reject) => {
      const timeout = setTimeout(() => reject(new Error('dsh startup timeout')), 60_000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`dsh exited before readiness (${code})`)); });
      for (const reader of readers) reader.on('line', line => {
        const match = line.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/);
        if (match) { clearTimeout(timeout); done(match[1]); }
      });
    });
    const origin = new URL(url).origin;
    assert.equal((await fetch(origin)).status, 401, 'unauthenticated index stays private');
    const login = await fetch(url, { redirect: 'manual' });
    assert.equal(login.status, 303);
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const page = await fetch(origin, { headers: { cookie: cookie.split(';')[0] } });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /id="chartelis-theme"/);
    assert.match(html, /grid-template-columns: minmax\(0, 1fr\) !important/);
    assert.match(html, /data-rightbar-col/);
    const asset = html.match(/<script[^>]+src="([^"]+assets\/index-[^"]+\.js)"/);
    assert.ok(asset, 'original dsh frontend is served');
    assert.equal((await fetch(new URL(asset[1], origin))).status, 200);
    const registry = JSON.parse(await readFile(join(home, 'storages/workspace.json'), 'utf8'));
    const records = Object.values(registry.tables.workspaces);
    assert.equal(records.length, 1);
    assert.equal(records[0].path, await realpath(workspace));
    assert.deepEqual(await readdir(workspace), [], 'integration state stays outside the project');
    console.log(`${project}: startup, authenticated frontend, conversation-only CSS, workspace binding OK`);
  } finally {
    for (const reader of readers) reader.close();
    if (child.exitCode === null) {
      const stopped = once(child, 'exit');
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      await once(killer, 'exit'); await stopped;
    }
  }
}
try {
  await verify('project-a'); await verify('工程-b');
} finally {
  assert.equal(dirname(resolve(temporary)), resolve(tmpdir()));
  await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
}
