import { Worker } from 'node:worker_threads';

// Runs on its own thread, so it keeps working while the main thread is stuck in a synchronous loop.
// A parent that dies leaves its child reparented (its ppid changes); the thread then ends the whole process.
const watchdog = `
const { workerData } = require('node:worker_threads');
setInterval(() => { if (process.ppid !== workerData.parent) process.kill(process.pid, 'SIGKILL'); }, workerData.interval);
`;

/**
 * Ends this process within about a second of its parent dying, even while the main thread is busy.
 * 'disconnect' cannot do this: its handler never runs inside a synchronous loop, and broken theme or document
 * code is exactly such a loop. Call it first thing in a process started with fork().
 */
export function exitWithParent(interval = 1000) {
  if (!process.send || process.platform === 'win32') return; // Windows keeps the parent's id after it dies.
  new Worker(watchdog, { eval: true, workerData: { parent: process.ppid, interval } }).unref();
}
