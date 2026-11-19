// When the updater checks: once at launch, then once a day while the app is open. Nothing runs while the app is closed, and
// stop() ends the timer at once (the Settings switch). No Electron import.
export const dayMilliseconds = 24 * 60 * 60 * 1000;

/**
 * @param options.run called for each check; may return a promise. A failure is passed to `log` and never stops the schedule.
 * @param options.intervalMs time between checks
 * Timers are looked up on `globalThis` at call time, so tests can fake them.
 */
export function createSchedule({ run, intervalMs = dayMilliseconds, log = () => {} }) {
  let running = false;
  let timer = null;

  const fire = () => { void Promise.resolve().then(run).catch(error => log(`a scheduled check failed: ${error?.message ?? error}`)); };
  const arm = () => {
    timer = globalThis.setTimeout(() => {
      timer = null;
      if (!running) return;
      fire();
      arm();
    }, intervalMs);
    timer.unref?.();
  };

  return {
    /** Check now, then every interval. Does nothing when already running. */
    start() {
      if (running) return;
      running = true;
      fire();
      arm();
    },
    /** Cancel the timer. A check that is already running is not interrupted here. */
    stop() {
      running = false;
      if (timer) globalThis.clearTimeout(timer);
      timer = null;
    },
    get running() { return running; },
  };
}
