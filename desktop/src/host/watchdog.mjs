// The service host's guard against being left behind. The main process loads this first (`--import data:...`, from the
// text below, so nothing is read from inside app.asar), before tsx and before any service code, and it ends the host and
// the process group it leads (the render workers) when the app is gone, whatever the host is doing:
//   - the channel is already closed when this runs (the app died while the host was starting): end at once;
//   - the channel closes later (a normal quit, or the app crashed): end, group included;
//   - the parent id changes (the app was killed): checked by a thread of its own, so it works while the host's main thread
//     is stuck in a synchronous loop (a broken theme or document), where 'disconnect' never gets to run.
// A host that is stopped (SIGSTOP) runs nothing at all, so this cannot help there: the main process also starts a small
// shell sentinel (transport.mjs) that kills the host's group from outside when the main process is gone.
export const watchdogSource = `import { Worker } from 'node:worker_threads';
const group = process.platform !== 'win32';
const endAll = () => {
  if (group) { try { process.kill(-process.pid, 'SIGKILL'); } catch {} }
  process.kill(process.pid, 'SIGKILL');
};
if (!process.connected) endAll();
process.on('disconnect', endAll);
if (group) {
  // Not CommonJS-only and not ESM-only: the host runs with --input-type=module, and a worker would inherit it.
  const worker = new Worker(\`
    const { workerData } = await import('node:worker_threads');
    setInterval(() => { if (process.ppid !== workerData.parent) { try { process.kill(-process.pid, 'SIGKILL'); } catch {} process.kill(process.pid, 'SIGKILL'); } }, 300);
  \`, { eval: true, execArgv: ['--input-type=module'], workerData: { parent: process.ppid } });
  worker.on('error', () => {}); // The guards that remain (disconnect, the kernel's parent-death signal) still apply.
  worker.unref();
}
`;

export const watchdogUrl = `data:text/javascript,${encodeURIComponent(watchdogSource)}`;
