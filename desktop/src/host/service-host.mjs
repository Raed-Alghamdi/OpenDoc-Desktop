// The service host: the code that runs inside the child process, next to the OpenDoc service. There is no listener.
// The main process sends each request over the child's IPC channel; this file turns it into the Node request and
// response objects the service's handlers are written against, and sends the answer back in pieces.
//
// The main process starts the child as `electron -e <this file's text> <flag> <service entry url>` (see
// transport.mjs), so nothing is read from inside app.asar. The same file is imported by the unit tests, which is
// why starting is guarded by the flag.
//
// Messages, main to host:   { t: 'req', id, method, url, headers, body }   then, when body is true, { t: 'body', id, data }... and { t: 'body-end', id }
//                           { t: 'credit', id, bytes }   (the page took that much of the response)
//                           { t: 'abort', id }    { t: 'close' }
// Messages, host to main:   { t: 'ready' }   { t: 'failed', message }
//                           { t: 'head', id, status, headers: [[name, value]] }   { t: 'chunk', id, data }   { t: 'end', id, aborted? }
//                           { t: 'error', id, message }   { t: 'change' }   { t: 'closed' }
//                           { t: 'body-credit', id, bytes }   (the service took that much of the upload)
//
// Flow control, both ways, by credit: the host sends at most `responseWindow` bytes of a response that the page has not
// taken yet (it stops writing and waits for 'credit'), and the main process sends at most `bodyWindow` bytes of an upload
// the service has not read yet (it waits for 'body-credit'). Neither side buffers a whole file for a slow reader.
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';

export const hostFlag = 'opendoc-service-host';
/** How much of one response may be on its way unacknowledged, and how big each piece is. */
export const responseWindow = 4 * 1024 * 1024;
export const chunkSize = 256 * 1024;
/** How much of one upload may be on its way unacknowledged. */
export const bodyWindow = 4 * 1024 * 1024;

/** The request the service sees. Its body arrives with `feed(chunk)` and `finish()`; `credit(bytes)` is told what the service has read. */
export class HostRequest extends IncomingMessage {
  #fed = 0;
  #acked = 0;
  #credit;
  constructor({ method, url, headers }, credit = () => {}) {
    super(new Socket()); // The handlers never touch the socket; Node's own cleanup calls destroy() on it.
    this.#credit = credit;
    this.httpVersion = '1.1';
    this.httpVersionMajor = 1;
    this.httpVersionMinor = 1;
    this.complete = true;
    this.method = method;
    this.url = url;
    this.headers = headers;
    this.rawHeaders = Object.entries(headers).flat();
  }
  feed(data) {
    if (!data?.length) return;
    this.#fed += data.length;
    this.push(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
  }
  finish() { this.push(null); }
  // Called when the service wants more: what it has read since the last call is credit for the main process.
  // read() empties the buffer only after it has called _read(), so the count is taken a moment later.
  _read() {
    queueMicrotask(() => {
      const consumed = this.#fed - this.readableLength - this.#acked;
      if (consumed > 0) { this.#acked += consumed; this.#credit(consumed); }
    });
  }
}

/** The response the service writes to. Everything written goes to `send(message, size)`, which answers true once the window is full. */
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
    let full = false;
    for (let at = 0; at < data.length; at += chunkSize) {
      const piece = data.subarray(at, at + chunkSize);
      full = this.#send({ t: 'chunk', id: this.#id, data: new Uint8Array(piece) }, piece.length);
    }
    done?.();
    return !full;
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
 * Connects a service to a channel. `post(message)` sends to the main process; `receive(message)` is what the channel delivers.
 * @returns { receive }
 */
export function serveRequests({ service, post, onClose }) {
  const live = new Map();
  service.onChange(() => post({ t: 'change' }));

  async function start(message) {
    const entry = { outstanding: 0, waiting: false };
    const request = new HostRequest({ method: message.method, url: message.url, headers: message.headers }, bytes => post({ t: 'body-credit', id: message.id, bytes }));
    const send = (item, size = 0) => {
      entry.outstanding += size;
      post(item);
      if (entry.outstanding >= responseWindow) { entry.waiting = true; return true; }
      return false;
    };
    const response = new HostResponse(request, message.id, send);
    Object.assign(entry, { request, response });
    live.set(message.id, entry);
    response.on('close', () => live.delete(message.id));
    if (!message.body) request.finish();
    try { await service.handle(request, response); }
    catch (error) { post({ t: 'error', id: message.id, message: String(error?.message ?? error) }); response.destroy(); }
  }

  return {
    async receive(message) {
      if (message.t === 'req') return start(message);
      const entry = live.get(message.id);
      if (message.t === 'body') { entry?.request.feed(message.data); return; }
      if (message.t === 'body-end') { entry?.request.finish(); return; }
      if (message.t === 'credit') {
        if (!entry) return;
        entry.outstanding = Math.max(0, entry.outstanding - message.bytes);
        if (entry.waiting && entry.outstanding < responseWindow) { entry.waiting = false; entry.response.emit('drain'); }
        return;
      }
      if (message.t === 'abort') { entry?.request.destroy(); entry?.response.destroy(); return; }
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
