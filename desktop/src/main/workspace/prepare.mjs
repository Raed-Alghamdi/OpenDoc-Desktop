// Everything between taking the workspace lock and starting the service host (plan 3.4, E3): is this a workspace the app can
// take, adopting a synced one, the `node_modules` and `.claude/skills` links, the version table, the upgrade. It asks the
// user through `ui` (the shell supplies Electron dialogs and pages; the tests supply fakes) and changes nothing before every
// question is answered and every refusal is decided: a refusal or a "no" leaves the folder as it was.
import { ensureModulesLink, ensureSkillsLink, inspectModules } from './links.mjs';
import { adoptWorkspace, markManaged, readMarker } from './marker.mjs';
import { readManifest, writePin } from './pin.mjs';
import { restoreBackup } from './backup.mjs';
import { agentPrompt, runUpgrade } from './upgrade.mjs';
import { decideVersion, declinedUpgradeMessage, readPin, restoredBackupMessage } from './versions.mjs';

const unsupportedSuffix = ' Opening a workspace read-only needs a newer OpenDoc service than the one in this app, so it was not opened.';

/**
 * @param options.root the workspace folder (real path)
 * @param options.runtime { version, edition, workspaceFormat } from readRuntimeInfo
 * @param options.wanted { path } what node_modules must link to
 * @param options.exact true when the link must name `wanted.path` itself (the AppImage's `current` link)
 * @param options.readOnlySupport whether the runtime's service can open read-only (runtime-info.mjs)
 * @param options.upgradeWithoutAsking the config key
 * @param options.created the folder was made by this app moments ago: a real node_modules in it is ours and is replaced without asking
 * @param options.replaceReal(path) removes a real node_modules (the shell moves it to the trash)
 * @param options.runCli(args, { cwd }) the app's CLI
 * @param options.ui { askAdopt(root), askRealModules(root, kind), askUpgrade({ root, from, to }), remember(), progress(text), showResult(info) }
 * @returns { ok: true, readOnly, notes } | { ok: false, code, message, path } | { ok: false, canceled: true }
 */
export async function prepareWorkspace(options) {
  const { root, runtime, wanted, exact = false, readOnlySupport, upgradeWithoutAsking = false, created = false, replaceReal, runCli, ui, dataDir, registry, log = () => {}, signal, now, free, runStep } = options;
  const fail = (code, message) => ({ ok: false, code, message, path: root });
  const canceled = { ok: false, canceled: true };

  // ---- what is this folder? (reads only)
  const marker = await readMarker(root);
  if (marker.state === 'invalid') return fail('bad-marker', marker.message);
  let loaded;
  try { loaded = await readManifest(root); } catch (error) { return fail('bad-package', error.message); }
  const pin = loaded ? readPin(loaded.manifest) : null;
  if (marker.state === 'none') {
    if (pin?.code === 'headless') return fail('headless', pin.message);
    if (!pin?.ok) return fail('not-a-workspace', `${root} is not an OpenDoc workspace. A workspace has a package.json that pins OpenDoc and, on this device, a .opendoc/workspace.json file; create a new one instead.`);
  } else {
    if (marker.marker.formatVersion !== runtime.workspaceFormat) return fail('unsupported-format', `Unsupported OpenDoc workspace format ${marker.marker.formatVersion ?? '(missing)'}. This app supports format ${runtime.workspaceFormat}. Nothing was changed.`);
    if (marker.marker.edition !== undefined && marker.marker.edition !== runtime.edition) return fail('headless', `This workspace is of the ${marker.marker.edition} edition of OpenDoc, and opendoc-desktop opens workspaces of the ${runtime.edition} edition only. Edition switching is not an update, so nothing was changed.`);
    if (!loaded) return fail('no-package', `${root} has no package.json, so the app cannot tell which OpenDoc version the workspace is on. Nothing was changed.`);
    if (!pin.ok) return fail(pin.code, pin.message);
  }
  const decision = decideVersion(pin.version, runtime.version);
  let readOnly = null;
  if (decision.kind === 'readonly') {
    if (!readOnlySupport) return fail('read-only-unsupported', decision.message + unsupportedSuffix);
    readOnly = { reason: decision.reason, message: decision.message };
  }

  // ---- questions
  const adopt = marker.state === 'none';
  if (adopt && !(await ui.askAdopt(root))) return canceled;
  const modules = await inspectModules(root, wanted, { exact });
  if (modules.state === 'real' && !created && !(await ui.askRealModules(root, modules.kind))) {
    return fail('modules-kept', `The ${modules.kind === 'file' ? 'file' : 'folder'} node_modules in this workspace was left as it is, so the workspace was not opened. Opening it needs node_modules to be a link to the app's OpenDoc.`);
  }
  let upgrade = false;
  let remember = false;
  if (decision.kind === 'upgrade') {
    if (upgradeWithoutAsking) upgrade = true;
    else {
      const answer = await ui.askUpgrade({ root, from: decision.from, to: decision.to });
      if (answer.choice === 'cancel') return canceled;
      if (answer.choice === 'upgrade') { upgrade = true; remember = Boolean(answer.remember); }
      else {
        if (!readOnlySupport) return fail('read-only-unsupported', declinedUpgradeMessage(decision.from, decision.to) + unsupportedSuffix);
        readOnly = { reason: 'declined-upgrade', message: declinedUpgradeMessage(decision.from, decision.to) };
      }
    }
  }
  if (signal?.aborted) return canceled;

  // ---- changes (every refusal is behind us)
  await ensureModulesLink(root, wanted, { exact, replaceReal });
  if (adopt) await adoptWorkspace(root, { formatVersion: runtime.workspaceFormat, edition: runtime.edition });
  else await markManaged(root);
  try { await ensureSkillsLink(root); } catch (error) { log(`could not repair .claude/skills: ${error.message}`); }
  const notes = [];

  if (decision.kind === 'open' && decision.movePin) {
    try { await writePin(root, runtime.version, runtime.edition); }
    catch (error) { return fail('pin-failed', `The workspace's OpenDoc version could not be moved up to ${runtime.version}: ${error.message}`); }
  }

  if (upgrade) {
    if (remember) await ui.remember?.();
    const result = await runUpgrade({ root, from: decision.from, to: decision.to, edition: runtime.edition, dataDir, runCli: (args, opts) => runCli(args, { ...opts, signal }), registry, progress: text => ui.progress?.(text), now, free, runStep, signal });
    ui.progress?.(null);
    if (result.stage === 'backup') return fail('backup-failed', result.message);
    if (result.stage === 'canceled') return canceled;
    const backup = result.backup && { name: result.backup.name, directory: result.backup.directory };
    if (!result.ok) {
      const canOpen = result.stage === 'done';
      const answer = await ui.showResult({ root, from: decision.from, to: decision.to, backup, failures: result.failures, stage: result.stage, message: result.message, prompt: agentPrompt({ root, to: decision.to, failures: result.failures }), canOpen });
      if (answer.action === 'restore') {
        let restored;
        try { restored = await restoreBackup({ root, dataDir, name: result.backup.name, now }); }
        catch (error) { return fail('restore-failed', error.message); }
        const message = restoredBackupMessage(decision.from);
        const where = `The files that were in the workspace just before are in ${restored.before.directory}.`;
        if (!readOnlySupport) return fail('restored', `${message} ${where}${unsupportedSuffix}`);
        readOnly = { reason: 'restored-backup', message };
        notes.push({ title: 'Backup restored', message: `${message}`, detail: where });
      } else if (answer.action !== 'open' || !canOpen) return canceled;
    } else {
      notes.push({ title: 'Workspace upgraded', message: `This workspace is now on OpenDoc ${decision.to}. Every document was checked and reviewed.`, detail: `A copy of how it was before is in ${backup.directory}.\n\nTo go back to it later: close this workspace, open Workspace Backups… in the File menu, choose Reveal, and copy the files in its "workspace" folder over the workspace folder. Backups are never deleted by the app.` });
    }
    if (!result.ok && result.stage === 'done' && !readOnly) notes.push({ title: 'Backup', message: 'A copy of the workspace as it was before the upgrade is kept.', detail: `${backup.directory}\n\nOpen Workspace Backups… in the File menu to find it.` });
  }
  return { ok: true, readOnly, notes, adopted: adopt, upgraded: upgrade };
}
