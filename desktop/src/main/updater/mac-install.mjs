// The macOS update without a paid certificate. electron-updater downloads the zip and checks its SHA-512; its own
// install step hands the zip to Squirrel.Mac, which needs a signature it can validate (ad-hoc builds fail with "code failed to satisfy
// specified code requirement(s)"). So the app unzips the new bundle next to the old one, checks it, and lets a detached helper swap the
// two after this process has exited and open the new one. No Electron import: every system call comes in through `run`.
import { execFile, spawn } from 'node:child_process';
import { constants, readdirSync } from 'node:fs';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Where the running bundle is and what is known about it. `execPath` is <name>.app/Contents/MacOS/<name>. */
export async function macBundleState({ execPath = process.execPath, canWrite = path => access(path, constants.W_OK).then(() => true, () => false), quarantine = async () => null } = {}) {
  const bundle = resolve(execPath, '..', '..', '..');
  const folder = dirname(bundle);
  return {
    execPath,
    bundle,
    folder,
    translocated: execPath.includes('/AppTranslocation/'),
    writable: (await canWrite(folder)) && (await canWrite(bundle)),
    quarantine: await quarantine(bundle),
  };
}

/**
 * Can this bundle replace itself where it stands? A translocated app (Gatekeeper runs a quarantined app from a read-only copy) cannot,
 * and neither can one in a folder the user may not write to. Then the app shows a notice with a download button instead.
 */
export function decideMacInstall(state) {
  if (state.translocated) return { action: 'notice', reason: 'translocated', message: 'opendoc-desktop is running from a temporary read-only copy that macOS makes for apps opened from Downloads. Move it to your Applications folder, open it from there, and it can update itself.' };
  if (!state.writable) return { action: 'notice', reason: 'not-writable', message: `opendoc-desktop cannot replace itself in ${state.folder}, because you cannot write to that folder. Download the new version and replace the app by hand.` };
  return { action: 'swap' };
}

/** How long the helper waits for the app to exit, in 0.2 second steps (60 seconds). Then it gives up without swapping. */
export const waitSteps = 300;

/**
 * The helper: wait for the app to exit (at most $7 steps of 0.2 s, then give up and swap nothing), move the old bundle aside, move the
 * new one in (undoing the first move if the second fails), open it, and delete what is left. $1 the bundle, $2 where the old one goes,
 * $3 the new bundle, $4 the staging folder, $5 a log file, $6 the app's pid, $7 the wait limit in steps.
 */
export const swapScript = `waited=0
while kill -0 "$6" 2>/dev/null; do
  waited=$((waited + 1))
  if [ "$waited" -gt "\${7:-300}" ]; then echo "$(date '+%Y-%m-%d %H:%M:%S') gave up: the app (pid $6) did not quit in time, nothing was swapped" >> "$5"; rm -rf "$4"; exit 1; fi
  sleep 0.2
done
mv "$1" "$2" && mv "$3" "$1" || { [ -e "$2" ] && [ ! -e "$1" ] && mv "$2" "$1"; echo "swap failed" >> "$5"; exit 1; }
rm -rf "$4"
open "$1"
rm -rf "$2"
echo "swapped" >> "$5"`;

export const swapArguments = ({ bundle, old, fresh, stage, helperLog, pid, steps = waitSteps }) => ['-c', swapScript, 'sh', bundle, old, fresh, stage, helperLog, String(pid), String(steps)];

/** Start the detached helper. Resolves once it is running, rejects when the shell could not be started (the app must then not quit). */
export function startHelper(command, args) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); accept(); });
  });
}

/** A version without its build metadata (1.2.3+4 is 1.2.3): the part that is compared. */
const bare = version => String(version).replace(/\+.*$/, '');

/**
 * What the swap helper wrote last time, as lines, and removes those files. The helper runs after the app has quit, so this is how the
 * next launch learns that it gave up or failed. `folder` and `fs` are for tests.
 */
export async function readHelperLogs({ folder = tmpdir(), fs = { readdir, readFile, rm } } = {}) {
  const lines = [];
  for (const name of (await fs.readdir(folder).catch(() => [])).filter(entry => /^opendoc-update-helper-\d+\.log$/.test(entry))) {
    const file = join(folder, name);
    const text = await fs.readFile(file, 'utf8').catch(() => '');
    lines.push(...text.split('\n').map(line => line.trim()).filter(Boolean));
    await fs.rm(file, { force: true }).catch(() => {});
  }
  return lines;
}

const defaultRun = async (command, args) => (await execFileAsync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })).stdout;
const plistKey = (run, bundle, key) => run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, join(bundle, 'Contents', 'Info.plist')]).then(text => text.trim());

/**
 * Unzip the downloaded update beside the running app, check the new bundle, and start the swap helper. The new bundle is the one in the
 * zip with the running app's bundle identifier (whatever its file name; it is installed under the running bundle's name), it must pass
 * codesign, and its version and build must be the ones the release announced (`expected`: { version, build }, the build may be null).
 * Resolves { info: { version, build }, helperLog }. Rejects with an error carrying `code`:
 * MOVE_TO_APPLICATIONS, NOT_WRITABLE, or none (the zip is wrong). The staging folder is removed on any failure.
 * `run(command, args)` resolves with the command's output; `start(command, args)` resolves once the detached helper has started (and
 * rejects when it could not start); `list(folder)` names a folder's entries. All three are for tests.
 */
export async function installMacUpdate({ zipFile, state, expected = null, pid = process.pid, run = defaultRun, start = startHelper, list = folder => readdirSync(folder), makeStage = prefix => mkdtemp(prefix), log = () => {}, helperLogFolder = tmpdir() }) {
  const decision = decideMacInstall(state);
  if (decision.action !== 'swap') throw Object.assign(new Error(decision.message), { code: decision.reason === 'translocated' ? 'MOVE_TO_APPLICATIONS' : 'NOT_WRITABLE' });
  const stage = await makeStage(join(state.folder, '.opendoc-desktop-update-'));
  try {
    await run('ditto', ['-xk', zipFile, stage]); // keeps signatures, symlinks and modes; sets no quarantine flag
    const apps = list(stage).filter(name => name.endsWith('.app'));
    if (!apps.length) throw new Error('The update zip holds no app.');
    let fresh = null;
    let ownId = null;
    for (const name of apps) {
      const candidate = join(stage, name);
      const id = await plistKey(run, candidate, 'CFBundleIdentifier');
      ownId ??= await plistKey(run, state.bundle, 'CFBundleIdentifier');
      if (id === ownId) { fresh = candidate; break; }
    }
    if (!fresh) throw new Error('The update has another bundle identifier.');
    await run('codesign', ['--verify', '--deep', '--strict', fresh]);
    const info = { version: await plistKey(run, fresh, 'CFBundleShortVersionString'), build: Number(await plistKey(run, fresh, 'CFBundleVersion')) };
    if (expected && (bare(info.version) !== bare(expected.version) || (expected.build != null && info.build !== expected.build))) {
      throw new Error(`The update is version ${info.version}, build ${info.build}, but the release announced ${expected.version}${expected.build != null ? `, build ${expected.build}` : ''}, so it was not installed.`);
    }
    log(`the new bundle is verified: ${JSON.stringify(info)}${basename(fresh) !== basename(state.bundle) ? ` (it is called ${basename(fresh)} in the zip and is installed as ${basename(state.bundle)})` : ''}`);
    const helperLog = join(helperLogFolder, `opendoc-update-helper-${pid}.log`);
    await start('/bin/sh', swapArguments({ bundle: state.bundle, old: `${state.bundle}.old-${pid}`, fresh, stage, helperLog, pid }));
    return { info, helperLog };
  } catch (error) {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
