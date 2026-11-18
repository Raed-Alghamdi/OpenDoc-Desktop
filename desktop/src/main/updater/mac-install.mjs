// The macOS update without a paid certificate (plan 3.7, S6). electron-updater downloads the zip and checks its SHA-512; its own
// install step hands the zip to Squirrel.Mac, which needs a signature it can validate (ad-hoc builds fail with "code failed to satisfy
// specified code requirement(s)"). So the app unzips the new bundle next to the old one, checks it, and lets a detached helper swap the
// two after this process has exited and open the new one. No Electron import: every system call comes in through `run`.
import { execFile, spawn } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { access, mkdtemp, rm } from 'node:fs/promises';
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

/**
 * The helper: wait for the app to exit, move the old bundle aside, move the new one in (undoing the first move if the second fails),
 * open it, and delete what is left. $1 the bundle, $2 where the old one goes, $3 the new bundle, $4 the staging folder, $5 a log file,
 * $6 the app's pid.
 */
export const swapScript = `while kill -0 "$6" 2>/dev/null; do sleep 0.2; done
mv "$1" "$2" && mv "$3" "$1" || { [ -e "$2" ] && [ ! -e "$1" ] && mv "$2" "$1"; echo "swap failed" >> "$5"; exit 1; }
rm -rf "$4"
open "$1"
rm -rf "$2"
echo "swapped" >> "$5"`;

export const swapArguments = ({ bundle, old, fresh, stage, helperLog, pid }) => ['-c', swapScript, 'sh', bundle, old, fresh, stage, helperLog, String(pid)];

const defaultRun = async (command, args) => (await execFileAsync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })).stdout;
const plistKey = (run, bundle, key) => run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, join(bundle, 'Contents', 'Info.plist')]).then(text => text.trim());

/**
 * Unzip the downloaded update beside the running app, check the new bundle, and start the swap helper.
 * Resolves { info: { version, build }, helperLog }. Rejects with an error carrying `code`:
 * MOVE_TO_APPLICATIONS, NOT_WRITABLE, or none (the zip is wrong). The staging folder is removed on any failure.
 * `run(command, args)` resolves with the command's output; `start(command, args)` starts the detached helper. Both are for tests.
 */
export async function installMacUpdate({ zipFile, state, pid = process.pid, run = defaultRun, start = (command, args) => { const child = spawn(command, args, { detached: true, stdio: 'ignore' }); child.unref(); }, exists = existsSync, makeStage = prefix => mkdtemp(prefix), log = () => {}, helperLogFolder = tmpdir() }) {
  const decision = decideMacInstall(state);
  if (decision.action !== 'swap') throw Object.assign(new Error(decision.message), { code: decision.reason === 'translocated' ? 'MOVE_TO_APPLICATIONS' : 'NOT_WRITABLE' });
  const stage = await makeStage(join(state.folder, '.opendoc-desktop-update-'));
  try {
    await run('ditto', ['-xk', zipFile, stage]); // keeps signatures, symlinks and modes; sets no quarantine flag
    const fresh = join(stage, basename(state.bundle));
    if (!exists(fresh)) throw new Error(`The update zip has no ${basename(state.bundle)}.`);
    await run('codesign', ['--verify', '--deep', '--strict', fresh]);
    if ((await plistKey(run, fresh, 'CFBundleIdentifier')) !== (await plistKey(run, state.bundle, 'CFBundleIdentifier'))) throw new Error('The update has another bundle identifier.');
    const info = { version: await plistKey(run, fresh, 'CFBundleShortVersionString'), build: Number(await plistKey(run, fresh, 'CFBundleVersion')) };
    log(`the new bundle is verified: ${JSON.stringify(info)}`);
    const helperLog = join(helperLogFolder, `opendoc-update-helper-${pid}.log`);
    start('/bin/sh', swapArguments({ bundle: state.bundle, old: `${state.bundle}.old-${pid}`, fresh, stage, helperLog, pid }));
    return { info, helperLog };
  } catch (error) {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
