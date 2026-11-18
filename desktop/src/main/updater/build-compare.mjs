// The build-aware version check (plan 3.7: "version first, then build"). No Electron import, so plain Node tests can load it.
//
// electron-updater's stock check (AppUpdater.isUpdateAvailable) parses both versions with semver and answers "no update" when they
// are equal, so build 2 of 0.6.1 would never reach a user running build 1. This wraps any updater class:
//   - different versions: the stock check decides, unchanged (rollout, minimum OS and downgrade rules included);
//   - the same version: an update exists only when the release metadata's top-level `build:` is a whole number above the running
//     build. A release without `build:` (or an older one) is never newer than the same version.

/** A build number from the metadata: a whole number, or digits written as text. Anything else is not a build. */
export function parseBuild(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value === 'string' && /^\d{1,15}$/.test(value.trim())) return Number(value.trim());
  return null;
}

export function withBuildCompare(Base, getBuild) {
  return class extends Base {
    async isUpdateAvailable(info) {
      let same = false;
      try { same = this.currentVersion.compare(info.version) === 0; } catch { /* not a version: the stock check reports it */ }
      if (!same) return super.isUpdateAvailable(info);
      const build = parseBuild(info.build);
      const running = Number(getBuild()) || 0;
      if (build === null || build <= running) return false;
      if (!(await Promise.resolve(this.isUpdateSupported(info)))) return false;
      return Boolean(await Promise.resolve(this.isUserWithinRollout(info)));
    }
  };
}
