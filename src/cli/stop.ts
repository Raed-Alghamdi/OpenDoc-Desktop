import { setTimeout } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { workspaceOwner } from './owner';

const usage = 'Usage: npx opendoc stop [--json]\nStops the OpenDoc service started with npx opendoc start. It does not stop opendoc-desktop.';

const exited = (pid: number) => {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
};

export async function runStop(args: string[], root: string, options: { timeoutMs?: number } = {}) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) { console.log(values.json ? JSON.stringify({ usage }) : usage); return; }
  if (positionals.length) throw new Error(usage);
  const owner = await workspaceOwner(root);
  if (owner.mode === 'desktop') throw new Error('This workspace is open in opendoc-desktop. Close opendoc-desktop to stop it; opendoc stop only stops the browser edition.');
  if (owner.mode === null) {
    console.log(values.json ? JSON.stringify({ stopped: false, running: false }) : 'OpenDoc is not running for this workspace.');
    return;
  }
  if (owner.pid === undefined) throw new Error('The recorded OpenDoc session has no process to stop. Stop OpenDoc with Ctrl+C in its terminal.');
  process.kill(owner.pid, 'SIGTERM');
  // Shutdown completes pending document writes before the process exits.
  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  while (!exited(owner.pid)) {
    if (Date.now() > deadline) throw new Error('OpenDoc did not stop in time. Check its terminal.');
    await setTimeout(100);
  }
  console.log(values.json ? JSON.stringify({ stopped: true, running: false, pid: owner.pid }) : 'OpenDoc stopped.');
}
