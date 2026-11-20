// Codex: a marketplace added from the stable copy's `codex` folder, then the plugin `opendoc@opendoc`. Codex copies the plugin into
// its own cache when it is added, so refreshing the stable copy means adding the plugin again (the re-add re-copies it).
import { join } from 'node:path';
import { marketplaceName, pluginId } from './apps.mjs';
import { isInside, sameFolder } from './files.mjs';
import { commandFailure, readJson, removeEmptyFolders } from './plugin-support.mjs';

const marketplaceFolder = ctx => join(ctx.copyDirectory, 'codex');

async function readState(ctx, labelSuffix = '') {
  const marketplaces = await readJson(ctx, `List the marketplaces Codex knows${labelSuffix}`, ['plugin', 'marketplace', 'list', '--json']);
  if (!marketplaces.ok) return { failure: marketplaces.result };
  const plugins = await readJson(ctx, `List the plugins Codex has installed${labelSuffix}`, ['plugin', 'list', '--json']);
  if (!plugins.ok) return { failure: plugins.result };
  if (!Array.isArray(marketplaces.value?.marketplaces) || !Array.isArray(plugins.value?.installed)) {
    ctx.failLastStep('The list had an unexpected shape.');
    return { failure: plugins.result };
  }
  return {
    marketplace: marketplaces.value.marketplaces.find(entry => entry?.name === marketplaceName) ?? null,
    plugin: plugins.value.installed.find(entry => entry?.pluginId === pluginId) ?? null,
  };
}

const pluginSource = plugin => plugin?.source?.path ?? null;
const fromStableCopy = async (copyDirectory, plugin) => Boolean(plugin) && (await isInside(pluginSource(plugin), copyDirectory));

export async function install(ctx) {
  const state = await readState(ctx);
  if (state.failure) return { ...commandFailure(ctx, state.failure, 'Codex would not list its plugins'), leftBehind: false };
  const folder = marketplaceFolder(ctx);
  if (state.plugin && !(await fromStableCopy(ctx.copyDirectory, state.plugin))) {
    return { ok: true, code: 'already-present', changed: false, summary: `OpenDoc is already installed in Codex, from ${pluginSource(state.plugin) ?? 'another place'}, not from this app. It was left as it is.` };
  }
  if (state.marketplace && !(await sameFolder(state.marketplace.root ?? '', folder))) {
    return { ok: false, code: 'conflict', leftBehind: false, summary: `Codex already has a marketplace called ${marketplaceName} that points at ${state.marketplace.root ?? 'something else'}. It was not changed.` };
  }

  if (state.marketplace) {
    ctx.note('Add the marketplace', `Already registered from ${folder}.`);
  } else {
    const added = await ctx.exec('Add the marketplace', ['plugin', 'marketplace', 'add', folder]);
    if (!added.ok) return { ...commandFailure(ctx, added, 'Codex would not add the marketplace'), leftBehind: false };
  }
  ctx.record.marketplace = { name: marketplaceName, path: folder };
  await ctx.save();

  // Run even when the plugin is already ours: adding it again copies the current files (this is also how a refresh works).
  const installed = await ctx.exec('Install the plugin', ['plugin', 'add', pluginId]);
  if (!installed.ok) return rollBack(ctx, commandFailure(ctx, installed, 'Codex would not install the plugin'), Boolean(state.plugin));
  ctx.record.plugin = { id: pluginId };
  await ctx.save();

  const after = await readState(ctx, ' (check)');
  if (after.failure) return rollBack(ctx, commandFailure(ctx, after.failure, 'The result could not be checked'));
  if (!after.plugin || !(await fromStableCopy(ctx.copyDirectory, after.plugin))) return rollBack(ctx, { ok: false, code: 'verify-failed', summary: 'Codex does not list the plugin as installed from this app\'s copy.' });
  if (after.plugin.enabled === false) return rollBack(ctx, { ok: false, code: 'verify-failed', summary: 'Codex installed the plugin but it is switched off.' });
  ctx.record.plugin = { id: pluginId, version: after.plugin.version ?? null };
  await ctx.save();
  return { ok: true, code: 'connected', changed: true, summary: `Installed ${pluginId} in Codex${after.plugin.version ? ` (version ${after.plugin.version})` : ''}.` };
}

async function rollBack(ctx, failure, keepPlugin = false) {
  if (keepPlugin) return { ...failure, leftBehind: true, summary: `${failure.summary} The plugin that was already there was left in place.` };
  ctx.prefix = 'Undo: ';
  const undone = await uninstall(ctx, ctx.record);
  ctx.prefix = '';
  return { ...failure, leftBehind: !undone.ok, undone: undone.ok, summary: undone.ok ? `${failure.summary} Everything that had been added was removed again.` : `${failure.summary} Removing what had been added also failed: ${undone.summary}` };
}

export async function uninstall(ctx, record) {
  const state = await readState(ctx);
  if (state.failure) return { ...commandFailure(ctx, state.failure, 'Codex would not list its plugins'), leftBehind: true };

  if (record.plugin) {
    if (!state.plugin) ctx.note('Uninstall the plugin', 'Already gone.');
    else if (!(await fromStableCopy(record.copyPath, state.plugin))) ctx.note('Uninstall the plugin', `Left alone: it is now installed from ${pluginSource(state.plugin) ?? 'another place'}, not from this app's copy.`);
    else {
      const removed = await ctx.exec('Uninstall the plugin', ['plugin', 'remove', pluginId]);
      if (!removed.ok) return { ...commandFailure(ctx, removed, 'Codex would not uninstall the plugin'), leftBehind: true };
    }
  }
  if (record.marketplace) {
    if (!state.marketplace) ctx.note('Remove the marketplace', 'Already gone.');
    else if (!(await sameFolder(state.marketplace.root ?? '', record.marketplace.path))) ctx.note('Remove the marketplace', `Left alone: it now points at ${state.marketplace.root ?? 'something else'}.`);
    else {
      const removed = await ctx.exec('Remove the marketplace', ['plugin', 'marketplace', 'remove', marketplaceName]);
      if (!removed.ok) return { ...commandFailure(ctx, removed, 'Codex would not remove the marketplace'), leftBehind: true };
    }
  }

  const after = await readState(ctx, ' (check)');
  if (after.failure) return { ...commandFailure(ctx, after.failure, 'The result could not be checked'), leftBehind: true };
  const stillPlugin = record.plugin && after.plugin && (await fromStableCopy(record.copyPath, after.plugin));
  const stillMarketplace = record.marketplace && after.marketplace && (await sameFolder(after.marketplace.root ?? '', record.marketplace.path));
  if (stillPlugin || stillMarketplace) return { ok: false, code: 'verify-failed', leftBehind: true, summary: 'Codex still lists OpenDoc after the removal.' };

  // `plugin remove` empties Codex's cache for the plugin but leaves the two folders around it.
  const cache = join(record.configFolder, 'plugins', 'cache', marketplaceName);
  const removed = await removeEmptyFolders([join(cache, 'opendoc'), cache]);
  if (removed.length) ctx.note('Remove the empty cache folders', `Removed ${removed.join(' and ')}.`);
  return { ok: true, code: 'disconnected', changed: true, summary: 'Removed the OpenDoc plugin and marketplace from Codex.' };
}

export async function check(ctx) {
  const state = await readState(ctx);
  if (state.failure) return { connected: null, summary: `Codex would not list its plugins: ${state.failure.output.split('\n')[0] || state.failure.spawnError || 'no output'}` };
  if (!state.plugin) return { connected: false, summary: 'OpenDoc is not installed in Codex.' };
  const own = await fromStableCopy(ctx.copyDirectory, state.plugin);
  if (state.plugin.enabled === false) return { connected: false, own, summary: 'OpenDoc is installed in Codex but switched off.' };
  return { connected: true, own, summary: own ? `Installed and enabled (${pluginId}${state.plugin.version ? `, version ${state.plugin.version}` : ''}).` : `Installed and enabled, from ${pluginSource(state.plugin) ?? 'another place'}, not from this app.` };
}
