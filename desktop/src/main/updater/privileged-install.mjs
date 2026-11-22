// Installing a downloaded deb, rpm or pacman file with the system's password. No Electron import.
//
// electron-updater's own install runs `pkexec ... dpkg -i` with spawnSync, which freezes every window while the password prompt is
// open, and after Cancel it opens a second prompt for `apt-get install -f -y`. This does it with one asynchronous pkexec call that
// runs one script: Cancel ends it, and the app stays responsive.
//
// The script runs as root, so it does not trust the downloaded file where it lies (the user's cache): it copies the file and its
// signature (<file>.sig, a raw Ed25519 signature the release publishes) into a root-owned folder, checks the SHA-512 from the release
// metadata on the copy, verifies the signature with the release public key (release-key.pem, shipped with the app), and installs the
// copy. The SHA-512 comes from the same feed as the file; only the signature proves the release's own key made it.
//
// Two ways to run that script. The packaged app's own install (deb, rpm, pacman) ships it as a root-owned helper,
// <resources>/updater/install-update, with a polkit action that names it (resources/polkit), and runs `pkexec <helper> <args>`: the
// password prompt then shows the action's sentence, and the helper reads the public key from its own folder. Anything else (an older
// install without the helper, an unpackaged run) keeps the original call, `pkexec /bin/sh -c <script>`, whose prompt shows the whole
// script (the public key text included, which the app read from its own resources) but works without any installed file.
import { spawn as nodeSpawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { basename, delimiter, extname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The polkit action the packages install, and the file that defines it. */
export const actionId = 'io.github.ryanyahya.opendocdesktop.install-update';
export const policyFile = `/usr/share/polkit-1/actions/${actionId}.policy`;
/** Where the helper sits inside the app's resources folder (the packages install the app under /opt/opendoc-desktop). */
export const helperRelativePath = join('updater', 'install-update');
/** The release public key (Ed25519, SPKI PEM), beside the helper in the packaged app and in the source tree under resources/. */
export const keyRelativePath = join('updater', 'release-key.pem');
const sourceKeyFile = fileURLToPath(new URL('../../../resources/updater/release-key.pem', import.meta.url));

export const installCommands = {
  deb: 'dpkg -i "$pkg" || apt-get install -f -y',
  rpm: `if command -v zypper >/dev/null 2>&1; then zypper --non-interactive --no-refresh install --allow-unsigned-rpm -f "$pkg"
  elif command -v dnf >/dev/null 2>&1; then dnf install --nogpgcheck -y "$pkg"
  elif command -v yum >/dev/null 2>&1; then yum install --nogpgcheck -y "$pkg"
  else rpm -Uvh --replacepkgs --replacefiles --nodeps "$pkg"; fi`,
  pacman: 'pacman -U --noconfirm "$pkg"',
};

/** Exit codes of the script: the copy does not match the checksum; the signature is not the release key's; openssl is missing. */
export const checksumExitCode = 70;
export const signatureExitCode = 71;
export const opensslExitCode = 72;

/** A public key text that is safe to write into the script: one SPKI PEM block, base64 lines only (no quote or other character the shell reads). */
const pemPattern = /^-----BEGIN PUBLIC KEY-----\n(?:[A-Za-z0-9+/]{1,76}={0,2}\n)+-----END PUBLIC KEY-----\n?$/;

/**
 * The script for one package type. Arguments: $1 the file, $2 its SHA-512 in hex, $3 the file extension, $4 the signature file.
 * `publicKey` is the release public key text, read by the app from its own resources; the script writes it into its root-owned
 * temporary folder itself, so no value the user controls reaches the key (it is checked to be plain PEM before it is embedded).
 * The install step's own 126 and 127 (a tool that is missing) become 1, so they are never taken for pkexec's "dismissed".
 */
export function installScript(type, publicKey) {
  const command = installCommands[type];
  if (!command) throw new Error(`No installer for ${type}.`);
  if (typeof publicKey !== 'string' || !pemPattern.test(publicKey)) throw new Error('The release public key is not in the expected form.');
  return `set -u
tmp=$(mktemp -d) || exit 1
trap 'rm -rf "$tmp"' EXIT
pkg="$tmp/update.$3"
cp -- "$1" "$pkg" || exit 1
cp -- "$4" "$tmp/update.sig" || exit 1
printf '%s  %s\\n' "$2" "$pkg" | sha512sum -c - >/dev/null 2>&1 || { echo 'opendoc-desktop: the update file does not match its checksum' >&2; exit ${checksumExitCode}; }
key="$tmp/release-key.pem"
printf '%s\\n' '${publicKey.trimEnd()}' > "$key" || exit 1
command -v openssl >/dev/null 2>&1 || { echo 'opendoc-desktop: openssl is needed to check the update signature and is not installed' >&2; exit ${opensslExitCode}; }
openssl pkeyutl -verify -pubin -inkey "$key" -rawin -in "$pkg" -sigfile "$tmp/update.sig" >/dev/null 2>&1 || { echo 'opendoc-desktop: the update file is not signed with the opendoc-desktop release key' >&2; exit ${signatureExitCode}; }
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
 * The release public key text the fallback script embeds: from the app's own resources folder when there is one (the packaged app),
 * else from the source tree (an unpackaged run, tests). Throws when it cannot be read or is not a plain PEM key.
 */
export async function readReleaseKey({ resourcesPath = process.resourcesPath, readText = path => readFile(path, 'utf8') } = {}) {
  const inResources = resourcesPath && isAbsolute(resourcesPath) ? join(resourcesPath, keyRelativePath) : null;
  let text;
  try { text = await readText(inResources ?? sourceKeyFile); }
  catch { throw new Error('The release public key that checks the update signature could not be read.'); }
  if (!pemPattern.test(text)) throw new Error('The release public key is not in the expected form.');
  return text;
}

/**
 * The arguments for pkexec. --disable-internal-agent: without a graphical agent pkexec fails instead of asking in a terminal.
 * With `helper` (the installed helper's path) pkexec runs that file, which reads the public key from its own folder; without, it
 * runs the script through /bin/sh -c, and `publicKey` (the key text, see readReleaseKey) goes into that script.
 * `signature` is the downloaded <file>.sig.
 */
export function pkexecArguments({ type, file, sha512, signature, helper = null, publicKey }) {
  const hex = sha512Hex(sha512);
  if (!hex) throw new Error('The release has no usable SHA-512 for this file.');
  if (!isAbsolute(file)) throw new Error('The downloaded file has no absolute path.');
  if (typeof signature !== 'string' || !isAbsolute(signature) || !signature.endsWith('.sig')) throw new Error('The downloaded update has no signature file.');
  const extension = extname(basename(file)).slice(1) || type;
  if (helper) {
    if (!installCommands[type]) throw new Error(`No installer for ${type}.`);
    return ['--disable-internal-agent', helper, file, hex, extension, signature];
  }
  return ['--disable-internal-agent', '/bin/sh', '-c', installScript(type, publicKey), 'opendoc-desktop-update', file, hex, extension, signature];
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
  if (code === signatureExitCode) return { outcome: 'failed', reason: 'signature', message: 'The downloaded update is not signed with the OpenDoc Desktop release key, so nothing was installed. Download the update again from the release page.' };
  if (code === opensslExitCode) return { outcome: 'failed', reason: 'no-openssl', message: 'openssl is needed to check the update signature and is not installed, so nothing was installed. Install openssl and try again, or download the update from the release page.' };
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
export async function installPackage({ type, file, sha512, signature, spawn = nodeSpawn, env = process.env, log = () => {}, helper, publicKey }) {
  // `helper` is for tests: a path (use it as found), null (use the fallback), or left out (look for the installed one).
  if (helper === undefined) helper = await findHelper();
  let args;
  try {
    if (!helper && publicKey === undefined) publicKey = await readReleaseKey();
    args = pkexecArguments({ type, file, sha512, signature, helper, publicKey });
  } catch (error) { return { outcome: 'failed', reason: 'input', message: error.message, code: null }; }
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
