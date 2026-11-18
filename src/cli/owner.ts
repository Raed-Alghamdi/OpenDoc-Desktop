import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Who has a workspace open: the browser edition's service (`.opendoc/server.json`), the
 * desktop app (`.opendoc/desktop.json`), or nobody. Every command that must behave differently
 * beside an owner asks here instead of reading those files itself.
 */
export interface WorkspaceOwner { mode: 'service' | 'desktop' | null; pid?: number; origin?: string }

/** An unreadable or malformed session file; the caller adds what to do about it. */
export class InvalidOwnerRecord extends Error {
  constructor() { super('The local OpenDoc session file is invalid.'); }
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

/** The desktop app's record while its process is alive. A dead pid, or a file that cannot be read, is a stale record and means no owner. */
async function desktopOwner(root: string): Promise<{ pid: number } | null> {
  let record: { pid?: unknown } | null;
  try { const text = await readRecord(root, 'desktop.json'); record = text === null ? null : JSON.parse(text); }
  catch { return null; }
  return alive(record?.pid) ? { pid: record!.pid as number } : null;
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
async function verifiedService(root: string): Promise<{ origin: string; token: string; pid: number } | null> {
  let session: { origin: string; token: string; pid: number };
  try {
    const text = await readRecord(root, 'server.json');
    if (text === null) return null;
    session = JSON.parse(text);
  }
  catch { throw new Error('Cannot read the OpenDoc session. Check .opendoc/server.json before starting another server.'); }
  if (!origins.test(session?.origin ?? '') || typeof session.token !== 'string' || !session.token) throw new Error('The OpenDoc session record is invalid. Check .opendoc/server.json before starting another server.');
  let response;
  try { response = await fetch(`${session.origin}/api/session`, { signal: AbortSignal.timeout(1500), redirect: 'error' }); }
  catch (error) {
    if ((error as { cause?: { code?: string } }).cause?.code === 'ECONNREFUSED') {
      if (validPid(session.pid)) {
        try { process.kill(session.pid, 0); }
        catch (ownerError) { if ((ownerError as NodeJS.ErrnoException).code === 'ESRCH') return null; throw ownerError; }
        throw new OwnerShuttingDown();
      }
      return null;
    }
    throw new Error('Cannot verify whether OpenDoc is running. Check its terminal before starting another server.');
  }
  const live = await response.json().catch(() => null);
  if (response.ok && live?.token === session.token) return { origin: session.origin, token: session.token, pid: session.pid };
  throw new Error('The recorded OpenDoc session no longer matches the server at its address. Stop the previous server and remove the stale .opendoc/server.json before retrying.');
}

/**
 * The service's session as well as its owner, for the commands that call the service. The token
 * is for those calls only: keep it out of anything printed.
 *
 * By default a recorded service must answer with its own token, and one that refuses connections
 * while its process still runs is an error. `verify: false` reads the record alone and drops it when
 * its pid is gone, for the commands that make their own request and fall back when it fails.
 */
export async function workspaceSession(root: string, options: { verify?: boolean } = {}): Promise<{ owner: WorkspaceOwner; token?: string }> {
  const desktop = await desktopOwner(root);
  if (desktop) return { owner: { mode: 'desktop', pid: desktop.pid } };
  const service = options.verify === false ? await recordedService(root) : await verifiedService(root);
  return service ? { owner: { mode: 'service', origin: service.origin, ...(service.pid === undefined ? {} : { pid: service.pid }) }, token: service.token } : { owner: { mode: null } };
}

export async function workspaceOwner(root: string, options: { verify?: boolean } = {}): Promise<WorkspaceOwner> {
  return (await workspaceSession(root, options)).owner;
}
