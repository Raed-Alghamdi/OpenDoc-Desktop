import { setTimeout } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { codedError } from './errors';
import { desktopRecordAdvice, workspaceOwner } from './owner';

const usage = 'Usage: npx opendoc stop [--json]\nStops the OpenDoc service started with npx opendoc start. It does not stop opendoc-desktop.';

const exited = (pid: number) => {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
};

export async function runStop(args: string[], root: string, options: { timeoutMs?: number } = {}) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) { console.log(values.json ? JSON.stringify({ usage }) : usage); return; }
  if (positionals.length) throw codedError(usage, 'usage');
  const owner = await workspaceOwner(root);
  if (owner.mode === 'desktop') throw codedError(`This workspace is open in opendoc-desktop. Close opendoc-desktop to stop it; opendoc stop only stops the browser edition. ${desktopRecordAdvice}`, 'desktop-owns-workspace');
  if (owner.mode === null) {
    console.log(values.json ? JSON.stringify({ stopped: false, running: false }) : 'OpenDoc is not running for this workspace.');
    return;
  }
  // Never signal anything but one process: pid 1, 0 and the negative values name init or whole groups.
  const pid = owner.pid;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 1) throw codedError('The recorded OpenDoc session has no valid process to stop. Stop OpenDoc with Ctrl+C in its terminal.', 'owner-unconfirmed');
  try { process.kill(pid, 'SIGTERM'); }
  catch (error) {
    // It ended between the check and the signal: that is what was asked for.
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') { console.log(values.json ? JSON.stringify({ stopped: true, running: false, pid }) : 'OpenDoc stopped.'); return; }
    throw error;
  }
  // Shutdown completes pending document writes before the process exits.
  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  while (!exited(pid)) {
    if (Date.now() > deadline) throw codedError('OpenDoc did not stop in time. Check its terminal.', 'timeout');
    await setTimeout(100);
  }
  console.log(values.json ? JSON.stringify({ stopped: true, running: false, pid }) : 'OpenDoc stopped.');
}
