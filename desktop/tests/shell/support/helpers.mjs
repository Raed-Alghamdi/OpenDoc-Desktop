import { expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { processAlive, serviceHostOf } from './processes.mjs';

/** The first render of a fresh workspace can take a while on a busy machine. */
export const slow = { timeout: 180_000 };

export const libraryReady = page => expect(page.getByText('Welcome to OpenDoc').first()).toBeVisible(slow);

export const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
export const serverRecord = workspace => readJson(join(workspace, '.opendoc', 'server.json'));
export const desktopRecord = workspace => readJson(join(workspace, '.opendoc', 'desktop.json'));

/** A pid that is certainly not running. */
export async function deadPid() {
  const child = spawn(process.execPath, ['-e', '0']);
  await new Promise(accept => child.once('exit', accept));
  return child.pid;
}

/** Is this page the OpenDoc workspace (the service's address)? */
export const isWorkspaceUrl = url => url.startsWith('app://opendoc/');

/** The pid of the app's service host (the child of the main process that runs the service), or null. */
export const hostPid = app => serviceHostOf(app.process().pid);

/** The service host's pid once it differs from `previous` (a restarted host), as soon as it is running. */
export async function nextHostPid(app, previous, milliseconds = 120_000) {
  return waitFor(() => { const pid = hostPid(app); return pid && pid !== previous && processAlive(pid) ? pid : null; }, { timeout: milliseconds, interval: 200, what: `a new service host (still ${previous})` });
}

export async function waitForExit(child, milliseconds) {
  if (child.exitCode !== null || child.signalCode) return true;
  return Promise.race([new Promise(accept => child.once('exit', () => accept(true))), new Promise(accept => setTimeout(accept, milliseconds, false))]);
}

export async function waitFor(check, { timeout = 30_000, interval = 100, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise(accept => setTimeout(accept, interval));
  }
}

/** Opening is finished when desktop.json is written and the lock taken while opening is released. */
export async function waitForOpen(workspace, milliseconds = 120_000) {
  const exists = file => access(join(workspace, '.opendoc', file)).then(() => true, () => false);
  return waitFor(async () => (await exists('desktop.json')) && !(await exists('update.lock')), { timeout: milliseconds, what: 'the workspace to be open' });
}
