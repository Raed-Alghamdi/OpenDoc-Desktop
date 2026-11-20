// Running a program on the user's behalf, and reading their login shell. Nothing here decides what to run.
import { spawn } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { basename, delimiter, isAbsolute } from 'node:path';

export const outputLimit = 16 * 1024;

// Escape sequences and carriage returns that a vendor tool may add; the screen shows plain text.
const escapeSequences = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const tidy = text => text.replace(escapeSequences, '').replace(/\r\n?/g, '\n').trim();

/** `claude plugin list --json`, as it would be typed (arguments with spaces are quoted). Only for display. */
export function displayCommand(file, args) {
  const quote = value => (/^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`);
  return [basename(file), ...args].map(quote).join(' ');
}

/** Run `file` with `args` (no shell), never through a terminal, with no input, a time limit and capped output.
 *  Always resolves: `{ ok, exitCode, signal, timedOut, spawnError, stdout, stderr, output, command }`. */
export function runProgram(file, args, { env = process.env, cwd, timeoutMs = 60_000, limit = outputLimit } = {}) {
  return new Promise(resolve => {
    const started = Date.now();
    const result = { ok: false, exitCode: null, signal: null, timedOut: false, spawnError: null, stdout: '', stderr: '', output: '', command: displayCommand(file, args), durationMs: 0 };
    let child;
    try { child = spawn(file, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true }); }
    catch (error) { result.spawnError = error.message; resolve(result); return; }

    const chunks = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    for (const name of ['stdout', 'stderr']) {
      child[name].on('data', chunk => {
        if (sizes[name] >= limit) return;
        const room = limit - sizes[name];
        chunks[name].push(chunk.length > room ? chunk.subarray(0, room) : chunk);
        sizes[name] += Math.min(chunk.length, room);
      });
      child[name].on('error', () => {});
    }
    const timer = setTimeout(() => {
      result.timedOut = true;
      // The group, so a vendor tool's own children do not keep the pipes open.
      try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
    }, timeoutMs);

    const finish = () => {
      clearTimeout(timer);
      result.stdout = tidy(Buffer.concat(chunks.stdout).toString('utf8'));
      result.stderr = tidy(Buffer.concat(chunks.stderr).toString('utf8'));
      result.output = [result.stdout, result.stderr].filter(Boolean).join('\n');
      result.durationMs = Date.now() - started;
      result.ok = result.exitCode === 0 && !result.timedOut && !result.spawnError;
      resolve(result);
    };
    child.on('error', error => { result.spawnError = error.message; finish(); });
    child.on('close', (code, signal) => { result.exitCode = code; result.signal = signal; finish(); });
  });
}

const policyWords = /polic(y|ies)|managed (settings|by)|organi[sz]ation|enterprise|administrator|not (allowed|permitted)|disallowed|blocked|prohibited|forbidden|allowlist|allow-list|knownmarketplaces/i;

/** A short code for a failed run: `not-found`, `timeout`, `blocked` (the output reads like a policy refusal) or `failed`. */
export function failureCode(result) {
  if (result.spawnError) return 'not-found';
  if (result.timedOut) return 'timeout';
  return policyWords.test(result.output) ? 'blocked' : 'failed';
}

export async function isRunnable(path) {
  try { await access(path, constants.X_OK); return true; } catch { return false; }
}

/** The names asked for, read from what the login shell's environment dump prints. Lines that are not NAME=value are ignored (a profile may print
 *  a banner), and the last assignment of a name wins. Names not asked for are never kept. */
export function parseEnvironment(text, names) {
  const wanted = new Set(names);
  const variables = {};
  for (const line of text.split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match && wanted.has(match[1])) variables[match[1]] = match[2];
  }
  return variables;
}

/** The program that prints the environment, by absolute path when there is one: a profile need not put the system folders on PATH
 *  (Ubuntu's /etc/profile sets none), and a bare `env` would then be not found. `/usr/bin/env` exists on Linux and macOS. */
export const environmentCommand = (exists = existsSync) => (exists('/usr/bin/env') ? '/usr/bin/env' : 'env');

/** Ask the user's login shell for `names`: `$SHELL -lc /usr/bin/env` (plain `env` when that file is missing), with a time limit. Resolves `{ ok, shell, variables, error }`; never throws.
 *  The app's own environment (a launcher or the Dock) often lacks what the user's profile sets. */
export async function readLoginEnvironment({ shell, env = process.env, names, timeoutMs = 8000, cwd }) {
  if (process.platform === 'win32') return { ok: false, shell: null, variables: {}, error: 'Login shells are not read on Windows.' };
  if (typeof shell !== 'string' || !shell.startsWith('/')) return { ok: false, shell: shell ?? null, variables: {}, error: 'No login shell is set (SHELL is empty or not an absolute path).' };
  if (!(await isRunnable(shell))) return { ok: false, shell, variables: {}, error: `The login shell ${shell} cannot be run.` };
  const result = await runProgram(shell, ['-lc', environmentCommand()], { env, cwd, timeoutMs, limit: 1024 * 1024 });
  if (result.timedOut) return { ok: false, shell, variables: {}, error: `The login shell did not finish within ${Math.round(timeoutMs / 1000)} seconds.` };
  if (result.spawnError) return { ok: false, shell, variables: {}, error: result.spawnError };
  // A profile that ends with a failing command still printed the environment; accept output when there is any.
  if (!result.ok && !result.stdout) return { ok: false, shell, variables: {}, error: `The login shell exited with ${result.exitCode ?? result.signal}.` };
  return { ok: true, shell, variables: parseEnvironment(result.stdout, names), error: null };
}

/** `a:b` followed by `b:c` is `a:b:c`: the first list wins and nothing repeats. Only absolute entries are kept: an empty or relative one
 *  (`.`, `bin`, `~/bin` that nothing expanded) would mean the folder a program happens to run in, where it could shadow a vendor command. */
export function mergePaths(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) for (const part of (list ?? '').split(delimiter)) if (part && isAbsolute(part) && !seen.has(part)) { seen.add(part); out.push(part); }
  return out.join(delimiter);
}
