// Antigravity: `agy plugin install` from the stable copy's Codex plugin folder (it reads the portable plugin.json). `agy` follows
// HOME and copies the plugin when it is installed, so a refresh means installing again.
import { join } from 'node:path';
import { pluginName } from './apps.mjs';
import { commandFailure, readJson } from './plugin-support.mjs';

const pluginFolder = ctx => join(ctx.copyDirectory, 'codex', 'opendoc');

async function readState(ctx, labelSuffix = '') {
  const plugins = await readJson(ctx, `List the plugins Antigravity has installed${labelSuffix}`, ['plugin', 'list', '--json']);
  if (!plugins.ok) return { failure: plugins.result };
  if (!Array.isArray(plugins.value)) { ctx.failLastStep('The list was not an array.'); return { failure: plugins.result }; }
  return { plugin: plugins.value.find(entry => entry?.name === pluginName) ?? null };
}

export async function install(ctx) {
  const state = await readState(ctx);
  if (state.failure) return { ...commandFailure(ctx, state.failure, 'Antigravity would not list its plugins'), leftBehind: false };
  // Antigravity keeps no record of where a plugin came from. A plugin of this name that the manifest does not know is not ours.
  if (state.plugin && !ctx.wasConnected) {
    return { ok: true, code: 'already-present', changed: false, summary: `A plugin called ${pluginName} is already installed in Antigravity, not by this app. It was left as it is.` };
  }
  const installed = await ctx.exec(state.plugin ? 'Install the plugin again (replaces the installed copy)' : 'Install the plugin', ['plugin', 'install', pluginFolder(ctx)]);
  if (!installed.ok) return { ...commandFailure(ctx, installed, 'Antigravity would not install the plugin'), leftBehind: Boolean(state.plugin) };
  ctx.record.plugin = { name: pluginName };
  await ctx.save();

  const after = await readState(ctx, ' (check)');
  if (after.failure) return rollBack(ctx, commandFailure(ctx, after.failure, 'The result could not be checked'));
  if (!after.plugin) return rollBack(ctx, { ok: false, code: 'verify-failed', summary: 'Antigravity does not list the plugin after installing it.' });
  if (after.plugin.enabled === false) return rollBack(ctx, { ok: false, code: 'verify-failed', summary: 'Antigravity installed the plugin but it is switched off.' });
  ctx.record.plugin = { name: pluginName, version: after.plugin.version ?? null, installedAt: after.plugin.path ?? null };
  await ctx.save();
  return { ok: true, code: 'connected', changed: true, summary: `Installed ${pluginName} in Antigravity${after.plugin.version ? ` (version ${after.plugin.version})` : ''}.` };
}

async function rollBack(ctx, failure) {
  ctx.prefix = 'Undo: ';
  const undone = await uninstall(ctx, ctx.record);
  ctx.prefix = '';
  return { ...failure, leftBehind: !undone.ok, undone: undone.ok, summary: undone.ok ? `${failure.summary} Everything that had been added was removed again.` : `${failure.summary} Removing what had been added also failed: ${undone.summary}` };
}

export async function uninstall(ctx, record) {
  const state = await readState(ctx);
  if (state.failure) return { ...commandFailure(ctx, state.failure, 'Antigravity would not list its plugins'), leftBehind: true };
  if (record.plugin) {
    if (!state.plugin) ctx.note('Uninstall the plugin', 'Already gone.');
    else {
      const removed = await ctx.exec('Uninstall the plugin', ['plugin', 'uninstall', pluginName]);
      if (!removed.ok) return { ...commandFailure(ctx, removed, 'Antigravity would not uninstall the plugin'), leftBehind: true };
    }
  }
  const after = await readState(ctx, ' (check)');
  if (after.failure) return { ...commandFailure(ctx, after.failure, 'The result could not be checked'), leftBehind: true };
  if (record.plugin && after.plugin) return { ok: false, code: 'verify-failed', leftBehind: true, summary: 'Antigravity still lists OpenDoc after the removal.' };
  return { ok: true, code: 'disconnected', changed: true, summary: 'Removed the OpenDoc plugin from Antigravity.' };
}

export async function check(ctx) {
  const state = await readState(ctx);
  if (state.failure) return { connected: null, summary: `Antigravity would not list its plugins: ${state.failure.output.split('\n')[0] || state.failure.spawnError || 'no output'}` };
  if (!state.plugin) return { connected: false, summary: 'OpenDoc is not installed in Antigravity.' };
  if (state.plugin.enabled === false) return { connected: false, own: ctx.wasConnected, summary: 'OpenDoc is installed in Antigravity but switched off.' };
  return { connected: true, own: ctx.wasConnected, summary: `Installed and enabled${state.plugin.version ? ` (version ${state.plugin.version})` : ''}${ctx.wasConnected ? '' : ', not by this app'}.` };
}
