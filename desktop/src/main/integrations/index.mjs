// The integration module: finds the agent apps on this computer, installs the OpenDoc plugin or skill into
// the ones the user picks (through each vendor's own command, from a stable copy of desktop/integrations/), checks the result,
// records exactly what it did, and undoes exactly that. The screen is a thin layer over the five calls below.
//
//   const integrations = createIntegrations({ sourceDirectory, build });
//   await integrations.refresh();                 at startup, when the app's build changed (see refresh)
//   const { apps } = await integrations.detect(); to draw a checkbox per app
//   await integrations.connect(['claude', 'codex']);
//   await integrations.status();                  is it connected now, and by this app?
//   await integrations.disconnect(['claude']);
//
// Every call returns plain data (JSON-safe) and never throws for an ordinary failure: a failure is a result with `ok: false`, a short
// `code`, a one-sentence `summary`, and the `steps` that ran (each with the exact command and its output) for the screen to show.
//
// App ids: 'claude' (Claude Code), 'codex' (Codex), 'antigravity' (Antigravity), 'cursor' (Cursor), 'copilot' (Copilot CLI).
//
// detect() -> { checkedAt, environment, apps: [ { id, name, kind, command, present, canConnect, reason, executable, viaShim,
//                 configFolder, configFolderExists, configVariable, configFolderSource } ] }
//   Runs nothing but the user's login shell (`$SHELL -lc /usr/bin/env`, for PATH, CLAUDE_CONFIG_DIR and CODEX_HOME). A command is looked up as
//   a file; a mise shim is never run (running one installs the tool), and counts as the app only when mise's install folders hold
//   the real program. `reason` is a sentence for the screen. `environment.variables` says where each config variable came from.
// connect(ids) -> { ok, copy: { ok, changed, path, summary }, results: [ { app, name, ok, code, changed, summary, steps } ] }
//   Copies the integration files to the stable copy, then installs for each app and checks it. A failed install is undone from
//   the record, so nothing half-done stays. Codes: connected, already-present (installed outside the app: left alone), absent,
//   conflict, blocked (the vendor's output reads like a policy refusal), failed, timeout, not-found, verify-failed, copy-failed.
// disconnect(ids, { forget }) -> { ok, results: [ ... ] }  Undo from the manifest, through the vendor's command. Codes: disconnected,
//   not-connected, forgotten (forget: true drops the record without running anything), modified (a file the user changed was kept),
//   plus the failure codes above. The stable copy is removed with the last app.
// status({ verify }) -> { checkedAt, problem, copy: { path, exists, upToDate }, apps: [ { id, name, present, connected, managed,
//                 stale, problem, summary } ] }
//   `connected` is true, false, or null (could not be checked). `managed` is true when this app's manifest holds the record.
//   verify: false skips the read-only vendor commands and reports the manifest only.
// refresh({ reinstall }) -> { ok, changed, copy, results }  Brings the stable copy up to date with the app's files, and the apps that
//   keep their own copy (Codex and Antigravity re-install, Cursor and Copilot re-copy; Claude Code reads in place). It does nothing
//   when nothing is connected. `reinstall: false` refreshes the copy only; status() then shows the apps as `stale`.
//
// The manifest is `integrations.json` in the app's data folder, the copy is `integrations/` beside it. Calls run one at a time.
import { existsSync } from 'node:fs';
import { mkdir, rmdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDirectory } from '../workspace/paths.mjs';
import * as antigravity from './antigravity.mjs';
import { appById, appIds, apps, loginVariables } from './apps.mjs';
import * as claude from './claude.mjs';
import * as codex from './codex.mjs';
import { detectApp } from './detect.mjs';
import { createManifest } from './manifest.mjs';
import { failureCode, mergePaths, readLoginEnvironment, runProgram } from './run.mjs';
import * as skillFiles from './skill-files.mjs';
import { copyDigest, ensureCopy, readSource, removeCopy } from './stable-copy.mjs';

const handlers = { claude, codex, antigravity, cursor: skillFiles, copilot: skillFiles };
// Used only when the user's login shell cannot be read and the app's own PATH lacks them (a launcher's PATH is short).
const fallbackPathDirectories = home => [join(home, '.local', 'bin'), '/usr/local/bin', '/opt/homebrew/bin'];

/** Where the app's own integration files are: `<resources>/integrations` in a packaged app, else desktop/integrations in the source tree. */
export function defaultSourceDirectory({ resourcesPath = process.resourcesPath } = {}) {
  if (resourcesPath && existsSync(join(resourcesPath, 'integrations'))) return join(resourcesPath, 'integrations');
  return fileURLToPath(new URL('../../../integrations', import.meta.url));
}

/**
 * Options (all optional): `sourceDirectory` (the app's integration files), `dataDirectory`, `home`, `env`, `platform`, `build`
 * (recorded with the copy), `shell` (default `env.SHELL`), `readLoginShell: false` (use `env` only), `loginShellTimeoutMs`,
 * `commandTimeoutMs`, `extraPathDirectories` (searched last), `now` (a clock, for tests).
 */
export function createIntegrations(options = {}) {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const dataDir = options.dataDirectory ?? dataDirectory({ env, platform, home });
  const sourceDirectory = options.sourceDirectory ?? defaultSourceDirectory();
  const copyDirectory = join(dataDir, 'integrations');
  const manifest = createManifest(join(dataDir, 'integrations.json'));
  const build = options.build ?? null;
  const now = options.now ?? (() => new Date());
  const commandTimeoutMs = options.commandTimeoutMs ?? 120_000;
  const extraPathDirectories = options.extraPathDirectories ?? fallbackPathDirectories(home);
  // A neutral folder for the vendor commands, so a project's own settings never mix into what they list. It is the app's own, private
  // to the user (a shared temp folder is writable by others, and a vendor tool may read files from where it runs).
  const workingDirectory = options.workingDirectory ?? join(dataDir, 'integrations-work');

  let queue = Promise.resolve();
  /** One call at a time: the manifest and the vendors' own config are never changed by two calls together. */
  const serial = work => { const run = queue.then(work).finally(releaseWorkingDirectory); queue = run.catch(() => {}); return run; };
  /**
   * With nothing connected the app leaves nothing behind: the empty folder the commands ran in is removed (it is made again when a
   * command needs it), and the data folder with it when that leaves it empty. While an app is connected the folder stays, so a
   * command that is starting never loses its working folder.
   */
  async function releaseWorkingDirectory() {
    try {
      const { manifest: current } = await manifest.read();
      if (Object.keys(current.apps).length > 0) return;
      if (options.workingDirectory === undefined) await rmdir(workingDirectory).catch(() => {}); // a folder the caller named is the caller's
      await rmdir(dataDir).catch(() => {});
    } catch { /* a manifest that cannot be read is no reason to fail the call */ }
  }

  /** What the user's shell and the app's environment say; the login shell wins, because it holds what the user set up. */
  async function readEnvironment() {
    const login = options.readLoginShell === false
      ? { ok: false, shell: null, variables: {}, error: null, skipped: true }
      : await readLoginEnvironment({ shell: options.shell ?? env.SHELL, env, names: loginVariables, timeoutMs: options.loginShellTimeoutMs ?? 8000, cwd: home });
    const variables = {};
    for (const app of apps) {
      const name = app.configVariable;
      if (!name) continue;
      if (login.variables[name]) variables[name] = { value: login.variables[name], source: 'login shell' };
      else if (env[name]) variables[name] = { value: env[name], source: 'app environment' };
    }
    const path = mergePaths(login.variables.PATH, env.PATH, extraPathDirectories.join(delimiter));
    return { login, variables, pathDirectories: path.split(delimiter).filter(Boolean), loginPath: login.variables.PATH ?? null };
  }

  async function detectAll() {
    const environment = await readEnvironment();
    const found = [];
    for (const app of apps) found.push(await detectApp(app, { pathDirectories: environment.pathDirectories, env, home, variables: environment.variables }));
    return { environment, apps: found };
  }

  async function detect() {
    const { environment, apps: found } = await serialDetect();
    return {
      checkedAt: now().toISOString(),
      environment: {
        shell: environment.login.shell,
        loginShell: { read: environment.login.ok, error: environment.login.error },
        variables: Object.fromEntries(apps.filter(app => app.configVariable).map(app => [app.configVariable, environment.variables[app.configVariable] ?? null])),
      },
      apps: found,
    };
  }
  const serialDetect = () => serial(detectAll);

  /** The environment a vendor command runs in. `recorded` (an app's manifest record) pins what the install used. */
  function vendorEnvironment({ app, environment, recorded }) {
    const next = { ...env };
    for (const name of Object.keys(next)) if (name.startsWith('ELECTRON_')) delete next[name];
    next.PATH = mergePaths(environment?.loginPath, env.PATH, extraPathDirectories.join(delimiter));
    next.HOME = recorded?.home ?? home;
    next.NO_COLOR = '1';
    if (recorded) {
      for (const [name, value] of Object.entries(recorded.environment ?? {})) { if (value === null) delete next[name]; else next[name] = value; }
    } else if (app.configVariable && environment?.variables[app.configVariable]) next[app.configVariable] = environment.variables[app.configVariable].value;
    return next;
  }

  const recordedEnvironment = (app, environment) => (app.configVariable ? { [app.configVariable]: environment.variables[app.configVariable]?.value ?? null } : {});

  async function saveRecord(id, record, pending) {
    await manifest.update(current => { current.apps[id] = pending ? { ...record, pending: true } : { ...record }; return current; });
  }

  function makeContext({ app, executable, vendorEnv, record, existing }) {
    const steps = [];
    const context = {
      app, home, copyDirectory, record, steps, prefix: '', wasConnected: Boolean(existing), failureCode,
      async exec(label, args) {
        await mkdir(workingDirectory, { recursive: true, mode: 0o700 });
        const result = await runProgram(executable, args, { env: vendorEnv, cwd: workingDirectory, timeoutMs: commandTimeoutMs });
        steps.push({ label: context.prefix + label, ok: result.ok, command: result.command, exitCode: result.exitCode, timedOut: result.timedOut, output: result.output || result.spawnError || '', durationMs: result.durationMs });
        return result;
      },
      note: (label, text) => { steps.push({ label: context.prefix + label, ok: true, skipped: true, command: null, exitCode: null, timedOut: false, output: text, durationMs: 0 }); },
      fail: (label, text) => { steps.push({ label: context.prefix + label, ok: false, skipped: false, command: null, exitCode: null, timedOut: false, output: text, durationMs: 0 }); },
      failLastStep: text => { const last = steps.at(-1); if (last) { last.ok = false; last.output = [last.output, text].filter(Boolean).join('\n'); } },
      save: () => saveRecord(app.id, record, true),
    };
    return context;
  }

  const result = (app, outcome, steps) => ({ app: app.id, name: app.name, ok: Boolean(outcome.ok), code: outcome.code, changed: Boolean(outcome.changed), summary: outcome.summary, steps });
  const failed = (app, code, summary, steps = []) => result(app, { ok: false, code, summary }, steps);

  /** Install for one app and update the manifest. `existing` is the app's current record, when it has one. */
  async function installApp({ app, detection, environment, existing, copy }) {
    if (!detection?.canConnect) return failed(app, 'absent', detection?.reason ?? `${app.name} was not found.`);
    const executable = detection.executable;
    const record = {
      ...(existing ?? {}),
      app: app.id, kind: app.kind, connectedAt: (existing?.connectedAt) ?? now().toISOString(), executable,
      configFolder: detection.configFolder, environment: recordedEnvironment(app, environment), home,
      copyPath: copyDirectory, copyDigest: copy.digest,
    };
    delete record.pending;
    const context = makeContext({ app, executable, vendorEnv: vendorEnvironment({ app, environment }), record, existing });
    let outcome;
    try { outcome = await handlers[app.id].install(context); }
    catch (error) { outcome = { ok: false, code: 'failed', summary: `Unexpected error: ${error.message}`, leftBehind: true }; context.fail('Unexpected error', error.stack ?? error.message); }
    if (outcome.ok && outcome.changed) await saveRecord(app.id, { ...record, connectedAt: existing?.connectedAt ?? record.connectedAt, updatedAt: now().toISOString() }, false);
    else if (!outcome.ok && outcome.undone) await manifest.update(current => { delete current.apps[app.id]; return current; });
    return result(app, outcome, context.steps);
  }

  async function removeCopyWhenUnused() {
    const { manifest: current } = await manifest.read();
    if (Object.keys(current.apps).length > 0) return false;
    await removeCopy(copyDirectory);
    await manifest.update(next => { delete next.copy; return next; });
    // The data folder too, when that leaves it empty (it holds backups once the app has made any, and then stays).
    await rmdir(dataDir).catch(() => {});
    return true;
  }

  async function putCopy() {
    const copy = await ensureCopy({ source: sourceDirectory, target: copyDirectory });
    if (copy.ok) await manifest.update(current => { current.copy = { path: copyDirectory, digest: copy.digest, build, updatedAt: now().toISOString() }; return current; });
    return copy;
  }

  const copySummary = copy => ({ ok: copy.ok, changed: copy.changed, path: copyDirectory, summary: copy.summary });

  function connect(ids) {
    return serial(async () => {
      const wanted = [...new Set(Array.isArray(ids) ? ids : [])];
      const results = [];
      const known = wanted.filter(id => appById(id));
      for (const id of wanted) if (!appById(id)) results.push({ app: id, name: id, ok: false, code: 'unknown-app', changed: false, summary: `${id} is not one of the apps this module knows (${appIds.join(', ')}).`, steps: [] });
      if (known.length === 0) return { ok: results.length > 0 && results.every(item => item.ok), copy: null, results };

      const detected = await detectAll();
      const present = id => detected.apps.find(item => item.id === id);
      // The copy is made only when some app can use it.
      const copy = known.some(id => present(id).canConnect) ? await putCopy() : null;
      if (copy && !copy.ok) {
        for (const id of known) results.push(failed(appById(id), 'copy-failed', copy.summary));
        return { ok: false, copy: copySummary(copy), results };
      }
      const { manifest: current } = await manifest.read();
      for (const id of known) {
        const app = appById(id);
        results.push(await installApp({ app, detection: present(id), environment: detected.environment, existing: current.apps[id], copy }));
      }
      if (copy) await removeCopyWhenUnused();
      return { ok: results.every(item => item.ok), copy: copy ? copySummary(copy) : null, results };
    });
  }

  function disconnect(ids, { forget = false } = {}) {
    return serial(async () => {
      const wanted = [...new Set(Array.isArray(ids) ? ids : [])];
      const results = [];
      const detected = await detectAll();
      for (const id of wanted) {
        const app = appById(id);
        if (!app) { results.push({ app: id, name: id, ok: false, code: 'unknown-app', changed: false, summary: `${id} is not one of the apps this module knows (${appIds.join(', ')}).`, steps: [] }); continue; }
        const { manifest: current } = await manifest.read();
        const record = current.apps[id];
        if (!record) { results.push(result(app, { ok: true, code: 'not-connected', summary: `This app has not set up anything in ${app.name}, so there is nothing to remove.` }, [])); continue; }
        if (forget) {
          await manifest.update(next => { delete next.apps[id]; return next; });
          results.push(result(app, { ok: true, code: 'forgotten', changed: true, summary: `The record for ${app.name} was dropped. Nothing was removed from ${app.name} itself.` }, []));
          continue;
        }
        const detection = detected.apps.find(item => item.id === id);
        let executable = detection?.executable ?? null;
        if (!executable && app.kind === 'plugin') {
          results.push(failed(app, 'not-found', `${app.name} is not found any more, so its OpenDoc plugin cannot be removed through it. Remove it by hand, or drop this app's record of it.`));
          continue;
        }
        const context = makeContext({ app, executable, vendorEnv: vendorEnvironment({ app, environment: detected.environment, recorded: record }), record, existing: record });
        let outcome;
        try { outcome = await handlers[id].uninstall(context, record); }
        catch (error) { outcome = { ok: false, code: 'failed', summary: `Unexpected error: ${error.message}` }; context.fail('Unexpected error', error.stack ?? error.message); }
        if (outcome.ok) await manifest.update(next => { delete next.apps[id]; return next; });
        results.push(result(app, outcome, context.steps));
      }
      const removedCopy = results.some(item => item.ok) ? await removeCopyWhenUnused() : false;
      return { ok: results.every(item => item.ok), copy: { removed: removedCopy, path: copyDirectory }, results };
    });
  }

  function status({ verify = true } = {}) {
    return serial(async () => {
      const detected = await detectAll();
      const { manifest: current, problem } = await manifest.read();
      const onDisk = await copyDigest(copyDirectory);
      const sourceCopy = await readSource(sourceDirectory);
      const upToDate = Boolean(onDisk) && sourceCopy.ok && onDisk === sourceCopy.digest;
      const items = [];
      for (const app of apps) {
        const detection = detected.apps.find(item => item.id === app.id);
        const record = current.apps[app.id] ?? null;
        const item = { id: app.id, name: app.name, present: detection.present, connected: null, managed: Boolean(record), stale: false, problem: null, summary: '' };
        if (record?.pending) item.problem = `A connect to ${app.name} did not finish. Disconnect to clean up what it added.`;
        if (record && !record.pending && current.copy && record.copyDigest !== current.copy.digest) item.stale = true;
        if (!detection.canConnect) {
          item.summary = record ? `${app.name} is not found now, but this app set up OpenDoc in it earlier. ${detection.reason}` : detection.reason;
        } else if (!verify) {
          item.summary = record ? 'Set up by this app (not checked).' : 'Not checked.';
        } else {
          const context = makeContext({ app, executable: detection.executable, vendorEnv: vendorEnvironment({ app, environment: detected.environment, recorded: record ?? undefined }), record, existing: record });
          let checked;
          try { checked = await handlers[app.id].check(context); }
          catch (error) { checked = { connected: null, summary: `Could not check: ${error.message}` }; }
          item.connected = checked.connected;
          item.summary = checked.summary;
        }
        items.push(item);
      }
      return { checkedAt: now().toISOString(), problem, copy: { path: copyDirectory, exists: Boolean(onDisk), upToDate }, apps: items };
    });
  }

  function refresh({ reinstall = true } = {}) {
    return serial(async () => {
      const { manifest: current } = await manifest.read();
      if (!current.copy) return { ok: true, changed: false, copy: null, results: [], summary: 'Nothing is connected, so there is nothing to refresh.' };
      const before = current.copy.digest;
      const copy = await putCopy();
      if (!copy.ok) return { ok: false, changed: false, copy: copySummary(copy), results: [], summary: copy.summary };
      const results = [];
      const recorded = Object.entries(current.apps).filter(([, record]) => record.copyDigest !== copy.digest && !record.pending);
      if (recorded.length) {
        const detected = await detectAll();
        for (const [id, record] of recorded) {
          const app = appById(id);
          if (!app) continue;
          if (id === 'claude') {
            // Claude Code reads the plugin from the copy in place: the new files are live, only the record moves on.
            await saveRecord(id, { ...record, copyDigest: copy.digest, updatedAt: now().toISOString() }, false);
            results.push(result(app, { ok: true, code: 'refreshed', changed: true, summary: 'Claude Code reads the plugin from the copy, so the new files apply from its next session.' }, []));
          } else if (app.kind === 'plugin' && !reinstall) {
            results.push(result(app, { ok: true, code: 'stale', changed: false, summary: `${app.name} keeps its own copy of the plugin; it still has the older files until it is connected again.` }, []));
          } else {
            const outcome = await installApp({ app, detection: detected.apps.find(item => item.id === id), environment: detected.environment, existing: record, copy });
            results.push({ ...outcome, code: outcome.ok && outcome.code === 'connected' ? 'refreshed' : outcome.code });
          }
        }
      }
      const changed = copy.changed || copy.digest !== before || results.some(item => item.changed);
      return { ok: results.every(item => item.ok), changed, copy: copySummary(copy), results, summary: changed ? 'The integration files were refreshed.' : 'Everything was already up to date.' };
    });
  }

  return { detect, connect, disconnect, status, refresh, copyDirectory, manifestFile: manifest.file };
}

export { appIds } from './apps.mjs';
