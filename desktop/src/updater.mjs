// Spike S6: the updater design for E7 (plan 3.7), as running code.
//
// - One class per install type, all built on electron-updater 6.8.11, each with a build-aware version check.
// - Only HTTPS release addresses are accepted; plain http only for loopback (the spike's test feed).
// - A marker file next to the app (written by the AUR package) switches the updater off before anything is built.
// - macOS has no paid signing, so it gets its own install step on top of electron-updater's download and checksum.
import { app } from 'electron';
import { execFileSync, spawn } from 'node:child_process';
import { accessSync, appendFileSync, constants, existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { AppImageUpdater, DebUpdater, RpmUpdater, PacmanUpdater, MacUpdater } = require('electron-updater');

import { withBuildCompare } from './build-compare.mjs';

const resources = () => (app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'build'));
export const configDir = () => path.join(process.env.XDG_CONFIG_HOME ?? (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : path.join(os.homedir(), '.config')), 'opendoc-desktop');

// Test hooks of the spike (an environment variable, or updater-test.json in the config folder for launches that cannot set one).
export function testSettings() {
  let file = {};
  try { file = JSON.parse(readFileSync(path.join(configDir(), 'updater-test.json'), 'utf8')); } catch {}
  return {
    url: process.env.OPENDOC_UPDATE_URL ?? file.url ?? null,
    action: process.env.OPENDOC_UPDATE_ACTION ?? file.action ?? 'none',
    log: process.env.OPENDOC_UPDATE_LOG ?? file.log ?? null,
    wait: Number(process.env.OPENDOC_UPDATE_WAIT ?? file.wait ?? 120),
  };
}

export function log(event, data = {}) {
  const line = JSON.stringify({ t: new Date().toISOString(), pid: process.pid, event, ...data });
  console.log(line);
  const file = testSettings().log;
  if (file) { try { appendFileSync(file, line + '\n'); } catch {} }
}

export function currentBuild() {
  try { return Number(JSON.parse(readFileSync(path.join(resources(), 'runtime', 'build-info.json'), 'utf8')).build); } catch { return 0; }
}

// Which kind of install this is, and whether the in-app updater may run at all.
export function installType() {
  if (existsSync(path.join(resources(), 'update-disabled'))) return { type: 'managed', disabled: 'marker file resources/update-disabled (package manager owns the app)' };
  // The Settings switch ("Check for updates") is stored in the app's config file; off means no network calls at all.
  try { if (JSON.parse(readFileSync(path.join(configDir(), 'config.json'), 'utf8')).checkForUpdates === false) return { type: 'off', disabled: 'switched off in Settings (config.json checkForUpdates: false)' }; } catch {}
  if (process.platform === 'darwin') return { type: 'mac' };
  if (process.env.APPIMAGE) return { type: 'appimage' };
  try {
    const t = readFileSync(path.join(resources(), 'package-type'), 'utf8').trim();
    if (['deb', 'rpm', 'pacman'].includes(t)) return { type: t };
  } catch {}
  return { type: 'unknown', disabled: 'not an AppImage, a known package or a Mac app' };
}

// One configurable release address, https only. Loopback http is allowed for tests and for nothing else.
export function checkFeedUrl(raw) {
  const u = new URL(raw);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol === 'https:' || (u.protocol === 'http:' && loopback)) return u;
  throw new Error(`update address must be https (got ${u.protocol}//${u.hostname})`);
}

// macOS without a paid certificate: electron-updater downloads and checks the zip (sha512 from the release metadata), then we
// install it ourselves. MacUpdater's own install step hands the zip to Squirrel.Mac, which needs a signature it can validate.
function freeMacUpdater(getBuild) {
  return class extends withBuildCompare(MacUpdater, getBuild) {
    // Called by MacUpdater after the download and the checksum: keep the file, skip Squirrel's proxy server.
    async updateDownloaded(zipFileInfo, event) {
      this.downloadedZip = event.downloadedFile;
      this.dispatchUpdateDownloaded(event);
      return [];
    }
    installFree() { return installFreeMac(this.downloadedZip, this._logger); }
  };
}

// Where the running bundle is, and whether it can be replaced where it stands.
export function macBundleState() {
  const exe = process.execPath; // <name>.app/Contents/MacOS/<name>
  const bundle = path.resolve(exe, '..', '..', '..');
  const state = { exe, bundle, translocated: exe.includes('/AppTranslocation/'), writable: false };
  try { accessSync(path.dirname(bundle), constants.W_OK); accessSync(bundle, constants.W_OK); state.writable = true; } catch {}
  try { state.quarantine = execFileSync('xattr', ['-p', 'com.apple.quarantine', bundle], { encoding: 'utf8' }).trim(); } catch { state.quarantine = null; }
  return state;
}

// Unzip next to the running app, check the new bundle, then let a helper swap it in after this process has exited.
function installFreeMac(zipFile, logger) {
  const st = macBundleState();
  if (st.translocated) throw Object.assign(new Error('the app runs from a translocated read-only copy; move it to Applications first'), { code: 'MOVE_TO_APPLICATIONS' });
  if (!st.writable) throw Object.assign(new Error(`cannot write to ${path.dirname(st.bundle)}`), { code: 'NOT_WRITABLE' });
  const parent = path.dirname(st.bundle);
  const stage = mkdtempSync(path.join(parent, '.opendoc-desktop-update-'));
  execFileSync('ditto', ['-xk', zipFile, stage]); // keeps signatures, symlinks and modes; sets no quarantine flag
  const fresh = path.join(stage, path.basename(st.bundle));
  if (!existsSync(fresh)) throw new Error(`the update zip has no ${path.basename(st.bundle)}`);
  execFileSync('codesign', ['--verify', '--deep', '--strict', fresh]);
  const plist = (b, key) => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path.join(b, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim();
  if (plist(fresh, 'CFBundleIdentifier') !== plist(st.bundle, 'CFBundleIdentifier')) throw new Error('the update has another bundle identifier');
  const info = { version: plist(fresh, 'CFBundleShortVersionString'), build: Number(plist(fresh, 'CFBundleVersion')) };
  logger.info(`new bundle verified: ${JSON.stringify(info)}`);
  const old = `${st.bundle}.old-${process.pid}`;
  // Wait for this process to exit, move the old bundle aside, move the new one in, start it, delete the old one.
  const script = `while kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; done
mv "$1" "$2" && mv "$3" "$1" || { [ -e "$2" ] && [ ! -e "$1" ] && mv "$2" "$1"; echo "swap failed" >> "$5"; exit 1; }
rm -rf "$4"
open "$1"
rm -rf "$2"
echo "swapped" >> "$5"`;
  const helperLog = path.join(os.tmpdir(), `opendoc-update-helper-${process.pid}.log`);
  const child = spawn('/bin/sh', ['-c', script, 'sh', st.bundle, old, fresh, stage, helperLog], { detached: true, stdio: 'ignore' });
  child.unref();
  return { info, helperLog };
}

export function createUpdater({ stockMac = false } = {}) {
  const ts = testSettings();
  const kind = installType();
  if (kind.disabled) return { kind, updater: null };
  const getBuild = currentBuild;
  const classes = {
    appimage: withBuildCompare(AppImageUpdater, getBuild),
    deb: withBuildCompare(DebUpdater, getBuild),
    rpm: withBuildCompare(RpmUpdater, getBuild),
    pacman: withBuildCompare(PacmanUpdater, getBuild),
    // stockMac keeps electron-updater's own macOS install (Squirrel.Mac) so the spike can record how it fails without paid signing.
    mac: stockMac ? withBuildCompare(MacUpdater, getBuild) : freeMacUpdater(getBuild),
  };
  const updater = new classes[kind.type]();
  updater.logger = { info: (m) => log('updater-info', { m: String(m) }), warn: (m) => log('updater-warn', { m: String(m) }), error: (m) => log('updater-error', { m: String(m) }), debug: () => {} };
  if (ts.url) {
    const feed = checkFeedUrl(ts.url);
    if (feed.pathname.endsWith('/github-like')) {
      // The real feed shape: GitHub releases, found through the latest release's tag. Here a test server speaks the same URLs.
      updater.setFeedURL({ provider: 'github', owner: 'Raed-Alghamdi', repo: 'OpenDoc-Desktop', host: feed.host, protocol: feed.protocol.replace(':', '') });
    } else {
      updater.setFeedURL({ provider: 'generic', url: feed.href });
    }
  }
  updater.autoDownload = true;
  // AppImage swaps by itself when the app quits. Packages need a click ("Restart to update") because of the password prompt.
  updater.autoInstallOnAppQuit = kind.type === 'appimage' || stockMac;
  updater.autoRunAppAfterInstall = true;
  if (kind.type === 'appimage') {
    updater.on('appimage-filename-updated', (to) => { log('appimage-renamed', { to }); retargetShim(to); });
  }
  for (const name of ['checking-for-update', 'update-available', 'update-not-available', 'update-downloaded', 'update-cancelled']) {
    updater.on(name, (info) => log(name, info ? { version: info.version, build: info.build, file: info.downloadedFile } : {}));
  }
  updater.on('error', (e) => log('error', { message: String(e?.message ?? e).slice(0, 600) }));
  let lastPct = -1;
  updater.on('download-progress', (p) => {
    const pct = Math.floor(p.percent / 10) * 10;
    if (pct !== lastPct) { lastPct = pct; log('download-progress', { percent: Math.round(p.percent), transferred: p.transferred, total: p.total }); }
  });
  return { kind, updater };
}

// The AppImage's `opendoc` command holds the AppImage's path. When an update renames the file (new version in the name),
// the app rewrites the path in the command in the same step, so the command works before the app is opened again.
export function retargetShim(newPath) {
  const shim = path.join(os.homedir(), '.local', 'bin', 'opendoc');
  if (!existsSync(shim)) return false;
  const text = readFileSync(shim, 'utf8');
  const next = text.replace(/^APPIMAGE='[^']*'$/m, `APPIMAGE='${newPath.replace(/'/g, `'\\''`)}'`);
  if (next === text) return false;
  const tmp = `${shim}.${process.pid}.tmp`;
  writeFileSync(tmp, next, { mode: 0o755 });
  renameSync(tmp, shim);
  log('shim-retargeted', { to: newPath });
  return true;
}

