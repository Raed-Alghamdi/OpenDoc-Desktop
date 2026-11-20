// `.opendoc/server.json`: the browser edition's session record. The app reads it to refuse a workspace whose
// browser service is running, using the same checks as runningSession() in src/cli/start.ts.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { processExists } from './process-info.mjs';

export const serverRecordFile = root => resolve(root, '.opendoc/server.json');

export async function readServerRecord(root) {
  try { return JSON.parse(await readFile(serverRecordFile(root), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; return { unreadable: true }; }
}

/**
 * Is a browser-edition service running for this workspace?
 * `none`, `running` (origin and pid), `finishing` (its pid is alive but it no longer answers), or `unknown`.
 */
export async function inspectService(root, { fetchImpl = fetch } = {}) {
  const record = await readServerRecord(root);
  if (!record) return { state: 'none' };
  if (record.unreadable || !/^http:\/\/127\.0\.0\.1:\d+$/.test(record.origin ?? '') || typeof record.token !== 'string' || !record.token) return { state: 'unknown', message: 'The session record in .opendoc/server.json cannot be read.' };
  let response;
  try { response = await fetchImpl(`${record.origin}/api/session`, { signal: AbortSignal.timeout(1500), redirect: 'error' }); }
  catch (error) {
    if (error?.cause?.code === 'ECONNREFUSED') return processExists(record.pid) ? { state: 'finishing', pid: record.pid } : { state: 'none' };
    return { state: 'unknown', message: 'The app cannot tell whether OpenDoc is already running for this workspace.' };
  }
  const live = await response.json().catch(() => null);
  if (response.ok && live?.token === record.token) return { state: 'running', origin: record.origin, pid: record.pid };
  return { state: 'unknown', message: 'The recorded OpenDoc session no longer matches the server at its address.' };
}
