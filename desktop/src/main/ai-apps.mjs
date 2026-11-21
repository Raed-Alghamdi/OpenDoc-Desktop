// "Connect your AI apps": the shell's layer over the integration module (src/main/integrations). It builds the one
// module instance of an app run, turns the module's overview() (the list, at once) and checkApp() (one app's page, with its read-only
// vendor check) into the rows the screen draws, and keeps the startup refresh.
// The screen itself is renderer/ai-apps.html; the calls it makes are registered in desktop-shell.mjs. A page sends target ids
// (an app id, or `claude@<folder>`), never a path; the module checks them against what it found.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { environment } from './identity.mjs';
import { appIds, createIntegrations } from './integrations/index.mjs';

// What a test may set through the options file (environment.integrations). Nothing else is passed on.
const testOptionNames = ['home', 'env', 'shell', 'readLoginShell', 'extraPathDirectories', 'commandTimeoutMs', 'loginShellTimeoutMs', 'sourceDirectory', 'dataDirectory', 'workingDirectory'];

/**
 * The options of the app's one integration module instance: the app's own data folder and build number, and in an installed app
 * the integration files it carries (`<resources>/integrations`). An unpackaged run leaves `sourceDirectory` out, so the module
 * uses desktop/integrations.
 *
 * Tests need to keep the module away from the real home, config folders and login shell, so an unpackaged run may read a JSON
 * file named by OPENDOC_DESKTOP_INTEGRATIONS_OPTIONS (home, env, sourceDirectory, extraPathDirectories...). A packaged app never
 * reads it, so a variable in the environment of an installed app changes nothing. With that file the login shell is not read
 * unless the file says so.
 */
export function integrationOptions({ packaged, resourcesPath, dataDir, build, env = process.env, readText = file => readFileSync(file, 'utf8') }) {
  const options = { dataDirectory: dataDir, build: build ?? null };
  if (packaged) {
    options.sourceDirectory = join(resourcesPath, 'integrations');
    return options;
  }
  const file = env[environment.integrations];
  if (!file) return options;
  const given = JSON.parse(readText(file));
  options.readLoginShell = false;
  for (const name of testOptionNames) if (given[name] !== undefined) options[name] = given[name];
  return options;
}

const known = new Set(appIds);

/** The prompt the "Try it" box offers to paste into the app's new session. */
export const tryPrompt = 'Make a one-page PDF with OpenDoc: a short memo titled Test.';

/**
 * The ids a page may send: a short list of target ids, each once. A target id is an app id, or an app id, `@` and the folder
 * (`claude@.claude-Work`, targets.mjs). Only the app part is checked here; the module then accepts the ids it found or recorded,
 * so a folder the page invents is refused there.
 */
export function cleanIds(value) {
  if (!Array.isArray(value)) return [];
  const clean = id => typeof id === 'string' && id.length <= 1024 && !/[\u0000-\u001f]/.test(id) && known.has(id.split('@', 1)[0]);
  return [...new Set(value.filter(clean))];
}

const pendingText = 'A connect did not finish. Disconnect cleans up what it added.';

/** The state of one place OpenDoc can be connected: see describeApp. `found`: the app can be connected at all. */
function stateOf(found, checked) {
  const managed = Boolean(checked?.managed);
  if (managed && !found) return 'gone';
  if (managed && checked.problem) return 'broken';
  if (managed && checked.connected === true) return 'connected';
  if (managed) return 'broken';
  if (found && checked?.connected === true) return 'outside';
  return found ? 'available' : 'absent';
}

/**
 * One row of the screen from detect()'s app and status()'s app. `state`:
 *   connected  this app set OpenDoc up in it and it is there now (`stale`: the files it holds are older than the app's)
 *   outside    OpenDoc is there, but not from this app: left alone, nothing to do
 *   broken     a record of this app's that cannot be confirmed (a connect that did not finish, or the app could not check it): Disconnect cleans up
 *   gone       this app has a record, but the app is not found any more: only Forget is possible
 *   available  can be connected
 *   absent     not on this computer
 */
export function describeApp(detected, checked) {
  return {
    id: detected.id, name: detected.name, present: detected.present, canConnect: detected.canConnect, reason: detected.reason,
    state: stateOf(detected.canConnect, checked), managed: Boolean(checked?.managed), stale: Boolean(checked?.stale), connected: checked?.connected ?? null,
    problem: checked?.problem ?? null, summary: checked?.summary ?? '',
  };
}

/** One settings folder (a target) of an app, from the module's target and, when it has been asked, its checked state. */
export function describeTarget(found, target, checked) {
  return {
    id: target.id, label: target.label, configFolder: target.configFolder, note: target.note, source: target.source, exists: target.exists, terminal: target.terminal,
    ...describeApp({ id: target.id, name: target.label, present: found, canConnect: found, reason: '' }, checked),
  };
}

/** What a target's record alone says (no vendor command has run): a record that is not pending counts as connected until a check says otherwise. */
const recordOnly = target => ({ managed: target.recorded, connected: target.recorded && !target.pending ? true : null, stale: target.stale, problem: target.pending ? pendingText : null, summary: '' });

/** The badges of a row: installed or not, how many folders are connected, and what needs attention. */
function badgesOf(app, targets) {
  const badges = [app.present ? { kind: 'installed', text: 'Installed' } : { kind: 'absent', text: 'Not installed' }];
  const connected = targets.filter(target => target.state === 'connected');
  if (connected.length) badges.push({ kind: 'connected', text: targets.length > 1 ? `Connected in ${connected.length} of ${targets.length} folders` : 'Connected' });
  if (targets.some(target => target.state === 'broken' || target.state === 'gone')) badges.push({ kind: 'broken', text: 'Needs attention' });
  if (connected.some(target => target.stale)) badges.push({ kind: 'stale', text: 'Update available' });
  return badges;
}

/** An app of the module's overview as a row; with the app's checked state (status()'s app) the targets carry what the vendor said. */
export function describeRow(app, checked = null) {
  const targets = app.targets.map(target => {
    const item = checked?.targets.find(entry => entry.id === target.id);
    return describeTarget(app.canConnect, target, item ?? recordOnly(target));
  });
  return {
    id: app.id, name: app.name, installed: app.present, canConnect: app.canConnect, reason: app.reason,
    executable: app.executable, installer: app.installer ?? null, website: app.website ?? null,
    checked: Boolean(checked), badges: badgesOf(app, targets), targets,
  };
}

/** The list: every app, then the "Other app" page's facts. Nothing here ran a vendor command. */
export function describeOverview(overview) {
  return {
    checkedAt: overview.checkedAt, problem: overview.problem ?? null, loginShell: overview.environment.loginShell,
    tryPrompt, other: overview.other, apps: overview.apps.map(app => describeRow(app)),
  };
}

/** The whole screen's data from the two calls, every folder of every app checked (the page for each app, all at once). */
export function describeApps(detection, status) {
  return {
    checkedAt: status.checkedAt,
    problem: status.problem ?? null,
    loginShell: detection.environment.loginShell,
    apps: detection.apps.map(app => {
      const checked = status.apps.find(item => item.id === app.id);
      return { ...describeApp(app, checked), targets: app.targets.map(target => describeTarget(app.canConnect, target, checked?.targets.find(item => item.id === target.id))) };
    }),
  };
}

/** The sentences to show when a startup refresh did not work, or null. An app that is gone is not nagged about (the screen offers Forget). */
export function refreshProblem(result) {
  if (!result || result.ok !== false) return null;
  const failed = (result.results ?? []).filter(item => !item.ok && item.code !== 'absent');
  const who = item => (item.targetLabel && item.target !== item.app ? `${item.name} (${item.targetLabel})` : item.name);
  const lines = failed.length ? failed.map(item => `${who(item)}: ${item.summary}`) : result.results?.length ? [] : [result.summary].filter(Boolean);
  return lines.length ? lines : null;
}

export class AiApps {
  /** @param integrations an object with the module's calls (createIntegrations(...)), or options for createIntegrations */
  constructor(integrations, { log = () => {} } = {}) {
    this.integrations = typeof integrations.detect === 'function' ? integrations : createIntegrations(integrations);
    this.log = log;
  }

  /** The list of apps: installed or not, and what this app's records say. Runs no vendor command, so it is instant. `fresh` reads the login shell again. */
  async overview({ fresh = false } = {}) {
    return describeOverview(await this.integrations.overview({ fresh: fresh === true }));
  }

  /** One app's page: the same row with the read-only vendor check of each of its folders done (about a second for Claude Code). Never throws. */
  async app(id, { fresh = false } = {}) {
    if (typeof id !== 'string' || !known.has(id)) return { ok: false, message: 'That is not an app this screen knows.' };
    try {
      const checked = await this.integrations.checkApp(id, { fresh: fresh === true });
      if (!checked.app) return { ok: false, message: checked.problem };
      return { ok: true, checkedAt: checked.checkedAt, problem: checked.problem ?? null, tryPrompt, app: describeRow(checked.app, checked.status) };
    } catch (error) { return { ok: false, message: `${error.message}` }; }
  }

  /** What a Copy button copies, by name (a page never sends the text): `prompt`, `skill-folder` or `command`. Null when there is nothing to copy. */
  async copyText(kind) {
    if (kind === 'prompt') return tryPrompt;
    if (kind !== 'skill-folder' && kind !== 'command') return null;
    const { other } = await this.integrations.overview();
    return (kind === 'skill-folder' ? other.skillFolder : other.command) ?? null;
  }

  /** Every app and folder with its vendor check done: the slow whole view (a second or two). The screen uses overview() and app(); tests use this. */
  async info() {
    const detection = await this.integrations.detect();
    const status = await this.integrations.status();
    return describeApps(detection, status);
  }

  connect(ids) { return this.integrations.connect(cleanIds(ids)); }

  /** `forget`: drop the record of an app that is gone, without running anything. */
  disconnect(ids, { forget = false } = {}) { return this.integrations.disconnect(cleanIds(ids), { forget: forget === true }); }

  /** Bring what is connected up to date with this app's files. Never throws. Returns the module's result, or { ok: false, results: [], summary }. */
  async refresh() {
    try {
      // Reinstall for the apps that keep their own copy: the user connected them to keep OpenDoc current, and the files only change
      // when an app update ships new ones. Each result is logged; a failure is shown (desktop-shell.mjs).
      const result = await this.integrations.refresh({ reinstall: true });
      this.log(`refresh: ${result.ok ? 'ok' : 'FAILED'}, ${result.summary ?? ''}`);
      for (const item of result.results ?? []) this.log(`refresh ${item.app}: ${item.ok ? 'ok' : 'FAILED'} (${item.code}) ${item.summary}`);
      return result;
    } catch (error) {
      this.log(`refresh failed: ${error.message}`);
      return { ok: false, changed: false, results: [], summary: `The check of the connected AI apps failed: ${error.message}` };
    }
  }
}
