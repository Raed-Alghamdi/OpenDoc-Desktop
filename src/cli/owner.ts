import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { promisify } from 'node:util';

/**
 * Who has a workspace open: the browser edition's service (`.opendoc/server.json`), the
 * desktop app (`.opendoc/desktop.json`), or nobody. Every command that must behave differently
 * beside an owner asks here instead of reading those files itself.
 */
export interface WorkspaceOwner { mode: 'service' | 'desktop' | null; pid?: number; origin?: string }

/** An unreadable or malformed session file. Unless its message already says what to do (advice ''), the caller adds that. */
export class InvalidOwnerRecord extends Error {
  constructor(message = 'The local OpenDoc session file is invalid.', public advice?: string) { super(message); }
}

/** What to do about a record that names opendoc-desktop; every refusal that cites the app ends with it. */
export const desktopRecordAdvice = 'If opendoc-desktop is not running, delete .opendoc/desktop.json and try again.';

/** An error from the owner helper, as the message a command shows: the record's own advice, or the command's. */
export function ownerFailure(error: unknown, advice: string) {
  return error instanceof InvalidOwnerRecord ? new Error([error.message, error.advice ?? advice].filter(Boolean).join(' ')) : error;
}

/** The recorded service refuses connections but its process still runs: it is finishing shutdown. */
export class OwnerShuttingDown extends Error {
  constructor() { super('OpenDoc is still finishing its previous session. Wait for its terminal to stop, then retry.'); }
}

const origins = /^http:\/\/127\.0\.0\.1:\d+$/;
const validPid = (pid: unknown): pid is number => Number.isSafeInteger(pid) && (pid as number) > 0 && (pid as number) <= 2 ** 31 - 1;

function alive(pid: unknown): pid is number {
  if (!validPid(pid)) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

async function readRecord(root: string, file: string): Promise<string | null> {
  try { return await readFile(resolve(root, '.opendoc', file), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

const names = new Set(['opendoc-desktop', 'electron']);
const run = promisify(execFile);

/** Whether a live process is opendoc-desktop (or the Electron of a development run). A process whose name cannot be read counts as the app. */
async function isDesktopApp(pid: number): Promise<boolean> {
  const linux = process.platform === 'linux';
  try {
    const name = linux ? (await readFile(`/proc/${pid}/comm`, 'utf8')).trim() : basename((await run('ps', ['-p', String(pid), '-o', 'comm='], { timeout: 5000 })).stdout.trim());
    return names.has(name.toLowerCase());
  } catch (error) {
    // The process ended since the liveness check: /proc/<pid> is gone on Linux, and ps exits 1 on macOS.
    const code = (error as { code?: unknown }).code;
    return !(linux ? code === 'ENOENT' : code === 1);
  }
}

/** Replaceable in tests, which stand in for the app with an ordinary process. */
export const ownerProbe = { isDesktopApp };

async function desktopRecord(root: string): Promise<{ pid?: unknown } | null> {
  const text = await readRecord(root, 'desktop.json');
  if (text === null) return null;
  const record = JSON.parse(text);
  if (!record || typeof record !== 'object' || !validPid(record.pid)) throw new Error('Not a desktop record.');
  return record;
}

/**
 * The desktop app's record while its process is alive and is opendoc-desktop. A missing file, a dead
 * pid, or a pid that now belongs to another program is stale. A file that cannot be read or understood
 * is not: the app may be rewriting it, so it is read once more, and then refused rather than ignored.
 */
async function desktopOwner(root: string): Promise<{ pid: number } | null> {
  let record: { pid?: unknown } | null;
  try { record = await desktopRecord(root); }
  catch {
    await setTimeout(100);
    try { record = await desktopRecord(root); }
    catch { throw new InvalidOwnerRecord(`The opendoc-desktop record .opendoc/desktop.json cannot be read. ${desktopRecordAdvice}`, ''); }
  }
  const pid = record?.pid;
  return alive(pid) && await ownerProbe.isDesktopApp(pid) ? { pid } : null;
}

/** Just the recorded process of a running service, however little else of its record can be trusted. */
async function recordedProcess(root: string): Promise<{ origin?: string; pid: number } | null> {
  try {
    const record = JSON.parse(await readRecord(root, 'server.json') ?? 'null');
    if (!alive(record?.pid)) return null;
    return { pid: record.pid, ...(typeof record.origin === 'string' && origins.test(record.origin) ? { origin: record.origin } : {}) };
  } catch { return null; }
}

/** The service recorded in server.json, checked against that file alone: nothing is asked of the server itself. */
async function recordedService(root: string): Promise<{ origin: string; token: string; pid?: number } | null> {
  const text = await readRecord(root, 'server.json');
  if (text === null) return null;
  let record: { origin?: unknown; token?: unknown; pid?: unknown } | null;
  try { record = JSON.parse(text); } catch { throw new InvalidOwnerRecord(); }
  if (typeof record?.origin !== 'string' || !origins.test(record.origin) || typeof record.token !== 'string' || !record.token) throw new InvalidOwnerRecord();
  const pid = validPid(record.pid) ? record.pid : undefined;
  // A recorded process that is gone left the file behind.
  if (pid !== undefined && !alive(pid)) return null;
  return { origin: record.origin, token: record.token, pid };
}

/** The service recorded in server.json, confirmed by asking the server at that address for its token. */
async function verifiedService(root: string): Promise<{ origin: string; token: string; pid?: number } | null> {
  let session: { origin: string; token: string; pid: number };
  try {
    const text = await readRecord(root, 'server.json');
    if (text === null) return null;
    session = JSON.parse(text);
  }
  catch { throw new Error('Cannot read the OpenDoc session. Check .opendoc/server.json before starting another server.'); }
  if (!origins.test(session?.origin ?? '') || typeof session.token !== 'string' || !session.token) throw new Error('The OpenDoc session record is invalid. Check .opendoc/server.json before starting another server.');
  // A recorded process that is gone left the file behind, whatever now answers at its address.
  if (validPid(session.pid) && !alive(session.pid)) return null;
  let response;
  try { response = await fetch(`${session.origin}/api/session`, { signal: AbortSignal.timeout(1500), redirect: 'error' }); }
  catch (error) {
    if ((error as { cause?: { code?: string } }).cause?.code === 'ECONNREFUSED') {
      if (validPid(session.pid)) throw new OwnerShuttingDown();
      return null;
    }
    throw new Error('Cannot verify whether OpenDoc is running. Check its terminal before starting another server.');
  }
  const live = await response.json().catch(() => null);
  if (response.ok && live?.token === session.token) return { origin: session.origin, token: session.token, pid: validPid(session.pid) ? session.pid : undefined };
  throw new Error('The recorded OpenDoc session no longer matches the server at its address. Stop the previous server and remove the stale .opendoc/server.json before retrying.');
}

/**
 * The service's session as well as its owner, for the commands that call the service. The token
 * is for those calls only: keep it out of anything printed.
 *
 * By default a recorded service must answer with its own token, and one that refuses connections
 * while its process still runs is an error. `verify: false` reads the record alone and drops it when
 * its pid is gone, for the commands that make their own request and fall back when it fails.
 * `pidOnly` goes one step further and asks only whether the recorded process is alive, however
 * little else of the record is usable.
 */
export async function workspaceSession(root: string, options: { verify?: boolean; pidOnly?: boolean } = {}): Promise<{ owner: WorkspaceOwner; token?: string }> {
  const desktop = await desktopOwner(root);
  if (desktop) return { owner: { mode: 'desktop', pid: desktop.pid } };
  if (options.pidOnly) {
    const recorded = await recordedProcess(root);
    return { owner: recorded ? { mode: 'service', pid: recorded.pid, ...(recorded.origin ? { origin: recorded.origin } : {}) } : { mode: null } };
  }
  const service = options.verify === false ? await recordedService(root) : await verifiedService(root);
  return service ? { owner: { mode: 'service', origin: service.origin, ...(service.pid === undefined ? {} : { pid: service.pid }) }, token: service.token } : { owner: { mode: null } };
}

export async function workspaceOwner(root: string, options: { verify?: boolean; pidOnly?: boolean } = {}): Promise<WorkspaceOwner> {
  return (await workspaceSession(root, options)).owner;
}
