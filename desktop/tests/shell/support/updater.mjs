// Helpers for the updater's tests: real electron-updater classes on a fake app adapter, a scripted updater for the controller,
// and a folder of fake system tools (pkexec, dpkg, ...) that record what they were asked to do.
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmod, copyFile, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const scratch = prefix => mkdtemp(join(tmpdir(), `opendoc-${prefix}-`));

/** What electron-updater asks of the app (it is Electron's `app` in the real thing). */
export const fakeAdapter = (version, folder) => ({ version, name: 'opendoc-desktop', isPackaged: true, appUpdateConfigPath: '', userDataPath: folder, baseCachePath: folder, whenReady: async () => {}, quit() {}, relaunch() {}, onQuit() {} });

/** An instance of an updater class, with the logger silenced. */
export function newUpdater(Class, version, folder) {
  const updater = new Class(null, fakeAdapter(version, folder));
  updater.logger = { info() {}, warn() {}, error() {}, debug() {} };
  return updater;
}

/**
 * A scripted stand-in for an electron-updater instance, for the controller's tests.
 * script: { preflight, check: result | (updater) => result, install: result | (updater) => result, installAtQuit }. A check result's downloadPromise is what downloadUpdate() resolves.
 */
export class FakeUpdater extends EventEmitter {
  constructor(script = {}) {
    super();
    Object.assign(this, { autoDownload: true, autoInstallOnAppQuit: true, autoRunAppAfterInstall: true, checks: 0, installs: 0, quitInstalls: 0, script });
  }

  async preflight() { return this.script.preflight ?? { ok: true }; }

  async checkForUpdates() {
    this.checks++;
    this.lastAutoDownload = this.autoDownload;
    const result = await (typeof this.script.check === 'function' ? this.script.check(this) : this.script.check);
    if (result instanceof Error) throw result;
    this.lastResult = result ?? { isUpdateAvailable: false };
    return this.lastResult;
  }

  /** The controller downloads after the check (autoDownload is off during it): the script's downloadPromise is the download. */
  async downloadUpdate(token) {
    this.downloads = (this.downloads ?? 0) + 1;
    this.lastToken = token;
    return this.lastResult?.downloadPromise ?? [];
  }

  async installDownloaded() {
    this.installs++;
    return typeof this.script.install === 'function' ? this.script.install(this) : (this.script.install ?? { outcome: 'installed' });
  }

  downloaded() { return { file: '/cache/update.deb', sha512: 'x' }; }

  /** Every install type empties the updater's pending folder here (the downloaded file and update-info.json). */
  async clearDownloaded() {
    if (this.script.clearError) throw new Error(this.script.clearError);
    this.cleared = (this.cleared ?? 0) + 1;
  }

  installAtQuit() {
    this.quitInstalls++;
    return this.script.installAtQuit ? this.script.installAtQuit(this) : true;
  }
}

/** An update that was found and downloaded. */
export const downloadedUpdate = (version = '0.6.1', build = 2) => ({ isUpdateAvailable: true, updateInfo: { version, build }, downloadPromise: Promise.resolve([]), cancellationToken: { cancel() {} } });

const helperSource = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'resources', 'updater', 'install-update');

/**
 * A throwaway Ed25519 release key for a test. `sign(bytes)` is the raw 64-byte signature the release would publish for a file;
 * `helperFolder()` copies the real install-update helper into a new folder with this key's public half beside it (release-key.pem),
 * which is where the production helper looks, so the production helper is never changed to make a test pass.
 */
export function testReleaseKey() {
  const { privateKey, publicKey } = generateKeyPair();
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  return {
    publicPem,
    sign: bytes => sign(null, Buffer.from(bytes), privateKey),
    async helperFolder(folder) {
      folder ??= await scratch('helper');
      await copyFile(helperSource, join(folder, 'install-update'));
      await chmod(join(folder, 'install-update'), 0o755);
      await writeFile(join(folder, 'release-key.pem'), publicPem);
      return folder;
    },
  };
}
const generateKeyPair = () => generateKeyPairSync('ed25519');

/**
 * A folder of fake system tools, the only entry of a PATH, next to links to the few real tools the install script needs
 * (the real openssl too, unless `withOpenssl` is false: a machine without it).
 * Each fake records its arguments (NUL separated, a record separator after each call) to <folder>/calls/<name> and exits with $FAKE_<NAME>_EXIT
 * (default 0). pkexec records, then runs what follows its own flag as the current user.
 */
export async function fakeTools(names = ['pkexec', 'dpkg', 'apt-get'], { withOpenssl = true } = {}) {
  const folder = await scratch('tools');
  const bin = join(folder, 'bin');
  await mkdir(bin);
  await mkdir(join(folder, 'calls'));
  for (const tool of ['mktemp', 'cp', 'rm', 'sha512sum', 'sh', 'cat', 'sleep', 'wc', 'dirname', ...(withOpenssl ? ['openssl'] : [])]) {
    const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    if (!found) throw new Error(`The test machine has no ${tool}.`);
    await symlink(found, join(bin, tool));
  }
  for (const name of names) {
    const variable = `FAKE_${name.toUpperCase().replace(/-/g, '_')}_EXIT`;
    const run = name === 'pkexec'
      ? `if [ -n "\${${variable}:-}" ]; then exit "$${variable}"; fi
if [ "$1" = "--disable-internal-agent" ]; then shift; fi
exec "$@"`
      : `exit "\${${variable}:-0}"`;
    const record = join(folder, 'calls', name);
    await writeFile(join(bin, name), `#!/bin/sh\nprintf '%s\\0' "$@" >> "${record}"\nprintf '\\036' >> "${record}"\n${run}\n`);
    await chmod(join(bin, name), 0o755);
  }
  /** The calls to a tool, each as an array of arguments. */
  const calls = async name => {
    const text = await readFile(join(folder, 'calls', name), 'utf8').catch(() => '');
    return text.split('\x1e').filter(Boolean).map(call => call.split('\0').slice(0, -1));
  };
  return { folder, bin, env: extra => ({ PATH: bin, ...extra }), calls };
}
