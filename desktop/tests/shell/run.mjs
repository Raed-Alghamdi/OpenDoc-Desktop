#!/usr/bin/env node
// Run the shell tests the only way they may run: niced, on a virtual display, with a hard time limit, and with
// every leftover process of this worktree's Electron killed afterwards (matched by executable path).
//
//   node desktop/tests/shell/run.mjs              the Playwright tests (Electron under Xvfb)
//   node desktop/tests/shell/run.mjs --grep NAME  any Playwright argument goes through
//   node desktop/tests/shell/run.mjs --unit       the unit tests (no Electron, no display)
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopDir } from './support/paths.mjs';
import { killElectronProcesses } from './support/processes.mjs';
import { strippedVariables, virtualDisplayMarker } from './support/environment.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const limitSeconds = process.env.OPENDOC_SHELL_TEST_LIMIT ?? '1500';
const gentle = ['nice', '-n', '19', 'ionice', '-c', '3'];

if (args[0] === '--unit') {
  const result = spawnSync(gentle[0], [...gentle.slice(1), process.execPath, '--test', ...args.slice(1), join(here, 'unit')], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

const playwright = join(desktopDir, 'node_modules', '.bin', 'playwright');
const unset = strippedVariables.flatMap(name => ['-u', name]);
const command = [
  ...gentle,
  'timeout', '-s', 'KILL', limitSeconds,
  'xvfb-run', '-a', '-s', '-screen 0 1600x1000x24 -nolisten tcp',
  'env', ...unset, `${virtualDisplayMarker}=1`,
  playwright, 'test', '-c', join(here, 'playwright.config.mjs'), ...args,
];
const result = spawnSync(command[0], command.slice(1), { stdio: 'inherit', cwd: desktopDir });
const left = killElectronProcesses();
if (left.length) console.error(`Killed ${left.length} Electron process(es) left behind: ${left.map(item => item.pid).join(', ')}`);
process.exit(result.status ?? 1);
