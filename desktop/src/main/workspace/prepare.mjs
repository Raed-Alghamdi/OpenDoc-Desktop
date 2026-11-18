// Everything between taking the workspace lock and starting the service host (plan 3.4, E3): is this a workspace the app can
// take, adopting a synced one, the `node_modules` and `.claude/skills` links, the version table, the upgrade. It asks the
// user through `ui` (the shell supplies Electron dialogs and pages; the tests supply fakes) and changes nothing before every
// question is answered and every refusal is decided: a refusal or a "no" leaves the folder as it was. A workspace that will
// open read-only is not written to at all, except for the `node_modules` link it cannot run without.
import { ensureModulesLink, ensureSkillsLink, inspectModules } from './links.mjs';
import { adoptWorkspace, markManaged, readMarker, setFormatVersion } from './marker.mjs';
import { readManifest, writePin } from './pin.mjs';
import { backupManifest, recoverRestore, restoreBackup } from './backup.mjs';
import { cleanStaleTemps } from './temps.mjs';
import { agentPrompt, clearPending, readPending, runChecks, runUpgrade } from './upgrade.mjs';
import { compareFormat, decideVersion, declinedUpgradeMessage, newerFormatMessage, readPin, restoredBackupMessage } from './versions.mjs';

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
  const notes = [];

  // ---- leftovers of a crash (these put back what the app itself had changed or left behind)
  await cleanStaleTemps(root);
  try {
    const recovered = await recoverRestore({ root });
    if (recovered) notes.push({ title: 'Interrupted restore undone', message: recovered.message, detail: '' });
  } catch (error) { return fail('restore-recovery-failed', error.message); }

  // ---- what is this folder? (reads only)
  const marker = await readMarker(root);
  if (marker.state === 'invalid') return fail('bad-marker', marker.message);
  let loaded;
  try { loaded = await readManifest(root); } catch (error) { return fail('bad-package', error.message); }
  const pin = loaded ? readPin(loaded.manifest) : null;
  let format = 'equal';
  if (marker.state === 'none') {
    if (pin?.code === 'headless') return fail('headless', pin.message);
    if (!pin?.ok) return fail('not-a-workspace', `${root} is not an OpenDoc workspace. A workspace has a package.json that pins OpenDoc and, on this device, a .opendoc/workspace.json file; create a new one instead.`);
  } else {
    if (marker.marker.edition !== undefined && marker.marker.edition !== runtime.edition) return fail('headless', `This workspace is of the ${marker.marker.edition} edition of OpenDoc, and opendoc-desktop opens workspaces of the ${runtime.edition} edition only. Edition switching is not an update, so nothing was changed.`);
    if (!Number.isInteger(marker.marker.formatVersion)) return fail('unsupported-format', `This workspace does not say which workspace format it uses (${marker.marker.formatVersion ?? 'missing'}), so the app cannot open it. Nothing was changed.`);
    format = compareFormat(marker.marker.formatVersion, runtime.workspaceFormat);
    if (!loaded) return fail('no-package', `${root} has no package.json, so the app cannot tell which OpenDoc version the workspace is on. Nothing was changed.`);
    if (!pin.ok) return fail(pin.code, pin.message);
  }

  // The format comes before the version: a workspace in an older format needs the upgrade whatever its pin says, and one in a
  // newer format is read-only whatever its pin says.
  let decision = decideVersion(pin.version, runtime.version);
  if (format === 'newer') decision = { kind: 'readonly', reason: 'newer-minor', message: newerFormatMessage(marker.marker.formatVersion, runtime.workspaceFormat) };
  else if (format === 'older' && decision.kind !== 'readonly') decision = { kind: 'upgrade', from: pin.version, to: runtime.version };
  let readOnly = null;
  if (decision.kind === 'readonly') {
    if (!readOnlySupport) return fail('read-only-unsupported', decision.message + unsupportedSuffix);
    readOnly = { reason: decision.reason, message: decision.message };
  }
  const pending = await readPending(root);
  const recheck = Boolean(pending) && decision.kind === 'open' && !readOnly; // the pin moved, and the checks were never settled

  // ---- questions
  const adopt = marker.state === 'none' && !readOnly;
  if (adopt && !(await ui.askAdopt(root))) return canceled;
  const modules = await inspectModules(root, wanted, { exact });
  // A marker that says which OpenDoc made the workspace (`createdWith`) is what `init` writes; only then is a fresh node_modules the app's own.
  const ours = created && marker.state === 'ok' && typeof marker.marker.createdWith === 'string';
  let approvedReal = false;
  if (modules.state === 'real') {
    approvedReal = ours || await ui.askRealModules(root, modules.kind);
    if (!approvedReal) return fail('modules-kept', `The ${modules.kind === 'file' ? 'file' : 'folder'} node_modules in this workspace was left as it is, so the workspace was not opened. Opening it needs node_modules to be a link to the app's OpenDoc.`);
  }
  let upgrade = false;
  let remember = false;
  if (decision.kind === 'upgrade') {
    if (upgradeWithoutAsking) upgrade = true;
    else {
      const answer = await ui.askUpgrade({ root, from: decision.from, to: decision.to, formatFrom: marker.state === 'ok' ? marker.marker.formatVersion : undefined, formatTo: runtime.workspaceFormat });
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
  // The link is checked again here; a folder that appeared since the question was asked is not replaced.
  const linked = await ensureModulesLink(root, wanted, { exact, replaceReal: approvedReal ? replaceReal : undefined });
  if (linked.state === 'real' && !linked.changed) return fail('modules-kept', `node_modules in this workspace changed while the app was asking about it, so it was left as it is and the workspace was not opened. Open it again.`);
  if (!readOnly) {
    if (adopt) await adoptWorkspace(root, { formatVersion: runtime.workspaceFormat, edition: runtime.edition });
    else await markManaged(root);
    try { await ensureSkillsLink(root); } catch (error) { log(`could not repair .claude/skills: ${error.message}`); }
  }

  if (decision.kind === 'open' && decision.movePin && !readOnly) {
    try { await writePin(root, runtime.version, runtime.edition); }
    catch (error) { return fail('pin-failed', `The workspace's OpenDoc version could not be moved up to ${runtime.version}: ${error.message}`); }
  }

  /**
   * The checks failed (or an upgrade stopped): show the result screen and act on the answer. Resolves null to go on opening, or
   * a result to return. `backup` is `{ name, directory }`.
   */
  const settle = async ({ from, to, backup, failures, stage, message, canOpen }) => {
    const answer = await ui.showResult({ root, from, to, backup, failures, stage, message, prompt: agentPrompt({ root, to, failures }), canOpen });
    if (answer.action === 'restore' && backup) {
      let restored;
      try { restored = await restoreBackup({ root, dataDir, name: backup.name, now, free }); }
      catch (error) { return fail('restore-failed', error.message); }
      await clearPending(root);
      const original = await backupManifest(dataDir, backup.name);
      if (Number.isInteger(original?.workspaceFormat)) await setFormatVersion(root, original.workspaceFormat).catch(error => log(`could not restore the workspace format: ${error.message}`));
      const text = restoredBackupMessage(from);
      const where = `The files that were in the workspace just before are in ${restored.before.directory}.`;
      if (!readOnlySupport) return fail('restored', `${text} ${where}${unsupportedSuffix}`);
      readOnly = { reason: 'restored-backup', message: text };
      notes.push({ title: 'Backup restored', message: text, detail: where });
      return null;
    }
    if (answer.action === 'open' && canOpen) { await clearPending(root); return null; }
    if (stage === 'done') await clearPending(root); // the user has seen what failed
    return canceled;
  };

  if (upgrade) {
    if (remember) await ui.remember?.();
    const result = await runUpgrade({ root, from: decision.from, to: decision.to, edition: runtime.edition, formatVersion: runtime.workspaceFormat, dataDir, runCli: (args, opts) => runCli(args, { ...opts, signal }), registry, progress: text => ui.progress?.(text), now, free, runStep, signal });
    ui.progress?.(null);
    if (result.stage === 'backup') return fail('backup-failed', result.message);
    if (result.stage === 'canceled') return canceled;
    const backup = result.backup && { name: result.backup.name, directory: result.backup.directory };
    if (!result.ok) {
      const stopped = await settle({ from: decision.from, to: decision.to, backup, failures: result.failures, stage: result.stage, message: result.message, canOpen: result.stage === 'done' });
      if (stopped) return stopped;
    } else {
      await clearPending(root);
      notes.push({ title: 'Workspace upgraded', message: `This workspace is now on OpenDoc ${decision.to}. Every document was checked and reviewed.`, detail: `A copy of how it was before is in ${backup.directory}.\n\nTo go back to it later: close this workspace, open Workspace Backups… in the File menu, choose Reveal, and copy the files in its "workspace" folder over the workspace folder. Backups are never deleted by the app.` });
    }
  } else if (pending && !recheck) {
    await clearPending(root); // the pin did not move: nothing was left unchecked
  } else if (recheck) {
    // An earlier upgrade moved the pin and never settled its checks (a crash, or the app was closed): do them now.
    const checked = await runChecks({ root, runCli: (args, opts) => runCli(args, { ...opts, signal }), progress: text => ui.progress?.(text), signal });
    ui.progress?.(null);
    if (checked.canceled) return canceled;
    if (checked.failures.length) {
      const stopped = await settle({ from: pending.from, to: pending.to, backup: pending.backup, failures: checked.failures, stage: 'done', message: 'An earlier upgrade of this workspace was interrupted before its checks finished. They ran now.', canOpen: true });
      if (stopped) return stopped;
    } else {
      await clearPending(root);
      notes.push({ title: 'Upgrade checks finished', message: `An earlier upgrade of this workspace to OpenDoc ${pending.to} was interrupted before its checks finished. They ran now and everything passed.`, detail: pending.backup ? `The backup from before that upgrade is in ${pending.backup.directory}.` : '' });
    }
  }
  return { ok: true, readOnly, notes, adopted: adopt && !readOnly, upgraded: upgrade };
}
