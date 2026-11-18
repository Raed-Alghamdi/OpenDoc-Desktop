// Keeps a workspace's service alive: restarts it when it exits and when it stops answering, and gives up
// (so the window can show the crash screen) when it keeps failing.
import { setTimeout as sleep } from 'node:timers/promises';

const failuresBeforeRestart = 3;

/**
 * @param start async () => a transport (see transport.mjs)
 * @param transport the transport that is running now
 * Callbacks: onState('restarting' | 'running' | 'failed') as the host's state changes (the page shows it);
 * onReplaced(newTransport, oldTransport) after a restart; onFailed(reason) when restarting stops.
 */
export function superviseTransport({ start, transport, healthInterval = 5000, restartLimit = 3, restartWindow = 120_000, backoff = 400, onState, onReplaced, onFailed, log = () => {} }) {
  let current = transport;
  let stopping = false;
  let busy = false;
  let failed = false;
  let history = [];
  let misses = 0;
  let timer = null;

  async function replace(reason) {
    if (stopping || busy) return;
    busy = true;
    try {
      const old = current;
      const now = Date.now();
      history = history.filter(time => now - time < restartWindow);
      if (history.length >= restartLimit) { failed = true; log(`giving up after ${history.length} restarts (${reason})`); onState?.('failed'); onFailed?.(`The OpenDoc service stopped ${history.length + 1} times in a row (${reason}).`); return; }
      history.push(now);
      log(`restarting the service (${reason})`);
      onState?.('restarting');
      old.kill();
      await old.exited;
      await sleep(backoff * history.length);
      if (stopping) return;
      let next;
      try { next = await start(); }
      catch (error) { failed = true; log(`the service did not start again: ${error.message}`); onState?.('failed'); onFailed?.(error.message); return; }
      if (stopping) { await next.stop(); return; }
      current = next;
      misses = 0;
      watch(next);
      onReplaced?.(next, old);
      onState?.('running');
    } finally { busy = false; }
  }

  function watch(target) {
    void target.exited.then(() => { if (!stopping && current === target) void replace('it exited'); });
  }

  async function check() {
    if (stopping || busy || failed) return;
    const target = current;
    if (await target.ping(Math.max(1000, healthInterval - 500))) { misses = 0; return; }
    if (stopping || busy || current !== target) return;
    if (++misses >= failuresBeforeRestart) { misses = 0; void replace('it stopped answering'); }
  }

  watch(current);
  if (healthInterval > 0) { timer = setInterval(() => void check(), healthInterval); timer.unref?.(); }

  return {
    get transport() { return current; },
    get failed() { return failed; },
    /** Start again by hand (the crash screen's "Try again"). Resolves with the new transport, or throws. */
    async restart() {
      if (stopping || busy) throw new Error('The service is already restarting.');
      busy = true;
      try {
        history = []; misses = 0; failed = false;
        const old = current;
        onState?.('restarting');
        old.kill();
        await old.exited;
        const next = await start();
        current = next;
        watch(next);
        onReplaced?.(next, old);
        onState?.('running');
        return next;
      } finally { busy = false; }
    },
    async stop() {
      stopping = true;
      clearInterval(timer);
      await current.stop();
    },
  };
}
