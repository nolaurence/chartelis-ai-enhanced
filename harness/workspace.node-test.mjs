import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindWorkspace } from './chartelis-plugin.mjs';

test('binds the selected directory, refuses drift, and restores the original registry', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'chartelis-workspace-'));
  try {
    await mkdir(join(temp, 'other'));
    const workspace = { path: await realpath(temp), id: 'project' };
    const registry = {
      initializeDefault: async resolve => { assert.equal(await resolve(), workspace.path); return workspace; },
      create: async () => workspace,
      delete: async () => true,
    };
    const original = { ...registry };
    const dispose = await bindWorkspace(registry, temp);
    assert.equal(await registry.create(temp), workspace);
    assert.equal(await registry.initializeDefault(() => { throw new Error('must not choose Documents'); }), workspace);
    await assert.rejects(registry.create(join(temp, 'other')), /Chartelis/);
    await assert.rejects(registry.delete('project'), /Chartelis/);
    dispose();
    assert.deepEqual(registry, original);
    registry.initializeDefault = async () => ({ path: join(temp, 'other') });
    await assert.rejects(bindWorkspace(registry, temp), /does not match/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
