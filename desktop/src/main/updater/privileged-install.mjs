// Installing a downloaded deb, rpm or pacman file with the system's password. No Electron import.
//
// electron-updater's own install runs `pkexec ... dpkg -i` with spawnSync, which freezes every window while the password prompt is
// open, and after Cancel it opens a second prompt for `apt-get install -f -y`. This does it with one asynchronous pkexec call that
// runs one script: Cancel ends it, and the app stays responsive.
//
// The script runs as root, so it does not trust the downloaded file where it lies (the user's cache): it copies the file into a
// root-owned folder, checks the SHA-512 from the release metadata on the copy, and installs the copy.
//
// Two ways to run that script. The packaged app's own install (deb, rpm, pacman) ships it as a root-owned helper,
// <resources>/updater/install-update, with a polkit action that names it (resources/polkit), and runs `pkexec <helper> <args>`: the
// password prompt then shows the action's sentence. Anything else (an older install without the helper, an unpackaged run) keeps
// the original call, `pkexec /bin/sh -c <script>`, whose prompt shows the whole script but works without any installed file.
import { spawn as nodeSpawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { basename, delimiter, extname, isAbsolute, join } from 'node:path';

/** The polkit action the packages install, and the file that defines it. */
export const actionId = 'io.github.ryanyahya.opendocdesktop.install-update';
export const policyFile = `/usr/share/polkit-1/actions/${actionId}.policy`;
/** Where the helper sits inside the app's resources folder (the packages install the app under /opt/opendoc-desktop). */
export const helperRelativePath = join('updater', 'install-update');

export const installCommands = {
  deb: 'dpkg -i "$pkg" || apt-get install -f -y',
  rpm: `if command -v zypper >/dev/null 2>&1; then zypper --non-interactive --no-refresh install --allow-unsigned-rpm -f "$pkg"
  elif command -v dnf >/dev/null 2>&1; then dnf install --nogpgcheck -y "$pkg"
  elif command -v yum >/dev/null 2>&1; then yum install --nogpgcheck -y "$pkg"
  else rpm -Uvh --replacepkgs --replacefiles --nodeps "$pkg"; fi`,
  pacman: 'pacman -U --noconfirm "$pkg"',
};

/** Exit code of the script when the copy does not match the checksum. */
export const checksumExitCode = 70;

/**
 * The script for one package type. Arguments: $1 the file, $2 its SHA-512 in hex, $3 the file extension.
 * The install step's own 126 and 127 (a tool that is missing) become 1, so they are never taken for pkexec's "dismissed".
 */
export function installScript(type) {
  const command = installCommands[type];
  if (!command) throw new Error(`No installer for ${type}.`);
  return `set -u
tmp=$(mktemp -d) || exit 1
trap 'rm -rf "$tmp"' EXIT
pkg="$tmp/update.$3"
cp -- "$1" "$pkg" || exit 1
printf '%s  %s\\n' "$2" "$pkg" | sha512sum -c - >/dev/null 2>&1 || { echo 'opendoc-desktop: the update file does not match its checksum' >&2; exit ${checksumExitCode}; }
(
  ${command}
)
status=$?
if [ "$status" -eq 126 ] || [ "$status" -eq 127 ]; then status=1; fi
exit $status
`;
}

/** A sha512 as electron-builder writes it (base64) to the hex that sha512sum prints. Null when it is not a SHA-512. */
export function sha512Hex(base64) {
  if (typeof base64 !== 'string') return null;
  const bytes = Buffer.from(base64, 'base64');
  return bytes.length === 64 && bytes.toString('base64') === base64 ? bytes.toString('hex') : null;
}

/**
 * The arguments for pkexec. --disable-internal-agent: without a graphical agent pkexec fails instead of asking in a terminal.
 * With `helper` (the installed helper's path) pkexec runs that file; without, it runs the script through /bin/sh -c.
 */
export function pkexecArguments({ type, file, sha512, helper = null }) {
  const hex = sha512Hex(sha512);
  if (!hex) throw new Error('The release has no usable SHA-512 for this file.');
  if (!isAbsolute(file)) throw new Error('The downloaded file has no absolute path.');
  const extension = extname(basename(file)).slice(1) || type;
  if (helper) {
    if (!installCommands[type]) throw new Error(`No installer for ${type}.`);
    return ['--disable-internal-agent', helper, file, hex, extension];
  }
  return ['--disable-internal-agent', '/bin/sh', '-c', installScript(type), 'opendoc-desktop-update', file, hex, extension];
}

/**
 * The installed helper's path when the helper and its polkit action are both there and agree, otherwise null (use the fallback).
 * Agreement matters: pkexec finds the action by the program's path, and a helper the action does not name would get polkit's generic
 * prompt that shows the command line. The helper must be root-owned and not writable by anyone else.
 * `resourcesPath` is process.resourcesPath of the packaged app; the rest is for tests.
 */
export async function findHelper({ resourcesPath = process.resourcesPath, policy = policyFile, readText = path => readFile(path, 'utf8'), statFile = stat } = {}) {
  if (!resourcesPath || !isAbsolute(resourcesPath)) return null;
  const helper = join(resourcesPath, helperRelativePath);
  try {
    const info = await statFile(helper);
    if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0 || (info.mode & 0o111) === 0) return null;
    const text = await readText(policy);
    const start = text.indexOf(`<action id="${actionId}"`);
    const block = start < 0 ? '' : text.slice(start, text.indexOf('</action>', start));
    const execPath = block.match(/<annotate key="org\.freedesktop\.policykit\.exec\.path">([^<]*)<\/annotate>/)?.[1];
    return execPath === helper ? helper : null;
  } catch { return null; }
}

/** Turn pkexec's exit into what the app does next: installed, cancelled (keep the download, offer again) or failed. */
export function classifyExit(code, stderr = '') {
  if (code === 0) return { outcome: 'installed' };
  if (code === 126) return { outcome: 'cancelled' };
  if (code === 127) {
    if (/no authentication agent/i.test(stderr)) return { outcome: 'failed', reason: 'no-agent', message: 'No password prompt is available in this desktop session (no polkit authentication agent is running).' };
    return { outcome: 'cancelled' };
  }
  if (code === checksumExitCode) return { outcome: 'failed', reason: 'checksum', message: 'The downloaded file did not match its checksum when it was about to be installed, so nothing was installed.' };
  return { outcome: 'failed', reason: 'install', message: tail(stderr) || `The installer exited with code ${code}.` };
}

const tail = text => String(text).split('\n').map(line => line.trim()).filter(Boolean).slice(-4).join('\n').slice(-600);

/** PATH without relative entries, as electron-updater does, so a writable folder in the way cannot shadow pkexec. */
export const safePath = value => String(value ?? '').split(delimiter).filter(entry => isAbsolute(entry)).join(delimiter);

/**
 * Run the install. Asynchronous: the caller's event loop (and every window) keeps running while the password prompt is open.
 * Resolves { outcome: 'installed' | 'cancelled' | 'failed', reason?, message?, code }.
 * `spawn` and `env` are for tests (a fake pkexec first on PATH).
 */
export async function installPackage({ type, file, sha512, spawn = nodeSpawn, env = process.env, log = () => {}, helper }) {
  // `helper` is for tests: a path (use it as found), null (use the fallback), or left out (look for the installed one).
  if (helper === undefined) helper = await findHelper();
  let args;
  try { args = pkexecArguments({ type, file, sha512, helper }); }
  catch (error) { return { outcome: 'failed', reason: 'input', message: error.message, code: null }; }
  log(helper ? `installing through the polkit action ${actionId}` : 'installing through pkexec /bin/sh (no installed helper and policy)');
  return new Promise(resolve => {
    let child;
    try { child = spawn('pkexec', args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, PATH: safePath(env.PATH) } }); }
    catch (error) { resolve({ outcome: 'failed', reason: 'no-pkexec', message: `pkexec could not be started: ${error.message}`, code: null }); return; }
    let stderr = '';
    child.stdout?.on('data', () => {});
    child.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
    child.once('error', error => resolve({ outcome: 'failed', reason: 'no-pkexec', message: error.code === 'ENOENT' ? 'pkexec was not found. Install polkit, or install the downloaded file with your package manager.' : `pkexec could not be started: ${error.message}`, code: null }));
    child.once('close', code => {
      const result = { ...classifyExit(code, stderr), code };
      log(`pkexec exited with ${code}: ${result.outcome}${result.message ? ` (${result.message.split('\n')[0]})` : ''}`);
      resolve(result);
    });
  });
}

/** A line the user can paste in a terminal to install the downloaded file by hand. */
export function manualCommand(type, file) {
  const quoted = `'${String(file).replace(/'/g, `'\\''`)}'`;
  return { deb: `sudo apt install ${quoted}`, rpm: `sudo dnf install ${quoted}`, pacman: `sudo pacman -U ${quoted}` }[type] ?? null;
}
