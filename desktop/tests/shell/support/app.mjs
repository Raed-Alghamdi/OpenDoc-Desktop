// Launching the app for a test: a scratch workspace (a copy of the template made with `opendoc init`), a fresh
// profile folder, and Playwright's Electron driver on the virtual display.
import { _electron } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { electronEnvironment } from './environment.mjs';
import { electronExecutable, goldenWorkspace, mainEntry, runtimeDir, workDir } from './paths.mjs';

let counter = 0;

/** A new scratch workspace: a reflink copy of the template, so the copy is cheap and independent. */
export async function newWorkspace(name = 'ws') {
  const target = join(workDir, `${name}-${++counter}`);
  await mkdir(workDir, { recursive: true });
  const copy = spawnSync('cp', ['-a', '--reflink=auto', goldenWorkspace, target], { encoding: 'utf8' });
  if (copy.status !== 0) throw new Error(`Could not copy the template workspace: ${copy.stderr}`);
  await rm(join(target, '.opendoc', 'server.json'), { force: true });
  return target;
}

/** A fresh profile folder (Electron's userData, which also holds config.json). */
export async function newProfile(name = 'profile', config) {
  const folder = join(workDir, `${name}-${++counter}`);
  await mkdir(folder, { recursive: true });
  if (config) await writeFile(join(folder, 'config.json'), JSON.stringify(config));
  return folder;
}

export const readConfig = async profile => JSON.parse(await readFile(join(profile, 'config.json'), 'utf8'));

export function appArguments(profile, extra = []) {
  return ['--ozone-platform=x11', `--user-data-dir=${profile}`, ...extra, mainEntry];
}

function builtTarball() {
  try { return readFileSync(join(runtimeDir, '.built-from'), 'utf8'); } catch { return process.env.OPENDOC_SHELL_TEST_TARBALL ?? ''; }
}

export function appEnvironment(extra = {}) {
  return electronEnvironment({
    OPENDOC_DESKTOP_RUNTIME: runtimeDir,
    // `opendoc init` installs the package from the tarball the global setup built, so no test needs the network.
    OPENDOC_PACKAGE_TARBALL: builtTarball(),
    // The OS file manager and browser are never started: tests stub shell and dialog calls in the main process.
    ...extra,
  });
}

/** Start the app with Playwright and wait for its first window. */
export async function launchApp({ profile, env, args } = {}) {
  const app = await _electron.launch({ executablePath: electronExecutable, args: appArguments(profile, args), env: appEnvironment(env), timeout: 90_000 });
  // What the main process prints (the service supervisor logs here), for failures and for tests that read it.
  app.output = [];
  for (const stream of [app.process().stdout, app.process().stderr]) stream?.on('data', chunk => app.output.push(String(chunk)));
  // Console errors and warnings of every window, so a test can assert that the pages ran clean.
  app.consoleProblems = [];
  const watch = page => page.on('console', message => { if (['error', 'warning'].includes(message.type())) app.consoleProblems.push(`${message.type()}: ${message.text()}`); });
  app.windows().forEach(watch);
  app.on('window', watch);
  return app;
}

/** Start the app without Playwright (for a second launch, or to kill the main process by hand). */
export function spawnApp({ profile, env, args } = {}) {
  return spawn(electronExecutable, appArguments(profile, args), { env: appEnvironment(env), stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Replace Electron's native dialogs and "open in the OS" calls with recorders in the main process.
 * `config`: openDialog (what showOpenDialog returns), saveDialog, messageChoice (a button label or index).
 * Change the answers later with setNative; read what was asked with nativeCalls.
 */
export async function stubNative(app, config = {}) {
  await app.evaluate(({ dialog, shell }, initial) => {
    const state = globalThis.__native = { config: initial, external: [], folders: [], messages: [], saves: [], opens: [] };
    const choose = options => {
      const wanted = state.config.messageChoice;
      const index = typeof wanted === 'number' ? wanted : (options.buttons ?? []).indexOf(wanted);
      return index >= 0 ? index : 0;
    };
    shell.openExternal = async url => { state.external.push(url); };
    shell.showItemInFolder = path => { state.folders.push(path); };
    shell.openPath = async path => { state.folders.push(path); return ''; };
    dialog.showOpenDialog = async (...args) => { state.opens.push(args.at(-1)); return state.config.openDialog ?? { canceled: true, filePaths: [] }; };
    dialog.showSaveDialog = async (...args) => { state.saves.push(args.at(-1)); return state.config.saveDialog ?? { canceled: true }; };
    dialog.showMessageBox = async (...args) => { const options = args.at(-1); state.messages.push(options); return { response: choose(options), checkboxChecked: false }; };
    dialog.showMessageBoxSync = (...args) => { const options = args.at(-1); state.messages.push(options); return choose(options); };
  }, config);
}

export const setNative = (app, config) => app.evaluate((_electron, next) => { Object.assign(globalThis.__native.config, next); }, config);
export const nativeCalls = app => app.evaluate(() => { const { config, ...calls } = globalThis.__native; return calls; });
