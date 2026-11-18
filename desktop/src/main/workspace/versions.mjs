// The version table (plan 3.4): a workspace's pin against the app's runtime. Pure functions, no files.
export const packageNames = { normal: '@ryanyahya/opendoc', headless: '@ryanyahya/opendoc-headless' };

/** `{ major, minor, patch }` for an exact stable version `x.y.z` (what the CLI's isStableVersion accepts), else null. */
export function parseVersion(text) {
  if (typeof text !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(text)) return null;
  const [major, minor, patch] = text.split('.').map(Number);
  return [major, minor, patch].every(Number.isSafeInteger) ? { major, minor, patch } : null;
}

export function compareVersions(a, b) {
  const left = typeof a === 'string' ? parseVersion(a) : a;
  const right = typeof b === 'string' ? parseVersion(b) : b;
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

/**
 * The pin in a parsed package.json: `{ ok: true, edition, version }`, or `{ ok: false, code, message }` for a workspace the
 * app cannot take (no pin, a pin that is not an exact stable alias, or the headless edition).
 */
export function readPin(manifest) {
  const pin = manifest?.dependencies?.opendoc;
  for (const edition of ['normal', 'headless']) {
    const prefix = `npm:${packageNames[edition]}@`;
    if (typeof pin === 'string' && pin.startsWith(prefix) && parseVersion(pin.slice(prefix.length))) {
      const version = pin.slice(prefix.length);
      if (edition === 'headless') return { ok: false, code: 'headless', edition, version, message: `This workspace uses the headless edition of OpenDoc (${version}), which has no editor and no app. opendoc-desktop opens workspaces of the normal edition only, and switching edition is not an update, so nothing was changed. Use the headless package's own command for this folder.` };
      return { ok: true, edition, version };
    }
  }
  return { ok: false, code: 'malformed-pin', message: `The workspace's package.json does not pin OpenDoc the way the app needs (dependencies.opendoc must be npm:${packageNames.normal}@<exact version>${typeof pin === 'string' ? `, and it is "${pin}"` : ''}). Nothing was changed.` };
}

/**
 * What the app does with a workspace pinned at `pin` when its own runtime is `runtime` (both `x.y.z` strings).
 *   { kind: 'open', movePin }   open normally; the pin moves up to the runtime's version when it is behind
 *   { kind: 'upgrade', from, to }  an older minor (or major): the upgrade dialog
 *   { kind: 'readonly', reason, message }   a newer patch or a newer minor (or major): read-only, never lowering the pin
 */
export function decideVersion(pin, runtime) {
  const p = parseVersion(pin);
  const r = parseVersion(runtime);
  if (!p || !r) throw new TypeError('decideVersion needs two exact versions.');
  if (p.major === r.major && p.minor === r.minor) {
    if (p.patch <= r.patch) return { kind: 'open', movePin: p.patch < r.patch };
    return { kind: 'readonly', reason: 'newer-patch', message: `This workspace was last used with OpenDoc ${pin}, which is newer than this app (${runtime}). Update the app to edit it.` };
  }
  if (p.major < r.major || (p.major === r.major && p.minor < r.minor)) return { kind: 'upgrade', from: pin, to: runtime };
  return { kind: 'readonly', reason: 'newer-minor', message: `This workspace was upgraded by OpenDoc ${p.major}.${p.minor}. Update the app to edit it.` };
}

/** The banner text for a workspace opened read-only because the user declined the upgrade. */
export const declinedUpgradeMessage = (from, to) => `You chose to open this workspace read-only. It is still on OpenDoc ${from}; upgrade it to ${to} to edit it.`;
/** The banner text after Restore backup. */
export const restoredBackupMessage = from => `This workspace was restored from a backup and is on OpenDoc ${from} again. It stays read-only here; open it again to upgrade it.`;
