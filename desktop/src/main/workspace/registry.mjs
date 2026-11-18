// The upgrade-step registry (plan 3.4). A release that changes how workspaces are written registers a script for the
// step to its minor; a release that does not registers "no changes needed". The registry is empty for now, and a missing
// entry still upgrades: the checks that follow show whether any document needs attention.
import { spawn } from 'node:child_process';
import { nodeModeEnvironment } from '../runtime.mjs';
import { parseVersion } from './versions.mjs';

/**
 * Entries: `{ from: 'x.y', to: 'x.y', noChanges: true }` or `{ from, to, script: '/absolute/path/step.mjs' }`.
 * A script runs as Node (this executable as Node) in the workspace folder, with the arguments `<root> <from> <to>`;
 * exit code 0 is success, anything else fails the step with what it printed.
 */
export const upgradeSteps = [];

const minorOf = text => { const v = parseVersion(`${text}.0`); return v ? v.major * 1_000_000 + v.minor : null; };
const key = value => String(value).split('.').slice(0, 2).join('.');

/**
 * The entries that apply to an upgrade from the pin `from` to the runtime `to` (both x.y.z): those that lead from a minor
 * at or after the pin's to a minor at or before the runtime's, in the order of the minor they reach.
 */
export function stepsBetween(registry, from, to) {
  const start = minorOf(key(from));
  const end = minorOf(key(to));
  return registry
    .filter(entry => minorOf(entry.from) !== null && minorOf(entry.to) !== null && minorOf(entry.from) >= start && minorOf(entry.to) <= end && minorOf(entry.to) > minorOf(entry.from))
    .sort((a, b) => minorOf(a.to) - minorOf(b.to) || minorOf(a.from) - minorOf(b.from));
}

function runScript(entry, { root, execPath = process.execPath, timeout = 10 * 60_000, env }) {
  return new Promise(resolve => {
    const child = spawn(execPath, [entry.script, root, entry.from, entry.to], { cwd: root, env: nodeModeEnvironment(env), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.once('error', error => { clearTimeout(timer); resolve({ ok: false, message: error.message }); });
    child.once('close', code => { clearTimeout(timer); resolve({ ok: code === 0, message: output.trim().split('\n').filter(Boolean).slice(-6).join('\n') }); });
  });
}

/**
 * Run the entries for an upgrade, one version step at a time. Stops at the first failing step.
 * @returns { ok, results: [{ from, to, status: 'unchanged' | 'ran' | 'failed', message? }], failed? }
 */
export async function runUpgradeSteps({ registry = upgradeSteps, from, to, root, run = runScript, onStep = () => {} }) {
  const results = [];
  for (const entry of stepsBetween(registry, from, to)) {
    onStep(entry);
    if (entry.noChanges || !entry.script) { results.push({ from: entry.from, to: entry.to, status: 'unchanged' }); continue; }
    const outcome = await run(entry, { root });
    if (!outcome.ok) {
      const failed = { from: entry.from, to: entry.to, status: 'failed', message: outcome.message || 'The step failed without a message.' };
      results.push(failed);
      return { ok: false, results, failed };
    }
    results.push({ from: entry.from, to: entry.to, status: 'ran', message: outcome.message });
  }
  return { ok: true, results };
}
