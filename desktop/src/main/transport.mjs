// The one module that carries the app's requests to the OpenDoc service, with no port anywhere (plan 3.2, S3's Host A).
//
// The service runs in a child of this executable (ELECTRON_RUN_AS_NODE, tsx loaded, the workspace as its working
// directory). The main process answers `app://opendoc` by sending each request over the child's IPC channel; the
// host (../host/service-host.mjs) hands it to `service.handle(req, res)` and sends the answer back in pieces. The
// service's change events come back the same way.
//
// The host runs in its own process group. It exits when the channel to this process closes, and then takes its
// group with it (the render workers it spawned), so a killed app never leaves a serving host or an orphaned worker.
// The group kill is registered last so the host's own exit handlers run first.
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hostFlag } from '../host/service-host.mjs';
import { serviceHost, serviceOrigin, shellScheme } from './identity.mjs';
import { nodeModeEnvironment } from './runtime.mjs';

const grouped = process.platform !== 'win32';
const watchdogSource = `process.on('disconnect', () => {
  ${grouped ? "process.on('exit', () => { try { process.kill(-process.pid, 'SIGKILL'); } catch {} });" : ''}
  process.exit(0);
});`;
const watchdog = `data:text/javascript,${encodeURIComponent(watchdogSource)}`;

export class TransportError extends Error {
  constructor(message, tail = []) { super(message); this.name = 'TransportError'; this.tail = tail; }
}

let hostText;
/** The host's code as text. It is passed on the command line, so the child never reads a file inside app.asar. */
const hostSource = () => hostText ??= readFile(fileURLToPath(new URL('../host/service-host.mjs', import.meta.url)), 'utf8');

/**
 * `{ entry, tsx }`: the service module and the loader that runs its TypeScript, from the runtime's `node_modules` or,
 * in development, from the repository (`fallbackRoot`). Null when neither has the service.
 */
export function serviceLocation({ runtime, fallbackRoot }) {
  const places = [[join(runtime, 'node_modules', 'opendoc', 'src', 'server', 'service.ts'), join(runtime, 'node_modules')]];
  if (fallbackRoot) places.push([join(fallbackRoot, 'src', 'server', 'service.ts'), join(fallbackRoot, 'node_modules')]);
  for (const [entry, modules] of places) if (existsSync(entry)) return { entry, tsx: join(modules, 'tsx', 'dist', 'esm', 'index.mjs') };
  return null;
}

/** The headers a Request carries, as a plain object with lowercase names (what Node's request objects hold). */
function headerObject(request) {
  const headers = {};
  request.headers.forEach((value, key) => { headers[key] = value; });
  headers.host = serviceHost;
  return headers;
}

export async function startTransport({ root, location, logFile, startupTimeout = 30_000 }) {
  if (!location) throw new TransportError('The OpenDoc runtime that comes with the app was not found, so the workspace cannot be opened.');
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

  const args = ['--import', existsSync(location.tsx) ? pathToFileURL(location.tsx).href : 'tsx', '--import', watchdog, '--input-type=module', '-e', await hostSource(), hostFlag, pathToFileURL(location.entry).href];
  const child = spawn(process.execPath, args, { cwd: root, env: nodeModeEnvironment(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'advanced', detached: grouped });
  /** Workers the host started share its process group; whatever outlives the host is swept away. */
  const sweep = () => { if (grouped && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* none left */ } } };
  log?.write(`${new Date().toISOString()} [app] host started (pid ${child.pid})\n`);
  child.stdout.on('data', chunk => note('out', chunk));
  child.stderr.on('data', chunk => note('err', chunk));

  let ended = false;
  const pending = new Map();
  const listeners = new Set();
  let nextId = 1;
  let ready;
  let failed;
  const started = new Promise((accept, reject) => { ready = accept; failed = reject; });
  started.catch(() => {}); // Reported to the caller below; never an unhandled rejection.

  /** Every request still waiting for the host fails when the host is gone. */
  const failPending = reason => {
    for (const entry of [...pending.values()]) entry.fail(new Error(reason));
    pending.clear();
  };
  const exited = new Promise(accept => {
    child.once('error', error => { note('err', `spawn failed: ${error.message}`); });
    child.once('exit', (code, signal) => {
      ended = true;
      log?.write(`${new Date().toISOString()} [app] host exited (${signal ?? code})\n`);
      failPending('The OpenDoc service stopped.');
      failed(new TransportError('The OpenDoc service stopped while starting.', tail.slice()));
      accept({ code, signal });
    });
    // The output streams can still deliver lines after the exit; close the log once they are done.
    child.once('close', () => log?.end());
  });

  child.on('message', message => {
    switch (message?.t) {
      case 'ready': ready(); return;
      case 'failed': note('err', message.message); failed(new TransportError('The OpenDoc service could not start.', tail.slice())); return;
      case 'change': for (const listener of [...listeners]) { try { listener(); } catch (error) { console.error('A change listener failed:', error.message); } } return;
      default: pending.get(message?.id)?.message(message);
    }
  });

  const timer = setTimeout(() => failed(new TransportError('The OpenDoc service did not start within 30 seconds.', tail.slice())), startupTimeout);
  try { await started; }
  catch (error) {
    child.kill('SIGKILL');
    await exited;
    sweep();
    throw error;
  } finally { clearTimeout(timer); }

  const send = message => new Promise((accept, reject) => {
    if (ended || !child.connected) { reject(new Error('The OpenDoc service is not running.')); return; }
    child.send(message, error => error ? reject(error) : accept());
  });

  const bodiless = status => [204, 205, 304].includes(status);
  const transport = {
    kind: 'ipc',
    scheme: shellScheme,
    origin: serviceOrigin,
    pid: child.pid,
    exited,
    get running() { return !ended; },
    /** Answer one request of the window's origin. Never throws: a failure is a Response. */
    async handle(request) {
      if (ended) return new Response('The OpenDoc service is not running.', { status: 503 });
      const url = new URL(request.url);
      const id = nextId++;
      const hasBody = !['GET', 'HEAD'].includes(request.method) && request.body !== null;
      return new Promise(accept => {
        let controller;
        let answered = false;
        const stop = () => { pending.delete(id); void send({ t: 'abort', id }).catch(() => {}); };
        const stream = new ReadableStream({ start(next) { controller = next; }, cancel: stop });
        const fail = error => {
          pending.delete(id);
          if (answered) { try { controller.error(error); } catch { /* already closed */ } return; }
          answered = true;
          accept(new Response(ended ? 'The OpenDoc service is not running.' : 'The OpenDoc service failed to answer.', { status: ended ? 503 : 500 }));
        };
        pending.set(id, {
          fail,
          message(message) {
            if (message.t === 'head') {
              answered = true;
              const empty = bodiless(message.status) || request.method === 'HEAD';
              accept(new Response(empty ? null : stream, { status: message.status, headers: message.headers }));
              if (empty) { try { controller.close(); } catch { /* none */ } }
            } else if (message.t === 'chunk') {
              try { controller.enqueue(message.data); } catch { /* the page stopped reading */ }
            } else if (message.t === 'end') {
              pending.delete(id);
              if (message.aborted) fail(new Error('The request was cut off.'));
              else { try { controller.close(); } catch { /* none */ } }
            } else if (message.t === 'error') {
              console.error('The service failed to answer:', message.message);
              fail(new Error(message.message));
            }
          },
        });
        request.signal.addEventListener('abort', () => { if (pending.has(id)) { stop(); fail(new Error('The request was cancelled.')); } }, { once: true });
        void (async () => {
          await send({ t: 'req', id, method: request.method, url: url.pathname + url.search, headers: headerObject(request), body: hasBody });
          if (!hasBody) return;
          const reader = request.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            await send({ t: 'body', id, data: value });
          }
          await send({ t: 'body-end', id });
        })().catch(error => { if (pending.has(id)) { stop(); fail(error); } });
      });
    },
    /** Does the service answer? One real request, as the page makes them. */
    async ping(timeout = 4000) {
      try {
        const response = await transport.handle(new Request(`${serviceOrigin}/api/session`, { signal: AbortSignal.timeout(timeout) }));
        if (!response.ok) { await response.body?.cancel(); return false; }
        await response.text();
        return true;
      } catch { return false; }
    },
    /** Calls `listener` whenever the service reports a change; returns the function that stops it. */
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    recentOutput: () => tail.slice(),
    /** Ask the service to finish (it completes accepted saves first); force it after `grace` milliseconds. */
    async stop(grace = 8000) {
      if (!ended) {
        await send({ t: 'close' }).catch(() => child.kill('SIGTERM'));
        const result = await Promise.race([exited.then(() => 'exited'), sleep(grace).then(() => 'late')]);
        if (result === 'late') { child.kill('SIGKILL'); await exited; }
      }
      sweep();
    },
    kill() { if (!ended) child.kill('SIGKILL'); sweep(); },
  };
  return transport;
}
