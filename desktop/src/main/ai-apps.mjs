// "Connect your AI apps": the shell's layer over the integration module (src/main/integrations). It builds the one
// module instance of an app run, turns detect() and status() into the rows the screen draws, and keeps the startup refresh.
// The screen itself is renderer/ai-apps.html; the calls it makes are registered in desktop-shell.mjs.
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

/** The ids a page may send: a short list of known app ids, each once. */
export function cleanIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(id => typeof id === 'string' && known.has(id)))];
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
  const found = detected.canConnect;
  const managed = Boolean(checked?.managed);
  let state;
  if (managed && !found) state = 'gone';
  else if (managed && checked.problem) state = 'broken';
  else if (managed && checked.connected === true) state = 'connected';
  else if (managed) state = 'broken';
  else if (found && checked?.connected === true) state = 'outside';
  else if (found) state = 'available';
  else state = 'absent';
  return {
    id: detected.id, name: detected.name, present: detected.present, canConnect: found, reason: detected.reason,
    state, managed, stale: Boolean(checked?.stale), connected: checked?.connected ?? null,
    problem: checked?.problem ?? null, summary: checked?.summary ?? '',
  };
}

/** The whole screen's data from the two calls. */
export function describeApps(detection, status) {
  return {
    checkedAt: status.checkedAt,
    problem: status.problem ?? null,
    loginShell: detection.environment.loginShell,
    apps: detection.apps.map(app => describeApp(app, status.apps.find(item => item.id === app.id))),
  };
}

/** The sentences to show when a startup refresh did not work, or null. An app that is gone is not nagged about (the screen offers Forget). */
export function refreshProblem(result) {
  if (!result || result.ok !== false) return null;
  const failed = (result.results ?? []).filter(item => !item.ok && item.code !== 'absent');
  const lines = failed.length ? failed.map(item => `${item.name}: ${item.summary}`) : result.results?.length ? [] : [result.summary].filter(Boolean);
  return lines.length ? lines : null;
}

export class AiApps {
  /** @param integrations an object with the module's calls (createIntegrations(...)), or options for createIntegrations */
  constructor(integrations, { log = () => {} } = {}) {
    this.integrations = typeof integrations.detect === 'function' ? integrations : createIntegrations(integrations);
    this.log = log;
  }

  /** What the screen draws: every app, found or not, and whether it is connected. A second or two (login shell and vendor `list` commands). */
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
