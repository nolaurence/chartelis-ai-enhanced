import { mkdir, copyFile, readFile, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const runtime = resolve(root, '.tools/dsh');
const nodeVersion = '24.13.1';
const nodeSha = 'e3be0545990c90995d7bf3a7af5d64af1f2e0fc1bbd9b79c27f7abc1e9676e50';
const hash = value => createHash('sha256').update(value).digest('hex');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('The bundled dsh runtime currently targets Windows x64.');
await mkdir(runtime, { recursive: true });
const lock = await readFile(resolve(root, 'harness/package-lock.json'));
const stamp = resolve(runtime, '.chartelis-lock');
let installed = false;
try { installed = await readFile(stamp, 'utf8') === hash(lock); await access(resolve(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js')); } catch { installed = false; }
if (!installed) {
  for (const file of ['package.json', 'package-lock.json']) await copyFile(resolve(root, 'harness', file), resolve(runtime, file));
  await new Promise((done, reject) => {
    const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm.cmd ci --omit=dev --no-audit --no-fund'], { cwd: runtime, stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? done() : reject(new Error(`npm ci failed (${code})`)));
  });
  await writeFile(stamp, hash(lock));
}
const executable = resolve(runtime, 'node.exe');
let valid = false;
try { valid = hash(await readFile(executable)) === nodeSha; } catch { /* First build. */ }
if (!valid) {
  const response = await fetch(`https://nodejs.org/dist/v${nodeVersion}/win-x64/node.exe`);
  if (!response.ok) throw new Error(`Node download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (hash(bytes) !== nodeSha) throw new Error('Node runtime checksum mismatch');
  await writeFile(executable, bytes);
}
for (const file of ['chartelis-plugin.mjs', 'cordis.patch.yml', 'theme.css']) await copyFile(resolve(root, 'harness', file), resolve(runtime, file));
// Ship the Node license along with the MIT notices in the npm dependency tree.
const license = resolve(runtime, 'NODE-LICENSE');
try { await access(license); } catch {
  const response = await fetch(`https://raw.githubusercontent.com/nodejs/node/v${nodeVersion}/LICENSE`);
  if (!response.ok) throw new Error('Could not download Node license');
  await writeFile(license, await response.text());
}
console.log(`dsh 0.2.1-rc.2 + Node ${nodeVersion} ready (Windows x64).`);
