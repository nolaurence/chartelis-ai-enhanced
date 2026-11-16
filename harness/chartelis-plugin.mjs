import { realpath } from 'node:fs/promises';
import { readFileSync } from 'node:fs';

export const name = 'chartelis-workspace';
export const inject = ['workspaceRegistry', 'webServer'];

// Use dsh's durable registry API, not its on-disk storage format.
export async function bindWorkspace(registry, directory) {
  const root = await realpath(directory);
  const create = registry.create.bind(registry);
  const workspace = await registry.initializeDefault(async () => root) ?? await create(root);
  if (workspace.path !== root) throw new Error('Chartelis workspace does not match its history directory');
  const previous = { create: registry.create, initializeDefault: registry.initializeDefault, delete: registry.delete };
  registry.initializeDefault = async () => workspace;
  registry.create = async path => {
    if (await realpath(path) !== root) throw new Error('请在 Chartelis 中打开文件夹以切换工作区 / Open a folder in Chartelis to switch workspace.');
    return workspace;
  };
  registry.delete = async () => { throw new Error('请在 Chartelis 中关闭文件夹 / Close the folder in Chartelis.'); };
  return () => Object.assign(registry, previous);
}

export async function apply(ctx) {
  const directory = process.env.CHARTELIS_WORKSPACE;
  if (!directory) throw new Error('CHARTELIS_WORKSPACE is required');
  const restore = await bindWorkspace(ctx.workspaceRegistry, directory);
  ctx.effect(() => restore);
  const css = readFileSync(new URL('./theme.css', import.meta.url), 'utf8');
  ctx.effect(() => ctx.webServer.tapIndex(html => html.replace('</head>', `<style id="chartelis-theme">${css}</style></head>`)));
}
