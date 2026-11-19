import assert from 'node:assert/strict';
import { test } from 'node:test';
import { superviseTransport } from '../../../src/main/supervisor.mjs';

/** A transport that can be made to exit or to stop answering. */
function fake() {
  let finish;
  const exited = new Promise(accept => { finish = accept; });
  const transport = {
    origin: 'app://opendoc', exited, answering: true, ended: false, killed: 0, stopped: 0,
    ping: async () => transport.answering,
    kill() { transport.killed++; transport.end(); },
    stop: async () => { transport.stopped++; transport.end(); },
    end() { if (!transport.ended) { transport.ended = true; finish({ code: 1 }); } },
  };
  return transport;
}

const options = { healthInterval: 0, backoff: 1 };

test('a service that exits is started again, the caller hears about it, and the states are restarting then running', async () => {
  const first = fake();
  const states = [];
  let starts = 0;
  const replaced = new Promise(accept => {
    const supervisor = superviseTransport({ ...options, transport: first, start: async () => { starts++; return fake(); }, onState: state => states.push(state), onReplaced: (next, old) => accept({ next, old, supervisor }) });
    void supervisor;
  });
  first.end();
  const { next, old, supervisor } = await replaced;
  assert.equal(starts, 1);
  assert.equal(old, first);
  assert.equal(supervisor.transport, next);
  await new Promise(accept => setTimeout(accept, 10));
  assert.deepEqual(states, ['restarting', 'running']);
  await supervisor.stop();
  assert.equal(next.stopped, 1);
});

test('a service that stops answering is killed and replaced after three missed checks', async () => {
  const first = fake();
  first.answering = false;
  const replaced = new Promise(accept => {
    superviseTransport({ healthInterval: 20, backoff: 1, transport: first, start: async () => fake(), onReplaced: (next, old) => accept({ next, old }) });
  });
  const { old } = await replaced;
  assert.equal(old, first);
  assert.equal(first.killed >= 1, true);
});

test('after too many restarts in a row it gives up, says failed, and reports why', async () => {
  let current = fake();
  const reasons = [];
  const states = [];
  const given = new Promise(accept => {
    superviseTransport({
      ...options, restartLimit: 2, transport: current,
      start: async () => { current = fake(); queueMicrotask(() => current.end()); return current; },
      onState: state => states.push(state),
      onFailed: reason => { reasons.push(reason); accept(); },
    });
  });
  current.end();
  await given;
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /stopped 3 times/);
  assert.equal(states.at(-1), 'failed');
});

test('a service that cannot be started again fails at once, with the reason', async () => {
  const first = fake();
  const states = [];
  const reason = new Promise(accept => {
    superviseTransport({ ...options, transport: first, start: async () => { throw new Error('no runtime'); }, onState: state => states.push(state), onFailed: accept });
  });
  first.end();
  assert.equal(await reason, 'no runtime');
  assert.deepEqual(states, ['restarting', 'failed']);
});

test('stopping the supervisor stops the service and prevents a restart', async () => {
  const first = fake();
  let starts = 0;
  const supervisor = superviseTransport({ ...options, transport: first, start: async () => { starts++; return fake(); } });
  await supervisor.stop();
  await new Promise(accept => setTimeout(accept, 30));
  assert.equal(first.stopped, 1);
  assert.equal(starts, 0);
});

test('"try again" starts a fresh service, clears the failure and reports the swap', async () => {
  let current = fake();
  const states = [];
  const swaps = [];
  const supervisor = superviseTransport({ ...options, restartLimit: 0, transport: current, start: async () => { current = fake(); return current; }, onState: state => states.push(state), onReplaced: (next, old) => swaps.push([next, old]), onFailed: () => {} });
  const first = current;
  current.end();
  await new Promise(accept => setTimeout(accept, 30));
  assert.equal(supervisor.failed, true);
  states.length = 0;
  const next = await supervisor.restart();
  assert.equal(supervisor.failed, false);
  assert.equal(supervisor.transport, next);
  assert.deepEqual(states, ['restarting', 'running']);
  assert.deepEqual(swaps, [[next, first]]);
  await supervisor.stop();
});

test('stopping while a restart is starting a host cancels that start, and no host is left running', async () => {
  const first = fake();
  const seen = [];
  const supervisor = superviseTransport({
    ...options, transport: first,
    start: signal => new Promise((accept, reject) => {
      seen.push(signal);
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    }),
  });
  first.end();
  while (seen.length === 0) await new Promise(accept => setTimeout(accept, 5));
  await supervisor.stop();
  assert.equal(seen[0].aborted, true);
  assert.equal(first.stopped, 1);
});

test('a start that finishes after stop() is stopped again, and a hand restart that loses the race throws', async () => {
  const first = fake();
  let release;
  const late = fake();
  const supervisor = superviseTransport({ ...options, transport: first, start: () => new Promise(accept => { release = () => accept(late); }) });
  const attempt = supervisor.restart().catch(error => error);
  while (!release) await new Promise(accept => setTimeout(accept, 5));
  const stopped = supervisor.stop();
  release();
  await stopped;
  assert.match(String(await attempt), /closing/);
  assert.equal(late.stopped, 1);
  assert.equal(supervisor.transport, first);
});
