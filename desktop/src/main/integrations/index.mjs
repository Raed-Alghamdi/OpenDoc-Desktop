// The integration module: finds the agent apps on this computer, installs the OpenDoc plugin or skill into
// the ones the user picks (through each vendor's own command, from a stable copy of desktop/integrations/), checks the result,
// records exactly what it did, and undoes exactly that. The screen is a thin layer over the calls below.
//
//   const integrations = createIntegrations({ sourceDirectory, build });
//   await integrations.refresh();                 at startup, when the app's build changed (see refresh)
//   const list = await integrations.overview();   the list of apps, at once: no vendor command runs
//   const page = await integrations.checkApp('claude'); one app's read-only vendor check, for its page
//   await integrations.connect(['claude', 'claude@.claude-Work']);
//   await integrations.disconnect(['claude']);
//
// Every call returns plain data (JSON-safe) and never throws for an ordinary failure: a failure is a result with `ok: false`, a short
// `code`, a one-sentence `summary`, and the `steps` that ran (each with the exact command and its output) for the screen to show.
//
// App ids: 'claude' (Claude Code), 'codex' (Codex), 'antigravity' (Antigravity), 'cursor' (Cursor), 'copilot' (Copilot CLI).
//
// Targets: OpenDoc is connected per target, a settings folder of an app (targets.mjs). Most apps have one target, whose id is the app id.
//   Claude Code has one for ~/.claude (id `claude`), one for every `~/.claude-<name>` folder that holds Claude Code settings
//   (`claude@.claude-<name>`), and one for the folder CLAUDE_CONFIG_DIR names when that is none of those. A vendor command for a target
//   runs with CLAUDE_CONFIG_DIR set to its folder (removed for `claude`). The calls below that take ids take target ids; an app id
//   is its default target. An id that detection did not find (and the manifest does not hold) is refused with `unknown-target`.
//
// overview({ fresh }) -> { checkedAt, problem, environment, apps: [ { ...detect()'s app, targets: [ { id, label, configFolder, source,
//                 exists, note, terminal, recorded, pending, stale } ] } ], other: { skillFolder, skillFolderExists, command } }
//   Runs no vendor command and no connect: detection (a PATH lookup, never a mise shim) and the manifest's records. The login shell is
//   read once and the answer reused for a minute (`loginShellCacheMs`); `fresh: true` reads it again.
// checkApp(id, { fresh }) -> { checkedAt, problem, app: <the overview's app>, status: <status()'s app> }
//   The read-only vendor commands for that one app (every target of it), as status() runs them. Reuses the login shell like overview().
// detect() -> { checkedAt, environment, apps: [ { id, name, kind, command, present, canConnect, reason, executable, viaShim, installer,
//                 website, targets, configFolder, configFolderExists, configVariable, configFolderSource } ] }
//   Runs nothing but the user's login shell (`$SHELL -lc /usr/bin/env`, for PATH, CLAUDE_CONFIG_DIR and CODEX_HOME). A command is looked up as
//   a file; a mise shim is never run (running one installs the tool), and counts as the app only when mise's install folders hold
//   the real program. `reason` is a sentence for the screen. `environment.variables` says where each config variable came from.
// connect(ids) -> { ok, copy: { ok, changed, path, summary }, results: [ { app, target, targetLabel, name, ok, code, changed, summary, steps } ] }
//   Copies the integration files to the stable copy, then installs for each target and checks it. A failed install is undone from
//   the record, so nothing half-done stays. Codes: connected, already-present (installed outside the app: left alone), absent,
//   conflict, blocked (the vendor's output reads like a policy refusal), failed, timeout, not-found, verify-failed, copy-failed,
//   unknown-app, unknown-target.
// disconnect(ids, { forget }) -> { ok, results: [ ... ] }  Undo from the manifest, through the vendor's command. Codes: disconnected,
//   not-connected, forgotten (forget: true drops the record without running anything), modified (a file the user changed was kept),
//   plus the failure codes above. The stable copy is removed with the last target.
// status({ verify, only, reuseLoginShell }) -> { checkedAt, problem, copy: { path, exists, upToDate }, apps: [ { id, name, present, connected,
//                 managed, stale, problem, summary, targets: [ { id, label, configFolder, connected, managed, stale, problem, summary } ] } ] }
//   `connected` is true, false, or null (could not be checked). `managed` is true when this app's manifest holds the record. An app's
//   own fields sum up its targets (connected if any is). verify: false skips the read-only vendor commands and reports the manifest
//   only; `only` is a list of app ids to look at.
// refresh({ reinstall }) -> { ok, changed, copy, results }  Brings the stable copy up to date with the app's files, and the targets that
//   keep their own copy (Codex and Antigravity re-install, Cursor and Copilot re-copy; Claude Code reads in place and only its records
//   move). It does nothing when nothing is connected. `reinstall: false` refreshes the copy only; status() then shows them as `stale`.
//
// The manifest is `integrations.json` in the app's data folder, the copy is `integrations/` beside it. A record is kept per target id;
// a record from before targets existed (`apps.claude`, folder ~/.claude, CLAUDE_CONFIG_DIR null) is the `claude` target as it is, and
// one that pinned another folder is read as that folder's target. Calls that run vendor commands go one at a time.
import { existsSync } from 'node:fs';
import { mkdir, rmdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDirectory } from '../workspace/paths.mjs';
import * as antigravity from './antigravity.mjs';
import { appById, appIds, apps, loginVariables } from './apps.mjs';
import * as claude from './claude.mjs';
import * as codex from './codex.mjs';
import { detectApp, resolveCommand } from './detect.mjs';
import { expandHome, isDirectory } from './files.mjs';
import { createManifest } from './manifest.mjs';
import { failureCode, mergePaths, readLoginEnvironment, runProgram, shellQuote } from './run.mjs';
import * as skillFiles from './skill-files.mjs';
import { copyDigest, ensureCopy, readSource, removeCopy } from './stable-copy.mjs';
import { appIdOfTarget, displayPath, targetIdFor } from './targets.mjs';

/** A list of ids from a caller: the strings in it, each once. */
const uniqueIds = ids => [...new Set(Array.isArray(ids) ? ids.filter(id => typeof id === 'string' && id) : [])];

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
/**
 * Options (all optional): `sourceDirectory` (the app's integration files), `dataDirectory`, `home`, `env`, `platform`, `build`
 * (recorded with the copy), `shell` (default `env.SHELL`), `readLoginShell: false` (use `env` only), `loginShellTimeoutMs`,
 * `loginShellCacheMs` (how long overview() and checkApp() reuse one read of the login shell, default 60 s),
 * `commandTimeoutMs`, `extraPathDirectories` (searched last), `now` (a clock, for tests).
 */
export function createIntegrations(options = {}) {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const dataDir = options.dataDirectory ?? dataDirectory({ env, platform, home });
  const sourceDirectory = options.sourceDirectory ?? defaultSourceDirectory();
  const copyDirectory = join(dataDir, 'integrations');
  const build = options.build ?? null;
  const now = options.now ?? (() => new Date());
  const commandTimeoutMs = options.commandTimeoutMs ?? 120_000;
  const loginShellCacheMs = options.loginShellCacheMs ?? 60_000;
  const extraPathDirectories = options.extraPathDirectories ?? fallbackPathDirectories(home);
  // A neutral folder for the vendor commands, so a project's own settings never mix into what they list. It is the app's own, private
  // to the user (a shared temp folder is writable by others, and a vendor tool may read files from where it runs).
  const workingDirectory = options.workingDirectory ?? join(dataDir, 'integrations-work');

  /** A record written when Claude Code had one folder, with CLAUDE_CONFIG_DIR pinned to a folder other than ~/.claude, is that folder's target. */
  function normaliseRecords(current) {
    for (const app of apps) {
      const record = app.multiFolder ? current.apps[app.id] : null;
      const pinned = record?.environment?.[app.configVariable];
      if (typeof pinned !== 'string' || !pinned) continue;
      const folder = expandHome(pinned, home);
      if (!isAbsolute(folder)) continue;
      const key = targetIdFor(app, folder, home);
      if (key !== app.id && !current.apps[key]) { current.apps[key] = record; delete current.apps[app.id]; }
    }
    return current;
  }
  const manifest = createManifest(join(dataDir, 'integrations.json'), { normalise: normaliseRecords });

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

  let loginCache = null; // { at, login }: the last read of the login shell
  /** The user's login shell, read now, or (`reuse`) as it was read within the last `loginShellCacheMs`. */
  async function readLogin({ reuse = false } = {}) {
    if (options.readLoginShell === false) return { ok: false, shell: null, variables: {}, error: null, skipped: true };
    if (reuse && loginCache && now().getTime() - loginCache.at < loginShellCacheMs) return loginCache.login;
    const login = await readLoginEnvironment({ shell: options.shell ?? env.SHELL, env, names: loginVariables, timeoutMs: options.loginShellTimeoutMs ?? 8000, cwd: home });
    loginCache = { at: now().getTime(), login };
    return login;
  }

  /** What the user's shell and the app's environment say; the login shell wins, because it holds what the user set up. */
  async function readEnvironment({ reuse = false } = {}) {
    const login = await readLogin({ reuse });
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

  async function detectAll({ reuse = false } = {}) {
    const environment = await readEnvironment({ reuse });
    const found = [];
    for (const app of apps) found.push(await detectApp(app, { pathDirectories: environment.pathDirectories, env, home, variables: environment.variables }));
    return { environment, apps: found };
  }

  const describeEnvironment = environment => ({
    shell: environment.login.shell,
    loginShell: { read: environment.login.ok, error: environment.login.error },
    variables: Object.fromEntries(apps.filter(app => app.configVariable).map(app => [app.configVariable, environment.variables[app.configVariable] ?? null])),
  });

  async function detect() {
    const { environment, apps: found } = await serial(detectAll);
    return { checkedAt: now().toISOString(), environment: describeEnvironment(environment), apps: found };
  }

  /** The targets of an app: the ones detection found, then any the manifest holds a record for that detection did not find. */
  function targetsOf(app, detection, records) {
    const list = [...detection.targets];
    for (const [key, record] of Object.entries(records)) {
      if (appIdOfTarget(key) !== app.id || list.some(item => item.id === key)) continue;
      list.push(recordedTarget(app, key, record));
    }
    return list;
  }
  const recordedTarget = (app, id, record) => ({
    app: app.id, id, label: record.configFolder ? displayPath(record.configFolder, home) : id, configFolder: record.configFolder ?? null, source: 'recorded',
    terminal: false, exists: false, environment: record.environment ?? {}, note: 'This app set OpenDoc up here, but the folder is not found now.',
  });
  /** A target an id names: one detection found, else one the manifest holds. Never built from the id itself. */
  const resolveTarget = (app, detection, id, records) => detection?.targets.find(item => item.id === id) ?? (records[id] && appIdOfTarget(id) === app.id ? recordedTarget(app, id, records[id]) : null);

  /** A target for the screen: what is on disk and what the manifest says, with no vendor command. */
  function publicTarget(target, current) {
    const record = current.apps[target.id];
    const { environment, ...rest } = target;
    return { ...rest, recorded: Boolean(record), pending: Boolean(record?.pending), stale: isStale(record, current), managed: Boolean(record) };
  }
  const isStale = (record, current) => Boolean(record && !record.pending && current.copy && record.copyDigest !== current.copy.digest);
  const publicApp = (app, detection, targets, current) => ({ ...detection, targets: targets.map(item => publicTarget(item, current)) });

  /** The environment a vendor command runs in. `recorded` (a target's manifest record) pins what the install used. */
  function vendorEnvironment({ environment, recorded, target }) {
    const next = { ...env };
    for (const name of Object.keys(next)) if (name.startsWith('ELECTRON_')) delete next[name];
    next.PATH = mergePaths(environment?.loginPath, env.PATH, extraPathDirectories.join(delimiter));
    next.HOME = recorded?.home ?? home;
    next.NO_COLOR = '1';
    for (const [name, value] of Object.entries((recorded ? recorded.environment : target?.environment) ?? {})) { if (value === null) delete next[name]; else next[name] = value; }
    return next;
  }

  async function saveRecord(id, record, pending) {
    await manifest.update(current => { current.apps[id] = pending ? { ...record, pending: true } : { ...record }; return current; });
  }

  /** `CLAUDE_CONFIG_DIR=/folder ` before the command a step shows, for a target that is not the app's default one: the folder is what makes it differ. */
  const environmentPrefix = (app, target, recorded) => (target.id === app.id ? '' : Object.entries((recorded ? recorded.environment : target.environment) ?? {}).filter(([, value]) => value).map(([name, value]) => `${name}=${shellQuote(value)} `).join(''));

  function makeContext({ app, target, executable, vendorEnv, record, existing }) {
    const steps = [];
    const prefix = environmentPrefix(app, target, record);
    const context = {
      app, target, home, copyDirectory, record, steps, prefix: '', wasConnected: Boolean(existing), failureCode,
      async exec(label, args) {
        await mkdir(workingDirectory, { recursive: true, mode: 0o700 });
        const result = await runProgram(executable, args, { env: vendorEnv, cwd: workingDirectory, timeoutMs: commandTimeoutMs });
        steps.push({ label: context.prefix + label, ok: result.ok, command: prefix + result.command, exitCode: result.exitCode, timedOut: result.timedOut, output: result.output || result.spawnError || '', durationMs: result.durationMs });
        return result;
      },
      note: (label, text) => { steps.push({ label: context.prefix + label, ok: true, skipped: true, command: null, exitCode: null, timedOut: false, output: text, durationMs: 0 }); },
      fail: (label, text) => { steps.push({ label: context.prefix + label, ok: false, skipped: false, command: null, exitCode: null, timedOut: false, output: text, durationMs: 0 }); },
      failLastStep: text => { const last = steps.at(-1); if (last) { last.ok = false; last.output = [last.output, text].filter(Boolean).join('\n'); } },
      save: () => saveRecord(target.id, record, true),
    };
    return context;
  }

  const result = (app, outcome, steps, target = null) => ({ app: app.id, target: target?.id ?? app.id, targetLabel: target?.label ?? null, name: app.name, ok: Boolean(outcome.ok), code: outcome.code, changed: Boolean(outcome.changed), summary: outcome.summary, steps });
  const failed = (app, code, summary, steps = [], target = null) => result(app, { ok: false, code, summary }, steps, target);
  const unknownApp = id => ({ app: id, target: id, targetLabel: null, name: id, ok: false, code: 'unknown-app', changed: false, summary: `${id} is not one of the apps this module knows (${appIds.join(', ')}).`, steps: [] });
  const unknownTarget = (app, id) => ({ app: app.id, target: id, targetLabel: null, name: app.name, ok: false, code: 'unknown-target', changed: false, summary: `That is not a ${app.name} settings folder this app knows. Press Check again, then try once more.`, steps: [] });

  /** Install for one target and update the manifest. `existing` is the target's current record, when it has one. */
  async function installApp({ app, target, detection, environment, existing, copy }) {
    if (!detection?.canConnect) return failed(app, 'absent', detection?.reason ?? `${app.name} was not found.`, [], target);
    const executable = detection.executable;
    const record = {
      ...(existing ?? {}),
      app: app.id, kind: app.kind, connectedAt: (existing?.connectedAt) ?? now().toISOString(), executable,
      configFolder: target.configFolder, environment: target.environment, home,
      copyPath: copyDirectory, copyDigest: copy.digest,
    };
    delete record.pending;
    const context = makeContext({ app, target, executable, vendorEnv: vendorEnvironment({ environment, target }), record, existing });
    let outcome;
    try { outcome = await handlers[app.id].install(context); }
    catch (error) { outcome = { ok: false, code: 'failed', summary: `Unexpected error: ${error.message}`, leftBehind: true }; context.fail('Unexpected error', error.stack ?? error.message); }
    if (outcome.ok && outcome.changed) await saveRecord(target.id, { ...record, connectedAt: existing?.connectedAt ?? record.connectedAt, updatedAt: now().toISOString() }, false);
    else if (!outcome.ok && outcome.undone) await manifest.update(current => { delete current.apps[target.id]; return current; });
    return result(app, outcome, context.steps, target);
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
      const wanted = uniqueIds(ids);
      const results = [];
      const known = [];
      for (const id of wanted) { const app = appById(appIdOfTarget(id)); if (app) known.push({ id, app }); else results.push(unknownApp(id)); }
      if (known.length === 0) return { ok: results.length > 0 && results.every(item => item.ok), copy: null, results };

      const detected = await detectAll();
      const { manifest: before } = await manifest.read();
      const chosen = [];
      for (const { id, app } of known) {
        const detection = detected.apps.find(item => item.id === app.id);
        const target = resolveTarget(app, detection, id, before.apps);
        if (target) chosen.push({ app, target, detection }); else results.push(unknownTarget(app, id));
      }
      // The copy is made only when some target can use it.
      const copy = chosen.some(item => item.detection.canConnect) ? await putCopy() : null;
      if (copy && !copy.ok) {
        for (const item of chosen) results.push(failed(item.app, 'copy-failed', copy.summary, [], item.target));
        return { ok: false, copy: copySummary(copy), results };
      }
      const { manifest: current } = await manifest.read();
      for (const item of chosen) results.push(await installApp({ ...item, environment: detected.environment, existing: current.apps[item.target.id], copy }));
      if (copy) await removeCopyWhenUnused();
      return { ok: results.every(item => item.ok), copy: copy ? copySummary(copy) : null, results };
    });
  }

  function disconnect(ids, { forget = false } = {}) {
    return serial(async () => {
      const wanted = uniqueIds(ids);
      const results = [];
      const detected = await detectAll();
      for (const id of wanted) {
        const app = appById(appIdOfTarget(id));
        if (!app) { results.push(unknownApp(id)); continue; }
        const detection = detected.apps.find(item => item.id === app.id);
        const { manifest: current } = await manifest.read();
        const record = current.apps[id];
        const target = resolveTarget(app, detection, id, current.apps);
        if (!target) { results.push(unknownTarget(app, id)); continue; }
        if (!record) { results.push(result(app, { ok: true, code: 'not-connected', summary: `This app has not set up anything in ${app.name}${target.id === app.id ? '' : ` (${target.label})`}, so there is nothing to remove.` }, [], target)); continue; }
        if (forget) {
          await manifest.update(next => { delete next.apps[id]; return next; });
          results.push(result(app, { ok: true, code: 'forgotten', changed: true, summary: `The record for ${app.name}${target.id === app.id ? '' : ` (${target.label})`} was dropped. Nothing was removed from ${app.name} itself.` }, [], target));
          continue;
        }
        const executable = detection?.executable ?? null;
        if (!executable && app.kind === 'plugin') {
          results.push(failed(app, 'not-found', `${app.name} is not found any more, so its OpenDoc plugin cannot be removed through it. Remove it by hand, or drop this app's record of it.`, [], target));
          continue;
        }
        const context = makeContext({ app, target, executable, vendorEnv: vendorEnvironment({ environment: detected.environment, recorded: record, target }), record, existing: record });
        let outcome;
        try { outcome = await handlers[app.id].uninstall(context, record); }
        catch (error) { outcome = { ok: false, code: 'failed', summary: `Unexpected error: ${error.message}` }; context.fail('Unexpected error', error.stack ?? error.message); }
        if (outcome.ok) await manifest.update(next => { delete next.apps[id]; return next; });
        results.push(result(app, outcome, context.steps, target));
      }
      const removedCopy = results.some(item => item.ok) ? await removeCopyWhenUnused() : false;
      return { ok: results.every(item => item.ok), copy: { removed: removedCopy, path: copyDirectory }, results };
    });
  }

  /** One target's state. With `verify`, asks the app (read-only vendor commands) whether OpenDoc is there. */
  async function checkTarget({ app, target, detection, environment, current, verify }) {
    const record = current.apps[target.id] ?? null;
    const where = target.id === app.id ? '' : ` in ${target.label}`;
    const item = { id: target.id, label: target.label, configFolder: target.configFolder, source: target.source, connected: null, managed: Boolean(record), stale: isStale(record, current), problem: null, summary: '' };
    if (record?.pending) item.problem = `A connect to ${app.name}${where} did not finish. Disconnect to clean up what it added.`;
    if (!detection.canConnect) {
      item.summary = record ? `${app.name} is not found now, but this app set up OpenDoc in it earlier. ${detection.reason}` : detection.reason;
    } else if (!verify) {
      item.summary = record ? 'Set up by this app (not checked).' : 'Not checked.';
    } else {
      const context = makeContext({ app, target, executable: detection.executable, vendorEnv: vendorEnvironment({ environment, recorded: record ?? undefined, target }), record, existing: record });
      let checked;
      try { checked = await handlers[app.id].check(context); }
      catch (error) { checked = { connected: null, summary: `Could not check: ${error.message}` }; }
      item.connected = checked.connected;
      item.summary = checked.summary;
    }
    return item;
  }

  /** An app's state from its targets': connected when any is, with their sentences joined when there are several. */
  function sumUp(app, detection, items) {
    const connected = items.some(item => item.connected === true) ? true : items.every(item => item.connected === false) ? false : null;
    return {
      id: app.id, name: app.name, present: detection.present, connected, managed: items.some(item => item.managed), stale: items.some(item => item.stale),
      problem: items.find(item => item.problem)?.problem ?? null,
      summary: items.length === 1 ? items[0].summary : items.map(item => `${item.label}: ${item.summary}`).join(' '),
      targets: items,
    };
  }

  /** The read-only look at `only` apps (default all): detection, the manifest and, with `verify`, the vendor commands. */
  async function inspect({ verify, only, reuse }) {
    const detected = await detectAll({ reuse });
    const { manifest: current, problem } = await manifest.read();
    const list = [];
    for (const app of apps) {
      if (only && !only.includes(app.id)) continue;
      const detection = detected.apps.find(item => item.id === app.id);
      const targets = targetsOf(app, detection, current.apps);
      const items = [];
      for (const target of targets) items.push(await checkTarget({ app, target, detection, environment: detected.environment, current, verify }));
      list.push({ app: publicApp(app, detection, targets, current), status: sumUp(app, detection, items) });
    }
    return { current, problem, list };
  }

  function status({ verify = true, only, reuseLoginShell = false } = {}) {
    return serial(async () => {
      const { problem, list } = await inspect({ verify, only: Array.isArray(only) ? only : undefined, reuse: reuseLoginShell });
      const onDisk = await copyDigest(copyDirectory);
      const sourceCopy = await readSource(sourceDirectory);
      const upToDate = Boolean(onDisk) && sourceCopy.ok && onDisk === sourceCopy.digest;
      return { checkedAt: now().toISOString(), problem, copy: { path: copyDirectory, exists: Boolean(onDisk), upToDate }, apps: list.map(item => item.status) };
    });
  }

  function checkApp(id, { fresh = false } = {}) {
    return serial(async () => {
      if (!appById(id)) return { checkedAt: now().toISOString(), problem: `${id} is not one of the apps this module knows (${appIds.join(', ')}).`, app: null, status: null };
      const { problem, list } = await inspect({ verify: true, only: [id], reuse: !fresh });
      return { checkedAt: now().toISOString(), problem, app: list[0].app, status: list[0].status };
    });
  }

  /** The list of apps without running any vendor command (see the header). Not queued behind a connect: it only reads. */
  async function overview({ fresh = false } = {}) {
    const detected = await detectAll({ reuse: !fresh });
    const { manifest: current, problem } = await manifest.read();
    const skillFolder = join(sourceDirectory, 'skills', 'opendoc');
    const command = await resolveCommand('opendoc', { pathDirectories: detected.environment.pathDirectories, env, home });
    return {
      checkedAt: now().toISOString(), problem, environment: describeEnvironment(detected.environment),
      apps: apps.map(app => { const detection = detected.apps.find(item => item.id === app.id); return publicApp(app, detection, targetsOf(app, detection, current.apps), current); }),
      other: { skillFolder, skillFolderExists: await isDirectory(skillFolder), command: command.found ? command.executable : null },
    };
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
          const app = appById(appIdOfTarget(id));
          if (!app) continue;
          const detection = detected.apps.find(item => item.id === app.id);
          const target = resolveTarget(app, detection, id, current.apps);
          if (app.id === 'claude') {
            // Claude Code reads the plugin from the copy in place: the new files are live, only the record moves on.
            await saveRecord(id, { ...record, copyDigest: copy.digest, updatedAt: now().toISOString() }, false);
            results.push(result(app, { ok: true, code: 'refreshed', changed: true, summary: 'Claude Code reads the plugin from the copy, so the new files apply from its next session.' }, [], target));
          } else if (app.kind === 'plugin' && !reinstall) {
            results.push(result(app, { ok: true, code: 'stale', changed: false, summary: `${app.name} keeps its own copy of the plugin; it still has the older files until it is connected again.` }, [], target));
          } else {
            const outcome = await installApp({ app, target, detection, environment: detected.environment, existing: record, copy });
            results.push({ ...outcome, code: outcome.ok && outcome.code === 'connected' ? 'refreshed' : outcome.code });
          }
        }
      }
      const changed = copy.changed || copy.digest !== before || results.some(item => item.changed);
      return { ok: results.every(item => item.ok), changed, copy: copySummary(copy), results, summary: changed ? 'The integration files were refreshed.' : 'Everything was already up to date.' };
    });
  }

  return { detect, overview, checkApp, connect, disconnect, status, refresh, copyDirectory, manifestFile: manifest.file };
}

export { appIds } from './apps.mjs';
