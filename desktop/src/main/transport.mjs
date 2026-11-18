// The one module that carries the app's requests to the OpenDoc service, with no port anywhere (plan 3.2, S3's Host A).
//
// The service runs in a child of this executable (ELECTRON_RUN_AS_NODE, tsx loaded, the workspace as its working
// directory). The main process answers `app://opendoc` by sending each request over the child's IPC channel; the
// host (../host/service-host.mjs) hands it to `service.handle(req, res)` and sends the answer back in pieces. The
// service's change events come back the same way.
//
// The host runs in its own process group and guards itself against being left behind (../host/watchdog.mjs). A small
// shell process (the sentinel) watches the app from outside: when the app is gone it kills the host's whole group, which
// also covers a host that is stopped (SIGSTOP) or stuck in a loop, and what the host started.
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bodyWindow, chunkSize, hostFlag, responseWindow } from '../host/service-host.mjs';
import { watchdogUrl } from '../host/watchdog.mjs';
import { serviceHost, serviceOrigin, shellScheme } from './identity.mjs';
import { nodeModeEnvironment } from './runtime.mjs';

const grouped = process.platform !== 'win32';
const watchdog = watchdogUrl;
// What the host may tell us (everything it sends is checked, so a broken service cannot hang or crash the main process).
const maxChunk = 1024 * 1024;
const maxHeaders = 200;
const maxHeaderBytes = 128 * 1024;
const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// Runs outside the host: ends when the host's group is gone, and kills the group if the app is gone first. The group
// number cannot be given to anything else while a member lives, and the loop stops as soon as the last one is gone.
// Written for every POSIX shell: dash (/bin/sh on Debian and Ubuntu) rejects `kill -0 -- -PID` ("Illegal number"), so
// every signal is named with `-s`. $1 is the app's pid, $2 the host's pid (its group number).
export const sentinelScript = 'while kill -s 0 "$1" 2>/dev/null && kill -s 0 -- "-$2" 2>/dev/null; do sleep 1; done; kill -s 0 "$1" 2>/dev/null || kill -s KILL -- "-$2" 2>/dev/null';

export class TransportError extends Error {
  /** `code` is set when the host says why: 'read-only-unsupported'. */
  constructor(message, tail = [], code) { super(message); this.name = 'TransportError'; this.tail = tail; this.code = code; }
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

/** The status line and headers of a host's answer, or an Error saying what is wrong with them. */
function checkedHead(message) {
  if (!Number.isInteger(message.status) || message.status < 200 || message.status > 599) throw new Error(`The service sent the status ${message.status}.`);
  if (!Array.isArray(message.headers) || message.headers.length > maxHeaders) throw new Error('The service sent too many headers.');
  let bytes = 0;
  for (const pair of message.headers) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') throw new Error('The service sent a malformed header.');
    if (!headerName.test(pair[0]) || /[\0\r\n]/.test(pair[1])) throw new Error(`The service sent the header ${JSON.stringify(pair[0])}, which is not valid.`);
    bytes += pair[0].length + pair[1].length;
  }
  if (bytes > maxHeaderBytes) throw new Error('The service sent headers that are too large.');
  return { status: message.status, headers: message.headers };
}

/** A gate for the upload: `take(n)` waits until the service has read enough of what was sent; `close()` lets every waiter go. */
function creditGate(size) {
  let available = size;
  let closed = false;
  let waiters = [];
  const wake = () => { const all = waiters; waiters = []; for (const accept of all) accept(); };
  return {
    async take(bytes) {
      while (available <= 0 && !closed) await new Promise(accept => waiters.push(accept));
      if (closed) throw new Error('The upload was stopped.');
      available -= bytes;
    },
    grant(bytes) { available += bytes; wake(); },
    close() { closed = true; wake(); },
  };
}

/**
 * Start the service host for the workspace at `root`.
 * @param options.location { entry, tsx } from serviceLocation(); null when the runtime has no service
 * @param options.signal aborts a start that is still going (the app is quitting); the host is killed
 * @param options.readOnly { reason, message } to run the service read-only (U4); a service that cannot fails with code 'read-only-unsupported'
 */
export async function startTransport({ root, location, logFile, startupTimeout = 30_000, signal, readOnly }) {
  if (!location) throw new TransportError('The OpenDoc runtime that comes with the app was not found, so the workspace cannot be opened.');
  if (signal?.aborted) throw new TransportError('Starting the OpenDoc service was cancelled.');
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

  // The guard goes first, before tsx and the service, so even a host that dies of the app's death while starting is covered.
  const hostArguments = ['--import', watchdog, '--import', existsSync(location.tsx) ? pathToFileURL(location.tsx).href : 'tsx', '--input-type=module', '-e', await hostSource(), hostFlag, pathToFileURL(location.entry).href, ...(readOnly ? [JSON.stringify(readOnly)] : [])];
  const child = spawn(process.execPath, hostArguments, { cwd: root, env: nodeModeEnvironment(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'advanced', detached: grouped });
  if (grouped && child.pid) {
    const sentinel = spawn('/bin/sh', ['-c', sentinelScript, 'opendoc-sentinel', String(process.pid), String(child.pid)], { stdio: 'ignore', detached: true });
    sentinel.on('error', () => {}); // The host's own watchdog still covers every case but a stopped host.
    sentinel.unref();
  }
  let swept = false;
  /**
   * Workers the host started share its process group; whatever outlives the host is swept away. This runs once, when the
   * host's exit is seen: later the group's number could belong to somebody else.
   */
  const sweep = () => {
    if (swept || !grouped || !child.pid) return;
    swept = true;
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* none left */ }
  };
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
      sweep();
      log?.write(`${new Date().toISOString()} [app] host exited (${signal ?? code})\n`);
      failPending('The OpenDoc service stopped.');
      failed(new TransportError('The OpenDoc service stopped while starting.', tail.slice()));
      accept({ code, signal });
    });
    // The output streams can still deliver lines after the exit; close the log once they are done.
    child.once('close', () => log?.end());
  });

  child.on('message', message => {
    try {
      if (!message || typeof message !== 'object' || typeof message.t !== 'string') return;
      switch (message.t) {
        case 'ready': ready(); return;
        case 'failed': note('err', String(message.message).slice(0, 4000)); failed(new TransportError('The OpenDoc service could not start.', tail.slice(), message.code === 'read-only-unsupported' ? message.code : undefined)); return;
        case 'change': for (const listener of [...listeners]) { try { listener(); } catch (error) { console.error('A change listener failed:', error.message); } } return;
        default:
          if (Number.isSafeInteger(message.id)) pending.get(message.id)?.message(message);
      }
    } catch (error) { console.error('A message from the service host was not understood:', error.message); }
  });

  const timer = setTimeout(() => failed(new TransportError('The OpenDoc service did not start within 30 seconds.', tail.slice())), startupTimeout);
  const cancel = () => failed(new TransportError('Starting the OpenDoc service was cancelled.', tail.slice()));
  signal?.addEventListener('abort', cancel, { once: true });
  try { await started; }
  catch (error) {
    child.kill('SIGKILL');
    await exited;
    sweep();
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }

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
        let enqueued = 0;
        let credited = 0;
        let reader = null;
        let finished = false;
        const gate = creditGate(bodyWindow);
        /** The request is over, one way or another: nothing more is read from the page's upload, and the host's credit is moot. */
        const finish = () => {
          finished = true;
          pending.delete(id);
          gate.close();
          if (reader) void reader.cancel().catch(() => {});
        };
        /** Tell the host to give up on this request. */
        const stop = () => { if (pending.has(id)) { finish(); void send({ t: 'abort', id }).catch(() => {}); } };
        // Credit: what the page has taken of the answer (everything enqueued minus what still waits in the queue) goes back to the host.
        const grant = () => {
          const room = controller.desiredSize;
          if (room === null) return;
          const taken = enqueued - (responseWindow - room);
          if (taken > credited) { const bytes = taken - credited; credited = taken; void send({ t: 'credit', id, bytes }).catch(() => {}); }
        };
        const stream = new ReadableStream({ start(next) { controller = next; }, pull: grant, cancel: stop }, new ByteLengthQueuingStrategy({ highWaterMark: responseWindow }));
        const fail = (error, status) => {
          finish();
          if (answered) { try { controller.error(error); } catch { /* already closed */ } return; }
          answered = true;
          const code = ended ? 503 : status ?? 500;
          accept(new Response(code === 503 ? 'The OpenDoc service is not running.' : code === 502 ? 'The OpenDoc service sent an answer the app could not use.' : 'The OpenDoc service failed to answer.', { status: code }));
        };
        pending.set(id, {
          fail,
          message(message) {
            try {
              if (message.t === 'head') {
                if (answered) throw new Error('The service sent a second set of headers.');
                const head = checkedHead(message);
                const empty = bodiless(head.status) || request.method === 'HEAD';
                const response = new Response(empty ? null : stream, head);
                answered = true;
                accept(response);
                if (empty) { try { controller.close(); } catch { /* none */ } finish(); }
              } else if (message.t === 'chunk') {
                if (!answered || !(message.data instanceof Uint8Array) || message.data.byteLength > maxChunk) throw new Error('The service sent a piece of the answer that is not valid.');
                enqueued += message.data.byteLength;
                controller.enqueue(message.data);
              } else if (message.t === 'end') {
                finish();
                if (message.aborted) fail(new Error('The request was cut off.'));
                else { try { controller.close(); } catch { /* none */ } }
              } else if (message.t === 'error') {
                console.error('The service failed to answer:', String(message.message).slice(0, 2000));
                fail(new Error('The service failed to answer.'));
              } else if (message.t === 'body-credit') {
                if (!Number.isSafeInteger(message.bytes) || message.bytes < 0) throw new Error('The service sent a credit that is not valid.');
                gate.grant(message.bytes);
              }
            } catch (error) {
              console.error('The service host sent something that is not valid:', error.message);
              stop();
              fail(error, 502);
            }
          },
        });
        request.signal.addEventListener('abort', () => { if (pending.has(id)) { stop(); fail(new Error('The request was cancelled.')); } }, { once: true });
        void (async () => {
          await send({ t: 'req', id, method: request.method, url: url.pathname + url.search, headers: headerObject(request), body: hasBody });
          if (!hasBody) return;
          // The request can be over before there is a reader (finish() found nothing to cancel): then the body is released here, never left locked.
          if (finished) { void request.body.cancel().catch(() => {}); return; }
          reader = request.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            for (let at = 0; at < value.byteLength; at += chunkSize) {
              const piece = value.subarray(at, at + chunkSize);
              await gate.take(piece.byteLength);
              await send({ t: 'body', id, data: piece });
            }
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
    kill() { if (!ended) child.kill('SIGKILL'); },
  };
  return transport;
}
