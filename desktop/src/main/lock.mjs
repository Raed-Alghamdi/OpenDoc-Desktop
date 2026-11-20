// The workspace runtime lock, `.opendoc/update.lock`: the same file and format the CLI's withWorkspaceLock uses
// (src/cli/lock.ts), so the app and the CLI exclude each other while a workspace opens, updates or installs.
// By design a stale lock is never cleared automatically; the app offers to clear one only after confirming
// that the recorded pid is gone (contracts.md, C3).
import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { processExists } from './process-info.mjs';

export class WorkspaceLockError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    Object.assign(this, details);
  }
}

const lockFile = root => resolve(root, '.opendoc/update.lock');

function recordedPid(text) {
  try {
    const owner = JSON.parse(text);
    return Number.isSafeInteger(owner?.pid) && owner.pid > 0 && owner.pid <= 2 ** 31 - 1 ? owner.pid : null;
  } catch { return null; }
}

/**
 * Create `file` with its whole content, or fail with EEXIST when it is there: the content goes into a temporary file beside it
 * (`.update.lock.<id>.opendoc-<pid>.part`, which the next open removes if a kill leaves it) and is linked into place, so the
 * lock is never seen empty or half written (a kill between create and write would leave a lock nobody can confirm stale). A file
 * system without hard links gets the plain exclusive create.
 */
async function createWhole(file, contents) {
  const temporary = resolve(dirname(file), `.update.lock.${randomUUID()}.opendoc-${process.pid}.part`);
  await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
  try { await link(temporary, file); }
  catch (error) {
    if (!['EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(error.code)) throw error;
    const handle = await open(file, 'wx', 0o600);
    try { await handle.writeFile(contents); } finally { await handle.close(); }
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}

/** Take the lock, or throw a WorkspaceLockError: `locked` (a live owner), `stale-lock` (pid gone) or `invalid-lock`. */
export async function acquireWorkspaceLock(root) {
  const file = lockFile(root);
  await mkdir(resolve(root, '.opendoc'), { recursive: true });
  const contents = JSON.stringify({ pid: process.pid, id: randomUUID() });
  try { await createWhole(file, contents); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const text = await readFile(file, 'utf8').catch(() => '');
    const pid = recordedPid(text);
    if (pid === null) throw new WorkspaceLockError('invalid-lock', `The workspace lock ${file} is damaged, so the app cannot tell whether another OpenDoc command is running. Confirm none is, then remove the file and try again.`, { file });
    if (pid === process.pid || processExists(pid)) throw new WorkspaceLockError('locked', 'Another OpenDoc command is working in this workspace. Wait for it to finish, then try again.', { file, pid });
    throw new WorkspaceLockError('stale-lock', 'A previous OpenDoc command stopped before it released this workspace\'s lock.', { file, pid, contents: text });
  }
  return {
    async release() {
      try { if (await readFile(file, 'utf8') === contents) await rm(file, { force: true }); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    },
  };
}

/** Remove a stale lock after confirming its recorded pid is gone and the file is still the one that was reported. */
export async function clearStaleWorkspaceLock(root) {
  const file = lockFile(root);
  let text;
  try { text = await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return 'absent'; throw error; }
  const pid = recordedPid(text);
  if (pid === null) throw new WorkspaceLockError('invalid-lock', 'The lock file is damaged, so the app cannot confirm that its owner has stopped. Remove it by hand.', { file });
  if (processExists(pid)) throw new WorkspaceLockError('locked', 'The command that holds this lock is still running.', { file, pid });
  if (await readFile(file, 'utf8').catch(() => null) !== text) throw new WorkspaceLockError('locked', 'The lock changed while it was being checked. Try again.', { file });
  await rm(file, { force: true });
  return 'cleared';
}
