// Processes of this worktree's Electron, found by executable path (never by name or by the shell's job list).
import { spawnSync } from 'node:child_process';
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

/** The command line of a process as an array, or [] when it is gone. */
export function commandLine(pid) {
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter((_, index, all) => index < all.length - 1 || all[index] !== ''); } catch { return []; }
}

/** The pid of the service host the app with this main pid runs (a run-as-Node child that carries the host's flag), or null. */
export function serviceHostOf(mainPid) {
  for (const name of readdirSync('/proc').filter(item => /^\d+$/.test(item))) {
    const info = readProcess(Number(name));
    if (info && info.ppid === mainPid && info.state !== 'Z' && commandLine(info.pid).includes('opendoc-service-host')) return info.pid;
  }
  return null;
}

/** Every process of this machine that listens on a TCP or UDP port, with the pids `ss` names for it. */
export function listeners() {
  const found = [];
  for (const flags of ['-ltnpH', '-lunpH']) {
    const result = spawnSync('ss', [flags], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`ss ${flags} failed: ${result.stderr}`);
    for (const line of result.stdout.split('\n').filter(Boolean)) {
      const columns = line.trim().split(/\s+/);
      for (const match of line.matchAll(/pid=(\d+)/g)) found.push({ pid: Number(match[1]), protocol: flags.includes('u') ? 'udp' : 'tcp', local: columns[3], line });
    }
  }
  return found;
}

/** `pid` and every process below it (children, their children, and so on), whatever they are running. */
export function processTree(pid) {
  const all = readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(name => readProcess(Number(name))).filter(Boolean);
  const found = new Set([pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const info of all) if (!found.has(info.pid) && found.has(info.ppid)) { found.add(info.pid); grew = true; }
  }
  return found;
}
