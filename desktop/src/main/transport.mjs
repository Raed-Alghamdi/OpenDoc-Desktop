// The one module that carries the app's requests to the OpenDoc service.
//
// Temporary adapter: the service runs as a child of this executable (a run-as-Node host with the workspace as
// its working directory) and listens on 127.0.0.1 with OPENDOC_PORT=0; the port comes from .opendoc/server.json.
// The window loads the service's own http origin, and the main process answers every request of that origin
// itself (`handle`), so it can serve "Show in folder" and watch what the page asks for.
//
// When createOpenDocService (U3) merges, this file is the only one that changes: the host becomes the service
// behind an IPC channel, `origin` becomes `app://opendoc`, `scheme` becomes `app` and `handle` forwards over IPC.
// Everything that uses a transport (the session supervisor, the window, the policy) reads only what is returned here.
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { nodeModeEnvironment } from './runtime.mjs';

// The host runs in its own process group. It exits when the channel to this process closes, and then takes
// its group with it (the render workers it spawned), so a killed app never leaves a serving host or an
// orphaned worker. The group kill is registered last so the host's own exit handlers run first.
const grouped = process.platform !== 'win32';
const watchdogSource = `process.on('disconnect', () => {
  ${grouped ? "process.on('exit', () => { try { process.kill(-process.pid, 'SIGKILL'); } catch {} });" : ''}
  process.exit(0);
});`;
const watchdog = `data:text/javascript,${encodeURIComponent(watchdogSource)}`;

export class TransportError extends Error {
  constructor(message, tail = []) { super(message); this.name = 'TransportError'; this.tail = tail; }
}

export async function startTransport({ root, port = 0, logFile, startupTimeout = 30_000 }) {
  const entry = join(root, 'node_modules', 'opendoc', 'src', 'server', 'index.ts');
  const tsx = join(root, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs');
  if (!existsSync(entry)) throw new TransportError('This workspace has no installed OpenDoc runtime (node_modules/opendoc is missing).');
  const sessionFile = join(root, '.opendoc', 'server.json');
  await rm(sessionFile, { force: true });
  if (logFile) await mkdir(dirname(logFile), { recursive: true });
  const log = logFile ? createWriteStream(logFile, { flags: 'a' }) : null;
  log?.on('error', () => {}); // A log that cannot be written must not take the app down.
  const tail = [];
  const note = (stream, chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (!line.trim()) continue;
      log?.write(`${new Date().toISOString()} [host ${stream}] ${line}\n`);
      tail.push(line);
      if (tail.length > 40) tail.shift();
    }
  };

  const args = ['--import', existsSync(tsx) ? pathToFileURL(tsx).href : 'tsx', '--import', watchdog, entry, '--production'];
  const child = spawn(process.execPath, args, { cwd: root, env: nodeModeEnvironment({ OPENDOC_PORT: String(port) }), stdio: ['ignore', 'pipe', 'pipe', 'ipc'], detached: grouped });
  /** Workers the host started share its process group; whatever outlives the host is swept away. */
  const sweep = () => { if (grouped && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* none left */ } } };
  log?.write(`${new Date().toISOString()} [app] host started (pid ${child.pid}, port ${port || 'any'})\n`);
  child.stdout.on('data', chunk => note('out', chunk));
  child.stderr.on('data', chunk => note('err', chunk));
  let ended = false;
  const exited = new Promise(accept => {
    child.once('error', error => { note('err', `spawn failed: ${error.message}`); });
    child.once('exit', (code, signal) => { ended = true; log?.write(`${new Date().toISOString()} [app] host exited (${signal ?? code})\n`); accept({ code, signal }); });
    // The output streams can still deliver lines after the exit; close the log once they are done.
    child.once('close', () => log?.end());
  });

  // Wait for the host to publish its address.
  const deadline = Date.now() + startupTimeout;
  let record = null;
  while (Date.now() < deadline && !ended) {
    try {
      const candidate = JSON.parse(await readFile(sessionFile, 'utf8'));
      if (candidate.pid === child.pid) { record = candidate; break; }
    } catch { /* not written yet */ }
    await sleep(80);
  }
  if (!record) {
    child.kill('SIGKILL');
    await exited;
    sweep();
    throw new TransportError(ended ? 'The OpenDoc service stopped while starting.' : 'The OpenDoc service did not start within 30 seconds.', tail.slice());
  }

  const origin = record.origin;
  let netFetch;
  const transport = {
    kind: 'http-adapter',
    scheme: 'http',
    origin,
    port: Number(new URL(origin).port),
    pid: child.pid,
    exited,
    get running() { return !ended; },
    /** Answer one request of the window's origin. */
    async handle(request) {
      if (new URL(request.url).origin !== origin) return new Response('Not found.', { status: 403 });
      netFetch ??= (await import('electron')).net.fetch;
      return netFetch(request, { bypassCustomProtocolHandlers: true });
    },
    /** Does the service answer? */
    async ping(timeout = 4000) {
      try { return (await fetch(`${origin}/api/session`, { signal: AbortSignal.timeout(timeout), redirect: 'error' })).ok; }
      catch { return false; }
    },
    recentOutput: () => tail.slice(),
    /** Ask the service to finish (it completes accepted saves first); force it after `grace` milliseconds. */
    async stop(grace = 8000) {
      if (!ended) {
        child.kill('SIGTERM');
        const result = await Promise.race([exited.then(() => 'exited'), sleep(grace).then(() => 'late')]);
        if (result === 'late') { child.kill('SIGKILL'); await exited; }
      }
      sweep();
    },
    kill() { if (!ended) child.kill('SIGKILL'); sweep(); },
  };
  return transport;
}
