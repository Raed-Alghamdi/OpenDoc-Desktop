// The service host: the code that runs inside the child process, next to the OpenDoc service. There is no listener.
// The main process sends each request over the child's IPC channel; this file turns it into the Node request and
// response objects the service's handlers are written against, and sends the answer back in pieces.
//
// The main process starts the child as `electron -e <this file's text> <flag> <service entry url>` (see
// transport.mjs), so nothing is read from inside app.asar. The same file is imported by the unit tests, which is
// why starting is guarded by the flag.
//
// Messages, main to host:   { t: 'req', id, method, url, headers, body }   then, when body is true, { t: 'body', id, data }... and { t: 'body-end', id }
//                           { t: 'abort', id }    { t: 'close' }
// Messages, host to main:   { t: 'ready' }   { t: 'failed', message }
//                           { t: 'head', id, status, headers: [[name, value]] }   { t: 'chunk', id, data }   { t: 'end', id, aborted? }
//                           { t: 'error', id, message }   { t: 'change' }   { t: 'closed' }
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';

export const hostFlag = 'opendoc-service-host';
/** The host asks the channel to carry at most this much before it stops writing and waits (a response is never read faster than the main process takes it). */
export const highWater = 4 * 1024 * 1024;

/** The request the service sees. Its body arrives with `feed(chunk)` and `finish()`. */
export class HostRequest extends IncomingMessage {
  constructor({ method, url, headers }) {
    super(new Socket()); // The handlers never touch the socket; Node's own cleanup calls destroy() on it.
    this.httpVersion = '1.1';
    this.httpVersionMajor = 1;
    this.httpVersionMinor = 1;
    this.complete = true;
    this.method = method;
    this.url = url;
    this.headers = headers;
    this.rawHeaders = Object.entries(headers).flat();
  }
  feed(data) { if (data?.length) this.push(Buffer.from(data.buffer, data.byteOffset, data.byteLength)); }
  finish() { this.push(null); }
}

/** The response the service writes to. Everything written goes to `send`; `queued()` says how much the channel still holds. */
export class HostResponse extends ServerResponse {
  #id;
  #send;
  #opened = false;
  #finished = false;
  constructor(request, id, send) {
    super(request);
    this.#id = id;
    this.#send = send;
  }
  #open() {
    if (this.#opened) return;
    this.#opened = true;
    this._header = 'sent'; // headersSent is true from here, as on a real connection
    const headers = [];
    for (const [name, value] of Object.entries(this.getHeaders())) for (const item of Array.isArray(value) ? value : [value]) headers.push([name, String(item)]);
    this.#send({ t: 'head', id: this.#id, status: this.statusCode, headers });
  }
  writeHead(status, a, b) {
    if (this.#opened) return this;
    this.statusCode = status;
    const headers = typeof a === 'string' ? b : a;
    if (Array.isArray(headers)) for (let index = 0; index + 1 < headers.length; index += 2) this.appendHeader(headers[index], headers[index + 1]);
    else if (headers) for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    this.#open();
    return this;
  }
  write(chunk, encoding, callback) {
    this.#open();
    const done = typeof encoding === 'function' ? encoding : callback;
    const data = Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined);
    const wait = this.#send({ t: 'chunk', id: this.#id, data: new Uint8Array(data) }, data.length);
    done?.();
    return !wait;
  }
  end(chunk, encoding, callback) {
    if (this.#finished) return this;
    if (typeof chunk === 'function') { callback = chunk; chunk = undefined; }
    else if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
    if (chunk != null) this.write(chunk, encoding);
    this.#open();
    this.#finished = true;
    this.#send({ t: 'end', id: this.#id });
    this.emit('finish');
    this.emit('close');
    callback?.();
    return this;
  }
  destroy() {
    this.destroyed = true;
    if (!this.#finished) { this.#finished = true; this.#send({ t: 'end', id: this.#id, aborted: true }); }
    this.emit('close');
    return this;
  }
}

/**
 * Connects a service to a channel. `post(message)` sends to the main process and calls back through `sent` when the
 * channel took it; `receive(message)` is what the channel delivers.
 * @returns { receive }
 */
export function serveRequests({ service, post, onClose }) {
  const live = new Map();
  let queued = 0;
  const waiting = new Set();
  const send = (message, size = 0) => {
    queued += size;
    post(message, () => {
      queued -= size;
      if (queued < highWater / 2) for (const response of [...waiting]) { waiting.delete(response); response.emit('drain'); }
    });
    return queued >= highWater;
  };
  service.onChange(() => send({ t: 'change' }));

  async function start(message) {
    const request = new HostRequest({ method: message.method, url: message.url, headers: message.headers });
    const response = new HostResponse(request, message.id, (...args) => {
      const full = send(...args);
      if (full) waiting.add(response);
      return full;
    });
    live.set(message.id, { request, response });
    response.on('close', () => { live.delete(message.id); waiting.delete(response); });
    if (!message.body) request.finish();
    try { await service.handle(request, response); }
    catch (error) { send({ t: 'error', id: message.id, message: String(error?.message ?? error) }); response.destroy(); }
  }

  return {
    async receive(message) {
      if (message.t === 'req') return start(message);
      if (message.t === 'body') { live.get(message.id)?.request.feed(message.data); return; }
      if (message.t === 'body-end') { live.get(message.id)?.request.finish(); return; }
      if (message.t === 'abort') { const entry = live.get(message.id); entry?.request.destroy(); entry?.response.destroy(); return; }
      if (message.t === 'close') await onClose();
    },
  };
}

/** The child's own main: create the service for the current directory, then serve requests until told to close. */
export async function runHost(entryUrl) {
  // The channel closing (the app is gone) is handled by the watchdog the main process loads first.
  const post = (message, sent) => { process.send(message, undefined, {}, sent); };
  try {
    const { createOpenDocService } = await import(entryUrl);
    const service = await createOpenDocService({ root: process.cwd(), production: true });
    let closing;
    const close = () => closing ??= (async () => {
      await service.close();
      await new Promise(accept => post({ t: 'closed' }, accept));
      process.exit(0);
    })();
    const host = serveRequests({ service, post, onClose: close });
    process.on('message', message => { void host.receive(message); });
    // A polite stop (SIGTERM) finishes accepted saves first, like a close message.
    process.on('SIGTERM', () => { void close(); });
    post({ t: 'ready' });
  } catch (error) {
    post({ t: 'failed', message: String(error?.stack ?? error) });
    setTimeout(() => process.exit(1), 200);
  }
}

if (process.argv[1] === hostFlag) void runHost(process.argv[2]);
