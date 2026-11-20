// The packaged app under test (E10): where it is, which fuses it carries, which processes belong to it, and how to start it so
// that Playwright can drive its window. The app is started by hand and attached to over the DevTools protocol, because the
// shipped build has the Node inspector switched off (the EnableNodeCliInspectArguments fuse), and Playwright's `_electron.launch`
// reaches the main process through that inspector. The page API is all these tests need.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

export const desktop = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
export const virtualDisplayMarker = 'OPENDOC_E10_XVFB';
export const isMac = process.platform === 'darwin';
const strippedVariables = ['ELECTRON_FORCE_IS_PACKAGED', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_OZONE_PLATFORM_HINT', 'ELECTRON_PA_APP_NAME', 'WAYLAND_DISPLAY', 'OZONE_PLATFORM',
  'XDG_BACKEND', 'HYPRLAND_INSTANCE_SIGNATURE', 'XDG_CURRENT_DESKTOP', 'GDK_SCALE', 'GDK_DPI_SCALE', 'QT_SCALE_FACTOR', 'APPIMAGE', 'APPDIR', 'ARGV0', 'OWD', 'NODE_OPTIONS'];

/** `{ root, executable, resources }` of the packaged app: $OPENDOC_E10_APP (the linux-unpacked folder or the .app bundle), else desktop/dist. */
export function locateApp(env = process.env) {
  let root = env.OPENDOC_E10_APP;
  if (!root) {
    const dist = path.join(desktop, 'dist');
    if (isMac) {
      const folder = existsSync(dist) ? readdirSync(dist).find((name) => /^mac/.test(name) && existsSync(path.join(dist, name, 'opendoc-desktop.app'))) : undefined;
      root = folder && path.join(dist, folder, 'opendoc-desktop.app');
    } else root = path.join(dist, 'linux-unpacked');
  }
  if (!root || !existsSync(root)) throw new Error(`No packaged app found (${root ?? 'desktop/dist/mac*/opendoc-desktop.app'}). Build one with node desktop/runtime/dist.mjs, or set OPENDOC_E10_APP.`);
  root = path.resolve(root);
  return isMac
    ? { root, executable: path.join(root, 'Contents', 'MacOS', 'opendoc-desktop'), resources: path.join(root, 'Contents', 'Resources') }
    : { root, executable: path.join(root, 'opendoc-desktop'), resources: path.join(root, 'resources') };
}

/** The fuses of the binary as `{ RunAsNode: true, ... }`, read from the file (never by running it). */
export async function readFuses(executable) {
  const abl = createRequire(createRequire(path.join(desktop, 'package.json')).resolve('electron-builder/package.json'));
  const fuses = createRequire(abl.resolve('app-builder-lib/package.json'))('@electron/fuses');
  const wire = await fuses.getCurrentFuseWire(executable);
  const state = {};
  for (const [name, index] of Object.entries(fuses.FuseV1Options)) if (typeof index === 'number') state[name] = wire[index] === 49; // '1' enabled, '0' disabled
  return state;
}

/** Electron's environment for a test: the display, Wayland and Electron variables of the desktop removed, and a scratch home. */
export function appEnvironment(home, base = process.env) {
  if (!isMac && (base[virtualDisplayMarker] !== '1' || base.WAYLAND_DISPLAY)) {
    throw new Error('Refusing to run: these tests open a window and must run on a virtual display. Use node desktop/tests/smoke/run.mjs.');
  }
  const env = { ...base };
  for (const name of strippedVariables) delete env[name];
  return { ...env, HOME: home, TMPDIR: path.join(home, 'tmp'), XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'), XDG_CACHE_HOME: path.join(home, 'cache'), GDK_BACKEND: 'x11', GDK_SCALE: '1' };
}

/** Every process on the machine as `{ pid, ppid, command }`. */
export function processList() {
  const result = spawnSync('ps', ['-axww', '-o', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (result.status !== 0) throw new Error(`ps failed: ${result.stderr}`);
  return result.stdout.split('\n').map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }));
}

/** Processes started from inside the app folder (the main process, its helpers and the service host). */
export const appProcesses = (root) => processList().filter((item) => item.command.startsWith(`${root}${path.sep}`));

/** The service host of the app with this main pid: a child that carries the host flag. */
export const serviceHostOf = (mainPid) => processList().find((item) => item.ppid === mainPid && item.command.includes('opendoc-service-host')) ?? null;

/**
 * The watcher shell the host leaves outside the app: `/bin/sh -c '<script>' opendoc-sentinel <app pid> <host pid>`.
 * Found by its name and the app's pid, not by the script's text, which may change.
 */
export const sentinelsOf = (mainPid) => processList().filter((item) => new RegExp(`\\sopendoc-sentinel ${mainPid}\\s`).test(item.command));

export async function waitUntil(check, { timeout = 30_000, interval = 100, what = 'the condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((accept) => setTimeout(accept, interval));
  }
}

/**
 * Start the app on `workspaceProfile` (a user-data folder whose config.json names the workspace) and attach Playwright.
 * Returns `{ child, browser, page, output }`; `output` collects what the main process prints.
 */
export async function launchApp({ app, profile, env }) {
  const args = [`--user-data-dir=${profile}`, '--remote-debugging-port=0'];
  if (!isMac) args.unshift('--ozone-platform=x11');
  const child = spawn(app.executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const output = [];
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => output.push(String(chunk)));
  let exited = false;
  child.once('exit', () => { exited = true; });
  const portFile = path.join(profile, 'DevToolsActivePort');
  const port = await waitUntil(() => {
    if (exited) throw new Error(`The app exited before it was ready (${child.exitCode ?? child.signalCode}):\n${output.join('').slice(-2000)}`);
    return existsSync(portFile) && readFileSync(portFile, 'utf8').split('\n')[0];
  }, { timeout: 90_000, what: 'the app to open its debugging port' });
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? await context.waitForEvent('page', { timeout: 60_000 });
  return { child, browser, page, output, exited: () => exited };
}
