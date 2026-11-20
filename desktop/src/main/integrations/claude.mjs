// Claude Code: a marketplace added from the stable copy's `claude` folder, then the plugin `opendoc@opendoc` from it. Claude Code
// reads the plugin in place (`readFromFolder` in `plugin list --json`), so refreshing the copy needs no reinstall.
import { rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { marketplaceName, pluginId } from './apps.mjs';
import { isInside, sameFolder } from './files.mjs';
import { commandFailure, readJson, removeEmptyFolders } from './plugin-support.mjs';

const marketplaceFolder = ctx => join(ctx.copyDirectory, 'claude');

/** The marketplace and the plugin as Claude Code lists them (`null` for either that is not there). */
async function readState(ctx, labelSuffix = '') {
  const marketplaces = await readJson(ctx, `List the marketplaces Claude Code knows${labelSuffix}`, ['plugin', 'marketplace', 'list', '--json']);
  if (!marketplaces.ok) return { failure: marketplaces.result };
  const plugins = await readJson(ctx, `List the plugins Claude Code has installed${labelSuffix}`, ['plugin', 'list', '--json']);
  if (!plugins.ok) return { failure: plugins.result };
  if (!Array.isArray(marketplaces.value) || !Array.isArray(plugins.value)) {
    ctx.failLastStep('The list was not an array.');
    return { failure: plugins.result };
  }
  return {
    marketplace: marketplaces.value.find(entry => entry?.name === marketplaceName) ?? null,
    plugin: plugins.value.find(entry => entry?.id === pluginId) ?? null,
  };
}

const marketplaceSource = entry => entry?.path ?? entry?.installLocation ?? null;
const fromStableCopy = async (ctx, plugin) => Boolean(plugin) && (await isInside(plugin.readFromFolder, ctx.copyDirectory));

export async function install(ctx) {
  const state = await readState(ctx);
  if (state.failure) return { ...commandFailure(ctx, state.failure, 'Claude Code would not list its plugins'), leftBehind: false };
  const folder = marketplaceFolder(ctx);
  if (state.plugin && !(await fromStableCopy(ctx, state.plugin))) {
    return { ok: true, code: 'already-present', changed: false, summary: `OpenDoc is already installed in Claude Code, from ${state.plugin.readFromFolder ?? 'another place'}, not from this app. It was left as it is.` };
  }
  if (state.marketplace && !(await sameFolder(marketplaceSource(state.marketplace) ?? '', folder))) {
    return { ok: false, code: 'conflict', leftBehind: false, summary: `Claude Code already has a marketplace called ${marketplaceName} that points at ${marketplaceSource(state.marketplace) ?? 'something else'}. It was not changed.` };
  }

  if (state.marketplace) {
    ctx.note('Add the marketplace', `Already registered from ${folder}.`);
  } else {
    const added = await ctx.exec('Add the marketplace', ['plugin', 'marketplace', 'add', folder]);
    if (!added.ok) return { ...commandFailure(ctx, added, 'Claude Code would not add the marketplace'), leftBehind: false };
  }
  ctx.record.marketplace = { name: marketplaceName, path: folder };
  await ctx.save();

  if (state.plugin) {
    ctx.note('Install the plugin', `${pluginId} is already installed from this app's copy.`);
  } else {
    const installed = await ctx.exec('Install the plugin', ['plugin', 'install', pluginId]);
    if (!installed.ok) return rollBack(ctx, commandFailure(ctx, installed, 'Claude Code would not install the plugin'));
  }
  ctx.record.plugin = { id: pluginId };
  await ctx.save();

  const after = await readState(ctx, ' (check)');
  if (after.failure) return rollBack(ctx, commandFailure(ctx, after.failure, 'The result could not be checked'));
  if (!after.plugin || !(await fromStableCopy(ctx, after.plugin))) return rollBack(ctx, { ok: false, code: 'verify-failed', summary: 'Claude Code does not list the plugin as installed from this app\'s copy.' });
  if (after.plugin.enabled === false) return rollBack(ctx, { ok: false, code: 'verify-failed', summary: 'Claude Code installed the plugin but it is switched off.' });
  ctx.record.plugin = { id: pluginId, version: after.plugin.version ?? null, installPath: after.plugin.installPath ?? null };
  await ctx.save();
  return { ok: true, code: 'connected', changed: true, summary: `Installed ${pluginId} in Claude Code${after.plugin.version ? ` (version ${after.plugin.version})` : ''}.` };
}

/** A failed install is undone from the record, so nothing half-done stays in the user's Claude Code. */
async function rollBack(ctx, failure) {
  ctx.prefix = 'Undo: ';
  const undone = await uninstall(ctx, ctx.record);
  ctx.prefix = '';
  return { ...failure, leftBehind: !undone.ok, undone: undone.ok, summary: undone.ok ? `${failure.summary} Everything that had been added was removed again.` : `${failure.summary} Removing what had been added also failed: ${undone.summary}` };
}

export async function uninstall(ctx, record) {
  const state = await readState(ctx);
  if (state.failure) return { ...commandFailure(ctx, state.failure, 'Claude Code would not list its plugins'), leftBehind: true };

  if (record.plugin) {
    if (!state.plugin) ctx.note('Uninstall the plugin', 'Already gone.');
    else if (!(await fromStableCopy({ copyDirectory: record.copyPath }, state.plugin))) ctx.note('Uninstall the plugin', `Left alone: it is now installed from ${state.plugin.readFromFolder ?? 'another place'}, not from this app's copy.`);
    else {
      const removed = await ctx.exec('Uninstall the plugin', ['plugin', 'uninstall', pluginId]);
      if (!removed.ok) return { ...commandFailure(ctx, removed, 'Claude Code would not uninstall the plugin'), leftBehind: true };
    }
  }
  if (record.marketplace) {
    if (!state.marketplace) ctx.note('Remove the marketplace', 'Already gone.');
    else if (!(await sameFolder(marketplaceSource(state.marketplace) ?? '', record.marketplace.path))) ctx.note('Remove the marketplace', `Left alone: it now points at ${marketplaceSource(state.marketplace) ?? 'something else'}.`);
    else {
      const removed = await ctx.exec('Remove the marketplace', ['plugin', 'marketplace', 'remove', marketplaceName]);
      if (!removed.ok) return { ...commandFailure(ctx, removed, 'Claude Code would not remove the marketplace'), leftBehind: true };
    }
  }

  const after = await readState(ctx, ' (check)');
  if (after.failure) return { ...commandFailure(ctx, after.failure, 'The result could not be checked'), leftBehind: true };
  const stillPlugin = record.plugin && after.plugin && (await fromStableCopy({ copyDirectory: record.copyPath }, after.plugin));
  const stillMarketplace = record.marketplace && after.marketplace && (await sameFolder(marketplaceSource(after.marketplace) ?? '', record.marketplace.path));
  if (stillPlugin || stillMarketplace) return { ok: false, code: 'verify-failed', leftBehind: true, summary: 'Claude Code still lists OpenDoc after the removal.' };

  await removeKeptCopy(ctx, record);
  return { ok: true, code: 'disconnected', changed: true, summary: 'Removed the OpenDoc plugin and marketplace from Claude Code.' };
}

// `plugin uninstall` leaves the plugin's cache folder behind and marks it unused (`.orphaned_at`); Claude Code deletes it itself
// after a while. Undo removes exactly the folder `plugin list --json` named at connect time, and only when it sits under this
// config folder's plugin cache for our marketplace and carries that marker.
async function removeKeptCopy(ctx, record) {
  const installPath = record.plugin?.installPath;
  const cache = join(record.configFolder, 'plugins', 'cache', marketplaceName);
  if (!installPath || !(await isInside(installPath, cache)) || (await sameFolder(installPath, cache))) return;
  try { await stat(join(installPath, '.orphaned_at')); } catch { return; }
  await rm(installPath, { recursive: true, force: true });
  // The plugin's and the marketplace's folders in the cache, when that left them empty.
  const parents = [dirname(installPath), dirname(dirname(installPath))];
  await removeEmptyFolders(await filterAsync(parents, async folder => (await isInside(folder, cache)) && !(await sameFolder(folder, dirname(cache)))));
  ctx.note('Remove the unused plugin copy', `Deleted ${installPath}, which Claude Code had marked unused.`);
}

const filterAsync = async (list, test) => { const out = []; for (const item of list) if (await test(item)) out.push(item); return out; };

export async function check(ctx) {
  const state = await readState(ctx);
  if (state.failure) return { connected: null, summary: `Claude Code would not list its plugins: ${state.failure.output.split('\n')[0] || state.failure.spawnError || 'no output'}` };
  if (!state.plugin) return { connected: false, summary: 'OpenDoc is not installed in Claude Code.' };
  const own = await fromStableCopy(ctx, state.plugin);
  if (state.plugin.enabled === false) return { connected: false, own, summary: 'OpenDoc is installed in Claude Code but switched off.' };
  return { connected: true, own, summary: own ? `Installed and enabled (${pluginId}${state.plugin.version ? `, version ${state.plugin.version}` : ''}).` : `Installed and enabled, from ${state.plugin.readFromFolder ?? 'another place'}, not from this app.` };
}
