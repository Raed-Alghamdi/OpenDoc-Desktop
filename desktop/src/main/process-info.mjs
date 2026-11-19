// Questions about other processes, answered without running anything on the user's behalf.
import { execFileSync } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import { basename } from 'node:path';

export function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2 ** 31 - 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

/** Whether `pid` runs the same program as this process (the app's executable), as opposed to a reused pid. */
export function runsSameProgram(pid, execPath = process.execPath) {
  if (!processExists(pid)) return false;
  try {
    if (process.platform === 'linux') return basename(readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, '')) === basename(execPath);
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' }).trim();
    return basename(command) === basename(execPath);
  } catch {
    // The process may have ended, or we may not be allowed to look: a live pid we cannot identify counts as live.
    return processExists(pid);
  }
}
