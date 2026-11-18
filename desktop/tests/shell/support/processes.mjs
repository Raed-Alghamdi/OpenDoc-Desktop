// Processes of this worktree's Electron, found by executable path (never by name or by the shell's job list).
import { readdirSync, readlinkSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { electronExecutable, unpackedDir } from './paths.mjs';

const electronFolder = dirname(electronExecutable);

function readProcess(pid) {
  try {
    const exe = readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, '');
    const status = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const after = status.slice(status.lastIndexOf(')') + 2).split(' ');
    return { pid, exe, state: after[0], ppid: Number(after[1]) };
  } catch { return null; }
}

/** Every process whose executable is this worktree's Electron binary, or a helper that ships beside it. */
export function electronProcesses() {
  return readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(name => readProcess(Number(name)))
    .filter(info => info && (info.exe === electronExecutable || dirname(info.exe) === electronFolder || dirname(info.exe) === unpackedDir) && info.state !== 'Z');
}

export function killElectronProcesses() {
  const found = electronProcesses();
  for (const { pid } of found) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  return found;
}

export async function waitForNoElectron(milliseconds) {
  const deadline = Date.now() + milliseconds;
  for (;;) {
    const found = electronProcesses();
    if (!found.length || Date.now() >= deadline) return found;
    await new Promise(accept => setTimeout(accept, 100));
  }
}

export function processAlive(pid) {
  try { process.kill(pid, 0); return readProcess(pid)?.state !== 'Z'; } catch { return false; }
}
