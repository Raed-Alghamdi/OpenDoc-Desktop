import assert from 'node:assert/strict';
import { test } from 'node:test';
import { superviseTransport } from '../../../src/main/supervisor.mjs';

/** A transport that can be made to exit or to stop answering. */
function fake(port = 4000) {
  let finish;
  const exited = new Promise(accept => { finish = accept; });
  const transport = {
    origin: `http://127.0.0.1:${port}`, port, exited, answering: true, ended: false, killed: 0, stopped: 0,
    ping: async () => transport.answering,
    kill() { transport.killed++; transport.end(); },
    stop: async () => { transport.stopped++; transport.end(); },
    end() { if (!transport.ended) { transport.ended = true; finish({ code: 1 }); } },
  };
  return transport;
}

const options = { healthInterval: 0, backoff: 1 };

test('a service that exits is started again on its old port, and the caller hears about it', async () => {
  const first = fake(4000);
  const started = [];
  const replaced = new Promise(accept => {
    const supervisor = superviseTransport({ ...options, transport: first, start: async port => { started.push(port); return fake(port); }, onReplaced: (next, old) => accept({ next, old, supervisor }) });
    void supervisor;
  });
  first.end();
  const { next, old, supervisor } = await replaced;
  assert.deepEqual(started, [4000]);
  assert.equal(old, first);
  assert.equal(supervisor.transport, next);
  await supervisor.stop();
  assert.equal(next.stopped, 1);
});

test('a service that stops answering is killed and replaced after three missed checks', async () => {
  const first = fake(4001);
  first.answering = false;
  const replaced = new Promise(accept => {
    superviseTransport({ healthInterval: 20, backoff: 1, transport: first, start: async port => fake(port), onReplaced: (next, old) => accept({ next, old }) });
  });
  const { old } = await replaced;
  assert.equal(old, first);
  assert.equal(first.killed >= 1, true);
});

test('after too many restarts in a row it gives up and reports why', async () => {
  let current = fake(4002);
  const reasons = [];
  const given = new Promise(accept => {
    superviseTransport({
      ...options, restartLimit: 2, transport: current,
      start: async port => { current = fake(port); queueMicrotask(() => current.end()); return current; },
      onFailed: reason => { reasons.push(reason); accept(); },
    });
  });
  current.end();
  await given;
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /stopped 3 times/);
});

test('stopping the supervisor stops the service and prevents a restart', async () => {
  const first = fake(4003);
  let starts = 0;
  const supervisor = superviseTransport({ ...options, transport: first, start: async () => { starts++; return fake(); } });
  await supervisor.stop();
  await new Promise(accept => setTimeout(accept, 30));
  assert.equal(first.stopped, 1);
  assert.equal(starts, 0);
});

test('"try again" starts a fresh service and clears the failure', async () => {
  let current = fake(4004);
  const supervisor = superviseTransport({ ...options, restartLimit: 0, transport: current, start: async port => { current = fake(port); return current; }, onFailed: () => {} });
  current.end();
  await new Promise(accept => setTimeout(accept, 30));
  assert.equal(supervisor.failed, true);
  const next = await supervisor.restart();
  assert.equal(supervisor.failed, false);
  assert.equal(supervisor.transport, next);
  await supervisor.stop();
});
