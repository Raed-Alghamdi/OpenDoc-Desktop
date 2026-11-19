// The `opendoc` command for agents (plan 3.5), without Electron so the unit tests can run it:
//   Linux packages  ship /usr/bin/opendoc (resources/cli/opendoc); nothing here.
//   AppImage        the app writes ~/.local/bin/opendoc (resources/cli/opendoc-appimage.sh with the AppImage's path filled in)
//                   at every launch, so the command follows the file when it moves.
//   macOS           the "Install Command-Line Tool" menu item writes a small launcher into /usr/local/bin or ~/.local/bin.
// Every write is atomic (a temp file in the same folder, then a rename), and a file that is not ours is never replaced.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';

/** Words that mark a launcher as this app's. A file without them is somebody else's and is left alone. */
export const shimMarker = 'opendoc-desktop agent command';
export const commandName = 'opendoc';

/** `'it'\''s'`: a value that is safe inside a shell script, whatever it contains. */
export function shellQuote(value) {
  if (/[\0\n\r]/.test(value)) throw new Error('A path with a line break cannot be written into the command.');
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellUnquote(text) {
  let out = '';
  const pattern = /'([^']*)'|\\(.)/gy;
  let match;
  while ((match = pattern.exec(text)) !== null) out += match[1] ?? match[2];
  return out;
}

/** Fill the AppImage launcher template (`APPIMAGE=@APPIMAGE@`) with the AppImage's path. */
export function renderAppImageShim(template, appImage) {
  if (!template.includes('@APPIMAGE@')) throw new Error('The AppImage command template has no @APPIMAGE@ placeholder.');
  return template.replace('@APPIMAGE@', () => shellQuote(appImage));
}

/** The AppImage path a launcher of ours points at, or null. */
export function readShimTarget(content) {
  const match = content.match(/^APPIMAGE=((?:'[^']*'|\\.)+)$/m);
  return match ? shellUnquote(match[1]) : null;
}

/** The macOS launcher: the app's executable as Node on the app's runtime, with a message when the app has moved. */
export function renderMacShim({ executable, runtime }) {
  return `#!/bin/sh
# ${shimMarker} (macOS). Written by the app's "Install Command-Line Tool" menu item.
APP=${shellQuote(executable)}
RUNTIME=${shellQuote(runtime)}
CLI="$RUNTIME/node_modules/opendoc/bin/opendoc.mjs"
if [ ! -x "$APP" ] || [ ! -f "$CLI" ]; then
  echo "opendoc: the opendoc-desktop app is no longer at $APP. Open the app and choose Install Command-Line Tool again." >&2
  exit 127
fi
ELECTRON_RUN_AS_NODE=1 exec "$APP" "$CLI" "$@"
`;
}

/** The app's executable for macOS, read back from a launcher of ours. */
export function readMacShimTarget(content) {
  const match = content.match(/^APP=((?:'[^']*'|\\.)+)$/m);
  return match ? shellUnquote(match[1]) : null;
}

/**
 * Write `content` to `file` as an executable, atomically.
 * Resolves { action, path } where action is 'created', 'updated' (content changed) or 'unchanged'; or
 * { action: 'foreign' } when something that is not ours is there (a symlink, or a file without the marker).
 */
export async function writeShim({ file, content }) {
  const folder = dirname(file);
  await mkdir(folder, { recursive: true, mode: 0o755 });
  let previous = null;
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) return { action: 'foreign', path: file };
    previous = await readFile(file, 'utf8');
    if (!previous.includes(shimMarker)) return { action: 'foreign', path: file };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (previous === content) {
    await chmod(file, 0o755);
    return { action: 'unchanged', path: file };
  }
  const temporary = join(folder, `.${commandName}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    await writeFile(temporary, content, { mode: 0o755 });
    await chmod(temporary, 0o755);
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return { action: previous === null ? 'created' : 'updated', path: file, previous };
}

/** ~/.local/bin, or where XDG would put user executables (the spec fixes it at ~/.local/bin). */
export const userBinDirectory = home => join(home, '.local', 'bin');

/** Install the AppImage command for the AppImage at `appImage`. `template` is the text of opendoc-appimage.sh. */
export async function installAppImageShim({ template, appImage, home }) {
  const file = join(userBinDirectory(home), commandName);
  const content = renderAppImageShim(template, resolve(appImage));
  const result = await writeShim({ file, content });
  const before = result.previous ? readShimTarget(result.previous) : null;
  return { ...result, repointed: Boolean(before) && before !== resolve(appImage) };
}

// ---------- the PATH check ----------

/** Is `directory` one of the entries of `pathValue`? Compared as resolved paths, and through symlinks when they exist. */
export async function directoryOnPath(directory, pathValue) {
  const wanted = resolve(directory);
  let wantedReal = wanted;
  try { wantedReal = await realpath(wanted); } catch { /* not there yet */ }
  for (const entry of String(pathValue ?? '').split(delimiter)) {
    if (!entry || !entry.startsWith('/')) continue;
    const candidate = resolve(entry);
    if (candidate === wanted) return true;
    try { if (await realpath(candidate) === wantedReal) return true; } catch { /* a PATH entry that does not exist */ }
  }
  return false;
}

const pathStart = '__OPENDOC_PATH_START__';
const pathEnd = '__OPENDOC_PATH_END__';

/** Ask a shell what its PATH is. `mode` is '-l' (login) or '-i' (interactive). Resolves the PATH text, or null. */
export function shellPath({ shell, mode, env = process.env, timeout = 10_000 }) {
  return new Promise(accept => {
    let output = '';
    let settled = false;
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); accept(value); } };
    let child;
    try {
      // The markers survive greetings and banners that rc files print.
      child = spawn(shell, [mode, '-c', `printf '%s%s%s' '${pathStart}' "$PATH" '${pathEnd}'`], { env, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { return accept(null); }
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(null); }, timeout);
    child.stdout.on('data', chunk => { output += chunk; });
    child.once('error', () => finish(null));
    child.once('close', () => {
      const start = output.indexOf(pathStart);
      const end = output.indexOf(pathEnd, start);
      finish(start >= 0 && end > start ? output.slice(start + pathStart.length, end) : null);
    });
  });
}

/**
 * Is `directory` on the PATH a terminal would have? True when the app's own PATH has it, or when the user's shell
 * shows it as a login shell or as an interactive one (terminals differ in which of the two they start).
 * @returns {Promise<{ onPath: boolean, shell: string|null, checked: boolean }>} checked is false when no shell answered.
 */
export async function commandOnPath({ directory, env = process.env, shell = env.SHELL || '/bin/sh', timeout }) {
  if (await directoryOnPath(directory, env.PATH)) return { onPath: true, shell, checked: true };
  const answers = await Promise.all(['-l', '-i'].map(mode => shellPath({ shell, mode, env, timeout })));
  let checked = false;
  for (const value of answers) {
    if (value === null) continue;
    checked = true;
    if (await directoryOnPath(directory, value)) return { onPath: true, shell, checked: true };
  }
  return { onPath: false, shell, checked };
}

/** What to tell the user when the command's folder is not on the PATH. */
export function pathNotice({ directory, home, shell }) {
  const shown = directory.startsWith(`${home}/`) ? `~${directory.slice(home.length)}` : directory;
  const name = String(shell ?? '').split('/').pop();
  const line = name === 'fish' ? `fish_add_path ${shown}` : `export PATH="${directory.startsWith(`${home}/`) ? `$HOME${directory.slice(home.length)}` : directory}:$PATH"`;
  const file = { fish: 'your fish config', zsh: '~/.zshrc', bash: '~/.bashrc' }[name] ?? 'your shell profile';
  return {
    message: `The opendoc command is installed in ${shown}, which is not on your PATH.`,
    detail: `Agents and terminals will not find "opendoc" until it is. Add this line to ${file}, then open a new terminal:\n\n${line}`,
  };
}

// ---------- macOS ----------

/** The app was started from a quarantined download: macOS runs it from a random read-only copy. */
export const translocated = executable => executable.includes('/AppTranslocation/');

/**
 * Where the macOS command can go without administrator rights: /usr/local/bin when it exists and is writable,
 * else ~/.local/bin (made if needed). `null` when neither works.
 */
export async function macInstallFolder({ home, candidates = ['/usr/local/bin'] }) {
  for (const folder of candidates) {
    try { await access(folder, constants.W_OK); return folder; } catch { /* not writable */ }
  }
  const own = userBinDirectory(home);
  try {
    await mkdir(own, { recursive: true });
    await access(own, constants.W_OK);
    return own;
  } catch { return null; }
}

/**
 * Install the macOS command. Resolves { ok: true, path, action } or { ok: false, reason, message }.
 * `reason`: 'translocated', 'no-folder' or 'foreign' (another opendoc is in the way).
 */
export async function installMacCommand({ executable, runtime, home, candidates }) {
  if (translocated(executable)) {
    return { ok: false, reason: 'translocated', message: 'The app is running from a temporary location. Move opendoc-desktop to your Applications folder, open it from there, and choose Install Command-Line Tool again.' };
  }
  // A command of ours already in a candidate folder is refreshed in place, wherever it is.
  const folders = [...(candidates ?? ['/usr/local/bin']), userBinDirectory(home)];
  let folder = null;
  for (const candidate of folders) {
    try {
      if ((await readFile(join(candidate, commandName), 'utf8')).includes(shimMarker)) { await access(candidate, constants.W_OK); folder = candidate; break; }
    } catch { /* no command of ours there */ }
  }
  folder ??= await macInstallFolder({ home, candidates });
  if (!folder) {
    return { ok: false, reason: 'no-folder', message: `No folder for the command can be written without an administrator password. Create ${userBinDirectory(home)} (or make /usr/local/bin writable) and try again.` };
  }
  const result = await writeShim({ file: join(folder, commandName), content: renderMacShim({ executable, runtime }) });
  if (result.action === 'foreign') {
    return { ok: false, reason: 'foreign', message: `${result.path} already exists and is not the opendoc-desktop command, so it was left alone. Remove it or rename it, then try again.` };
  }
  return { ok: true, path: result.path, folder, action: result.action };
}

/** On launch, point an installed macOS command at the app's current place. Does nothing when none was installed. */
export async function refreshMacCommand({ executable, runtime, home, candidates }) {
  if (translocated(executable)) return { action: 'none' };
  for (const folder of [...(candidates ?? ['/usr/local/bin']), userBinDirectory(home)]) {
    const file = join(folder, commandName);
    let content;
    try { content = await readFile(file, 'utf8'); } catch { continue; }
    if (!content.includes(shimMarker)) continue;
    return writeShim({ file, content: renderMacShim({ executable, runtime }) });
  }
  return { action: 'none' };
}
