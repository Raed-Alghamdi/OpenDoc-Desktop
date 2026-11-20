import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bodyWindow, responseWindow, serveRequests } from '../../../src/host/service-host.mjs';

/** A channel that records what the host sends. */
function channel(service) {
  const sent = [];
  const post = message => { sent.push(message); };
  const host = serveRequests({ service, post, onClose: async () => { sent.push({ t: 'close-called' }); } });
  const request = (id, method, url, headers = {}, body = false) => host.receive({ t: 'req', id, method, url, headers: { host: 'opendoc', ...headers }, body });
  return { host, sent, request, of: id => sent.filter(message => message.id === id) };
}

const listeners = () => { const set = new Set(); return { set, onChange: listener => { set.add(listener); return () => set.delete(listener); } }; };
const bytes = message => Buffer.concat(message.filter(item => item.t === 'chunk').map(item => Buffer.from(item.data)));

test('a GET reaches the service as a Node request and its answer comes back as head, chunks and end', async () => {
  const seen = [];
  const { sent, request, of } = channel({
    ...listeners(),
    async handle(req, res) {
      seen.push({ method: req.method, url: req.url, host: req.headers.host, range: req.headers.range, complete: req.complete });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ token: 'abc' }));
    },
  });
  await request(1, 'GET', '/api/session?x=1');
  assert.deepEqual(seen, [{ method: 'GET', url: '/api/session?x=1', host: 'opendoc', range: undefined, complete: true }]);
  const answer = of(1);
  assert.deepEqual(answer.map(item => item.t), ['head', 'chunk', 'end']);
  assert.equal(answer[0].status, 200);
  assert.deepEqual(answer[0].headers, [['content-type', 'application/json'], ['cache-control', 'no-store']]);
  assert.equal(bytes(answer).toString(), '{"token":"abc"}');
  void sent;
});

test('a Range request passes its header intact and a 206 with Content-Range comes back as sent', async () => {
  const pdf = Buffer.from('0123456789'.repeat(20));
  const { request, of } = channel({
    ...listeners(),
    async handle(req, res) {
      const match = /^bytes=(\d+)-(\d+)?$/.exec(req.headers.range ?? '');
      if (!match) { res.writeHead(200, { 'Content-Length': pdf.length, 'Accept-Ranges': 'bytes' }); res.end(pdf); return; }
      const from = Number(match[1]);
      const to = Math.min(match[2] ? Number(match[2]) : pdf.length - 1, pdf.length - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${from}-${to}/${pdf.length}`, 'Content-Length': to - from + 1, 'Accept-Ranges': 'bytes' });
      res.end(pdf.subarray(from, to + 1));
    },
  });
  await request(1, 'GET', '/pdf', { range: 'bytes=10-19' });
  assert.equal(of(1)[0].status, 206);
  assert.deepEqual(of(1)[0].headers.find(([name]) => name === 'content-range'), ['content-range', 'bytes 10-19/200']);
  assert.equal(bytes(of(1)).toString(), '0123456789');
  await request(2, 'GET', '/pdf');
  assert.equal(of(2)[0].status, 200);
  assert.equal(bytes(of(2)).length, 200);
});

test('an upload arrives in pieces and the service reads all of it', async () => {
  let received;
  const { request, host, of } = channel({
    ...listeners(),
    async handle(req, res) {
      const parts = [];
      for await (const part of req) parts.push(part);
      received = Buffer.concat(parts);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ size: received.length }));
    },
  });
  const done = request(7, 'POST', '/api/assets/logo', { 'content-type': 'multipart/form-data; boundary=x' }, true);
  await host.receive({ t: 'body', id: 7, data: new Uint8Array([1, 2, 3]) });
  await host.receive({ t: 'body', id: 7, data: new Uint8Array([4, 5]) });
  await host.receive({ t: 'body-end', id: 7 });
  await done;
  assert.deepEqual([...received], [1, 2, 3, 4, 5]);
  assert.equal(of(7)[0].status, 201);
  assert.equal(bytes(of(7)).toString(), '{"size":5}');
});

test('a service that throws becomes an error message and the response is closed', async () => {
  const { request, of } = channel({ ...listeners(), async handle() { throw new Error('boom'); } });
  await request(3, 'GET', '/x');
  assert.deepEqual(of(3).map(item => item.t), ['error', 'end']);
  assert.equal(of(3)[0].message, 'boom');
  assert.equal(of(3)[1].aborted, true);
});

test('writing headers twice sends them once, and a handler sees headersSent after the first', async () => {
  let afterFirst;
  const { request, of } = channel({
    ...listeners(),
    async handle(req, res) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      afterFirst = res.headersSent;
      res.writeHead(500);
      res.end('ok');
    },
  });
  await request(4, 'GET', '/x');
  assert.equal(afterFirst, true);
  assert.deepEqual(of(4).filter(item => item.t === 'head').map(item => item.status), [200]);
});

test('an abort stops a request the service is still reading and a response it is still writing', async () => {
  let ended;
  const finished = new Promise(accept => { ended = accept; });
  const { request, host, of } = channel({
    ...listeners(),
    async handle(req, res) {
      res.once('close', ended);
      for await (const part of req) void part; // never finishes on its own
    },
  });
  const pending = request(5, 'POST', '/upload', {}, true);
  await host.receive({ t: 'abort', id: 5 });
  await finished;
  await pending.catch(() => {});
  assert.equal(of(5).some(item => item.t === 'end' && item.aborted), true);
});

test('changes the service reports are sent on', () => {
  const { set, onChange } = listeners();
  const { sent } = channel({ onChange, async handle() {} });
  for (const listener of set) listener();
  assert.deepEqual(sent, [{ t: 'change' }]);
});

test('the close message calls the close handler', async () => {
  const { host, sent } = channel({ ...listeners(), async handle() {} });
  await host.receive({ t: 'close' });
  assert.deepEqual(sent, [{ t: 'close-called' }]);
});

test('a response stops writing when the page is a window behind and resumes on credit', async () => {
  const chunk = Buffer.alloc(responseWindow / 2, 1);
  let wrote;
  const { request, host, sent } = channel({
    ...listeners(),
    async handle(req, res) {
      res.writeHead(200);
      wrote = [res.write(chunk), res.write(chunk), res.write(chunk)]; // the second fills the window
      await new Promise(accept => res.once('drain', accept));
      res.end();
    },
  });
  const done = request(6, 'GET', '/big');
  await new Promise(accept => setTimeout(accept, 30));
  assert.deepEqual(wrote, [true, false, false]);
  const unacknowledged = sent.filter(item => item.t === 'chunk').reduce((sum, item) => sum + item.data.length, 0);
  assert.equal(unacknowledged, responseWindow * 1.5, 'the host wrote the window plus the one write that crossed it, not the whole file');
  await host.receive({ t: 'credit', id: 6, bytes: responseWindow });
  await done;
  assert.equal(sent.filter(item => item.id === 6).at(-1).t, 'end');
});

test('an upload the service reads slowly sends credit only for what it has read', async () => {
  const gate = {};
  const reading = new Promise(accept => { gate.go = accept; });
  const { request, host, sent } = channel({
    ...listeners(),
    async handle(req, res) {
      await reading; // the service is busy and does not read yet
      req.on('data', () => {});
      await new Promise(accept => req.once('end', accept));
      res.writeHead(200);
      res.end('ok');
    },
  });
  const credit = () => sent.filter(item => item.t === 'body-credit').reduce((sum, item) => sum + item.bytes, 0);
  const done = request(8, 'POST', '/api/assets/logo', {}, true);
  await host.receive({ t: 'body', id: 8, data: new Uint8Array(100000) });
  await new Promise(accept => setTimeout(accept, 20));
  assert.equal(credit(), 0, 'nothing read, nothing acknowledged');
  gate.go();
  await new Promise(accept => setTimeout(accept, 30));
  assert.equal(credit(), 100000, 'everything the service read is credited');
  await host.receive({ t: 'body-end', id: 8 });
  await done;
  assert.ok(bodyWindow >= 1024 * 1024);
});

test('an upload of three windows read with readable and read(n), not data events, gets its credit back and arrives exactly', async () => {
  const piece = 256 * 1024;
  const total = 3 * bodyWindow;
  const source = Buffer.alloc(total);
  for (let at = 0; at < total; at++) source[at] = (at * 31 + (at >> 8)) & 255;
  let received = Buffer.alloc(0);
  const { request, host, sent } = channel({
    ...listeners(),
    async handle(req, res) {
      const parts = [];
      await new Promise((accept, reject) => {
        req.on('readable', () => { for (let part; (part = req.read(70001)) !== null;) parts.push(part); });
        req.on('end', accept);
        req.on('error', reject);
      });
      received = Buffer.concat(parts);
      res.writeHead(200);
      res.end('ok');
    },
  });
  const credited = () => sent.filter(item => item.t === 'body-credit').reduce((sum, item) => sum + item.bytes, 0);
  const done = request(9, 'POST', '/api/assets/logo', {}, true);
  // The main process under the rules: never more than one window of the upload that the host has not acknowledged.
  let outstanding = 0; let waits = 0; let peak = 0;
  for (let at = 0; at < total; at += piece) {
    const data = source.subarray(at, at + piece);
    const until = Date.now() + 5000;
    while (outstanding + data.length > bodyWindow) {
      assert.ok(Date.now() < until, 'credit came back for what the service read');
      waits++;
      await new Promise(accept => setTimeout(accept, 2));
      outstanding = at - credited();
    }
    await host.receive({ t: 'body', id: 9, data: new Uint8Array(data) });
    outstanding = at + data.length - credited();
    peak = Math.max(peak, outstanding);
  }
  await host.receive({ t: 'body-end', id: 9 });
  await done;
  assert.ok(waits > 0, 'the sender had to wait for credit at least once (3 windows do not fit in one)');
  assert.ok(peak <= bodyWindow, 'never more than a window unacknowledged');
  assert.equal(received.length, total);
  assert.equal(Buffer.compare(received, source), 0, 'the bytes arrive exactly');
  // What the service reads after the end of the body is not credited (nobody is waiting for it), so the tail is at most one window.
  assert.ok(credited() >= total - bodyWindow && credited() <= total, 'credit was returned for what was read while the upload ran');
});
