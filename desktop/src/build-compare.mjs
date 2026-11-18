// Spike S6: the build-aware version check (plan 3.7: "version first, then build").
// Kept free of Electron imports so a plain Node test can load it.
//
// The stock electron-updater check (AppUpdater.isUpdateAvailable) parses both versions with semver and answers "no update"
// when they are equal, so build 2 of 0.6.1 would never reach a user running build 1. This wraps any updater class:
// - different versions: the stock check decides, unchanged (rollout, minimum OS and downgrade rules included);
// - same version: an update exists when the release metadata's top-level `build:` is a whole number above the running build.
// A release without `build:` (or an older one) never counts as newer than the same version.
// "Version first, then build" (plan 3.7). The stock check compares versions only and answers "no update" when they are equal.
// The build number travels in the release's metadata file as an extra top-level `build:` field (electron-builder ignores it).
export function withBuildCompare(Base, getBuild) {
  return class extends Base {
    async isUpdateAvailable(info) {
      let same = false;
      try { same = this.currentVersion.compare(info.version) === 0; } catch { /* not a version: the stock check reports it */ }
      if (!same) return super.isUpdateAvailable(info); // different version: semver decides, as before
      const build = Number(info.build);
      if (!Number.isInteger(build) || build <= getBuild()) return false;
      if (!(await Promise.resolve(this.isUpdateSupported(info)))) return false;
      return Boolean(await Promise.resolve(this.isUserWithinRollout(info)));
    }
  };
}

