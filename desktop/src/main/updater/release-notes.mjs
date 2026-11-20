// "What changed", shown once after the app starts on a newer build than the last run, and the hook that tells
// other parts of the app that an update just happened. The last run is kept in config.json as `lastRun: { version, build }`.
// No Electron import.
import { parseBuild } from './build-compare.mjs';

const stable = /^(\d+)\.(\d+)\.(\d+)$/;

/** -1, 0 or 1 for two x.y.z versions; null when either is something else (a pre-release, text). */
export function compareVersions(a, b) {
  const left = stable.exec(String(a));
  const right = stable.exec(String(b));
  if (!left || !right) return null;
  for (let index = 1; index <= 3; index++) {
    const difference = Number(left[index]) - Number(right[index]);
    if (difference) return difference < 0 ? -1 : 1;
  }
  return 0;
}

/** `{ version, build }` as stored, or null when the value is not one. */
export function readRun(value) {
  if (!value || typeof value !== 'object' || typeof value.version !== 'string') return null;
  const build = parseBuild(value.build);
  return build === null ? null : { version: value.version, build };
}

/**
 * What this launch is, compared with the last one:
 *   unknown    this build has no build number (a development run): nothing is recorded or shown
 *   first-run  no earlier run on record (a fresh install): recorded, nothing shown
 *   same       the same version and build
 *   updated    a newer version, or the same version with a higher build: show what changed, once
 *   older      an older build than the last run (a downgrade by hand, or an older package): recorded, nothing shown
 *   unordered  two different versions that are not plain x.y.z, so which is newer is unknown: recorded, nothing shown
 */
export function launchOutcome({ last, current }) {
  const now = readRun(current);
  if (!now) return { kind: 'unknown' };
  const before = readRun(last);
  if (!before) return { kind: 'first-run', current: now };
  const versions = compareVersions(now.version, before.version);
  const order = versions === null ? (now.version === before.version ? 0 : null) : versions;
  if (order === null) return { kind: 'unordered', current: now };
  if (order > 0 || (order === 0 && now.build > before.build)) return { kind: 'updated', previous: before, current: now };
  if (order === 0 && now.build === before.build) return { kind: 'same', current: now };
  return { kind: 'older', previous: before, current: now };
}

export const describeRun = run => `${run.version}, build ${run.build}`;
