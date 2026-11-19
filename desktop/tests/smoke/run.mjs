#!/usr/bin/env node
// Runs the app smoke test (E10) the only way it may run: niced, with a hard time limit, and on a virtual display on Linux
// (Xvfb, with the desktop's display and Electron variables removed, so no window can reach a real screen). On macOS the
// runner's own session is used. Whatever is left of the app afterwards is killed and reported.
//
//   node desktop/tests/smoke/run.mjs                 the smoke test against desktop/dist (or $OPENDOC_E10_APP)
//   node desktop/tests/smoke/run.mjs --grep NAME     any Playwright argument goes through
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appProcesses, desktop, isMac, locateApp, virtualDisplayMarker } from './support/app.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const limitSeconds = process.env.OPENDOC_E10_LIMIT ?? '1500';
const playwright = path.join(desktop, 'node_modules', '.bin', 'playwright');
const test = [playwright, 'test', '-c', path.join(here, 'playwright.config.mjs'), ...process.argv.slice(2)];
const app = locateApp();

const linuxCommand = [
  'nice', '-n', '19', 'ionice', '-c', '3',
  'timeout', '-s', 'KILL', limitSeconds,
  'xvfb-run', '-a', '-s', '-screen 0 1600x1000x24 -nolisten tcp',
  'env', '-u', 'ELECTRON_FORCE_IS_PACKAGED', '-u', 'ELECTRON_RUN_AS_NODE', '-u', 'ELECTRON_OZONE_PLATFORM_HINT', '-u', 'WAYLAND_DISPLAY', `${virtualDisplayMarker}=1`,
  ...test,
];
// macOS has neither ionice nor timeout: the time limit is spawnSync's own.
const macCommand = ['nice', '-n', '19', ...test];
const command = isMac ? macCommand : linuxCommand;
const result = spawnSync(command[0], command.slice(1), { stdio: 'inherit', cwd: desktop, timeout: Number(limitSeconds) * 1000 + 30_000, killSignal: 'SIGKILL' });
const left = appProcesses(app.root);
for (const { pid } of left) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
if (left.length) console.error(`Killed ${left.length} process(es) of the app left behind: ${left.map((item) => item.pid).join(', ')}`);
process.exit(result.status ?? 1);
