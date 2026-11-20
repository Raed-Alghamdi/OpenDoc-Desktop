// Launching the app for a test: a scratch workspace (a copy of the template made with `opendoc init`), a fresh
// profile folder, and Playwright's Electron driver on the virtual display.
import { _electron } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { electronEnvironment } from './environment.mjs';
import { electronExecutable, goldenWorkspace, mainEntry, npmCache, npmGoldenWorkspace, runtimeDir, workDir } from './paths.mjs';

let counter = 0;

/**
 * A new scratch workspace: a reflink copy of a template, so the copy is cheap and independent.
 * By default it is set up the way the app leaves a workspace it opened: node_modules is a link to the test runtime, the
 * marker says `managed`, and it has the package-lock.json an npm device would have synced with it (the app must never touch
 * that file; `{ lock: false }` leaves it out, as in a workspace the app created). `{ npm: true }` is the workspace as npm
 * leaves it: a real node_modules folder, the lock, and a marker without `managed`.
 */
export async function newWorkspace(name = 'ws', { npm = false, lock = true } = {}) {
  const target = join(workDir, `${name}-${++counter}`);
  await mkdir(workDir, { recursive: true });
  if (npm) {
    const copy = spawnSync('cp', ['-a', '--reflink=auto', npmGoldenWorkspace, target], { encoding: 'utf8' });
    if (copy.status !== 0) throw new Error(`Could not copy the template workspace: ${copy.stderr}`);
  } else {
    await mkdir(target);
    for (const entry of await readdir(goldenWorkspace)) {
      if (entry === 'node_modules') continue;
      const copy = spawnSync('cp', ['-a', '--reflink=auto', join(goldenWorkspace, entry), join(target, entry)], { encoding: 'utf8' });
      if (copy.status !== 0) throw new Error(`Could not copy the template workspace: ${copy.stderr}`);
    }
    await symlink(join(runtimeDir, 'node_modules'), join(target, 'node_modules'), 'dir');
    const marker = join(target, '.opendoc', 'workspace.json');
    await writeFile(marker, `${JSON.stringify({ ...JSON.parse(await readFile(marker, 'utf8')), managed: true }, null, 2)}\n`);
    if (lock) await cp(join(npmGoldenWorkspace, 'package-lock.json'), join(target, 'package-lock.json'));
  }
  await rm(join(target, '.opendoc', 'server.json'), { force: true });
  return target;
}

/** A scratch HOME with its own XDG folders, so no test ever reads or writes the real ~/.config, ~/.local/share or ~/.cache. */
export function newHome(name = 'home') {
  const home = join(workDir, `${name}-${++counter}`);
  for (const folder of ['.config', '.local/share', '.cache']) mkdirSync(join(home, folder), { recursive: true });
  return home;
}

/** Where the app keeps its data (backups, the AppImage's runtime copy) for a launch with this HOME. */
export const dataFolder = home => join(home, '.local', 'share', 'opendoc-desktop');

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
  const home = extra.HOME ?? newHome();
  return electronEnvironment({
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    npm_config_cache: npmCache,
    OPENDOC_DESKTOP_RUNTIME: runtimeDir,
    // `opendoc init` installs the package from the tarball the global setup built, so no test needs the network.
    OPENDOC_PACKAGE_TARBALL: builtTarball(),
    // The OS file manager and browser are never started: tests stub shell and dialog calls in the main process.
    ...extra,
  });
}

/** Start the app with Playwright and wait for its first window. */
export async function launchApp({ profile, env, args } = {}) {
  const environment = appEnvironment(env);
  const app = await _electron.launch({ executablePath: electronExecutable, args: appArguments(profile, args), env: environment, timeout: 90_000 });
  app.home = environment.HOME;
  app.profile = profile;
  app.dataFolder = dataFolder(environment.HOME);
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
 * `config`: openDialog (what showOpenDialog returns), saveDialog, messageChoice (a button label or index, or an object of those by box title),
 * checkboxChecked (the answer for a box that has a checkbox).
 * Change the answers later with setNative; read what was asked with nativeCalls.
 */
export async function stubNative(app, config = {}) {
  await app.evaluate(({ dialog, shell }, initial) => {
    const state = globalThis.__native = { config: initial, external: [], folders: [], messages: [], saves: [], opens: [], trashed: [] };
    const choose = options => {
      // `messageChoice` is one answer for every box, or an object that answers by the box's title (a box not named gets the first button).
      const given = state.config.messageChoice;
      const wanted = given && typeof given === 'object' ? given[options.title] : given;
      const index = typeof wanted === 'number' ? wanted : (options.buttons ?? []).indexOf(wanted);
      return index >= 0 ? index : 0;
    };
    shell.openExternal = async url => { state.external.push(url); };
    shell.showItemInFolder = path => { state.folders.push(path); };
    shell.openPath = async path => { state.folders.push(path); return ''; };
    dialog.showOpenDialog = async (...args) => { state.opens.push(args.at(-1)); return state.config.openDialog ?? { canceled: true, filePaths: [] }; };
    dialog.showSaveDialog = async (...args) => { state.saves.push(args.at(-1)); return state.config.saveDialog ?? { canceled: true }; };
    dialog.showMessageBox = async (...args) => { const options = args.at(-1); state.messages.push(options); return { response: choose(options), checkboxChecked: Boolean(options.checkboxLabel && state.config.checkboxChecked) }; };
    // The OS trash is never used: a trashed item is moved into <XDG_DATA_HOME>/Trash and recorded.
    shell.trashItem = async path => {
      const fs = process.getBuiltinModule('node:fs/promises'); // a dynamic import does not work in this context
      const path_ = process.getBuiltinModule('node:path');
      state.trashed.push(path);
      const folder = path_.join(process.env.XDG_DATA_HOME ?? '/nonexistent', 'Trash');
      await fs.mkdir(folder, { recursive: true });
      await fs.rename(path, path_.join(folder, `${path_.basename(path)}-${state.trashed.length}`));
    };
    dialog.showMessageBoxSync = (...args) => { const options = args.at(-1); state.messages.push(options); return choose(options); };
  }, config);
}

export const setNative = (app, config) => app.evaluate((_electron, next) => { Object.assign(globalThis.__native.config, next); }, config);
export const nativeCalls = app => app.evaluate(() => { const { config, ...calls } = globalThis.__native; return calls; });
