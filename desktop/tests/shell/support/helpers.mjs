import { expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { processAlive } from './processes.mjs';

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

/** The service's pid once it differs from `previous` and the service answers. */
export async function nextServicePid(workspace, previous, milliseconds = 120_000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    try {
      const record = await serverRecord(workspace);
      if (record.pid !== previous && processAlive(record.pid) && (await fetch(`${record.origin}/api/session`, { signal: AbortSignal.timeout(2000) })).ok) return record;
    } catch { /* not yet */ }
    await new Promise(accept => setTimeout(accept, 250));
  }
  throw new Error(`The service did not come back (still pid ${previous}).`);
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
