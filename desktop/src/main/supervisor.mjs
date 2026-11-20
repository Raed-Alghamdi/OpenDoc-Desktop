// Keeps a workspace's service alive: restarts it when it exits and when it stops answering, and gives up
// (so the window can show the crash screen) when it keeps failing.
import { setTimeout as sleep } from 'node:timers/promises';

const failuresBeforeRestart = 3;

/**
 * @param start async (signal) => a transport (see transport.mjs); the signal aborts a start that is still going (the app is quitting)
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
  let working = null; // the restart in progress, so that stop() can wait for it
  let starting = null; // the start in progress: { controller, promise }

  /** One start of the service, which stop() can cancel. */
  async function begin() {
    const controller = new AbortController();
    const promise = start(controller.signal);
    starting = { controller, promise };
    try { return await promise; } finally { if (starting?.promise === promise) starting = null; }
  }

  function replace(reason) {
    if (stopping || busy) return undefined;
    busy = true;
    working = replacing(reason).finally(() => { busy = false; });
    return working;
  }

  async function replacing(reason) {
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
    try { next = await begin(); }
    catch (error) {
      if (stopping) return;
      failed = true; log(`the service did not start again: ${error.message}`); onState?.('failed'); onFailed?.(error.message); return;
    }
    if (stopping) { await next.stop(); return; }
    current = next;
    misses = 0;
    watch(next);
    onReplaced?.(next, old);
    onState?.('running');
  }

  function watch(target) {
    void target.exited.then(async () => {
      while (busy && !stopping) await working?.catch(() => {}); // an exit during a swap is handled once the swap is over
      if (!stopping && !failed && current === target) void replace('it exited');
    });
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
      const run = (async () => {
        history = []; misses = 0; failed = false;
        const old = current;
        onState?.('restarting');
        old.kill();
        await old.exited;
        if (stopping) throw new Error('The app is closing.');
        const next = await begin();
        if (stopping) { await next.stop(); throw new Error('The app is closing.'); }
        current = next;
        watch(next);
        onReplaced?.(next, old);
        onState?.('running');
        return next;
      })();
      working = run.finally(() => { busy = false; });
      working.catch(() => {});
      return run;
    },
    /** Stop supervising and stop the service. A start that is still going is cancelled, and a restart in progress is waited for. */
    async stop() {
      stopping = true;
      clearInterval(timer);
      starting?.controller.abort();
      await working?.catch(() => {});
      await current.stop();
    },
  };
}
