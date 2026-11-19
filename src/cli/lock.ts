import { link, mkdir, open, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Create the lock with its content already in it: write a temporary file beside it and hard-link that to the lock name (EEXIST
 * means taken, as with an exclusive create). A kill can then never leave an empty lock nobody can confirm stale. The desktop app
 * takes the same lock the same way. A file system without hard links gets the plain exclusive create.
 */
async function createWhole(file: string, contents: string) {
  const temporary = resolve(dirname(file), `.update.lock.${randomUUID()}.opendoc-${process.pid}.part`);
  await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
  try { await link(temporary, file); }
  catch (error) {
    if (!['EPERM', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    const handle = await open(file, 'wx', 0o600);
    try { await handle.writeFile(contents); } finally { await handle.close(); }
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}

/** Startup, update activation, and Headless commands share the workspace runtime lock. */
export async function withWorkspaceLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  const file = resolve(root, '.opendoc/update.lock');
  await mkdir(resolve(root, '.opendoc'), { recursive: true });
  const contents = JSON.stringify({ pid: process.pid, id: randomUUID() });
  try {
    await createWhole(file, contents);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const recovery = `Confirm no OpenDoc command is running, then remove ${file} and retry.`;
    let owner: { pid?: number };
    try { owner = JSON.parse(await readFile(file, 'utf8')); } catch { throw new Error(`OpenDoc has an incomplete workspace runtime lock. ${recovery}`); }
    if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid! <= 0 || owner.pid! > 2 ** 31 - 1) throw new Error(`Invalid OpenDoc workspace runtime lock. ${recovery}`);
    try { process.kill(owner.pid!, 0); }
    catch (ownerError) {
      if ((ownerError as NodeJS.ErrnoException).code !== 'ESRCH') throw ownerError;
      // Stat-then-unlink recovery could delete a new contender's lock. Leave stale locks intact.
      throw new Error(`The previous OpenDoc command stopped before releasing its lock. ${recovery}`);
    }
    throw new Error('Another OpenDoc command is in progress. Wait for it to finish, then retry.');
  }
  try { return await action(); }
  finally {
    try { if (await readFile(file, 'utf8') === contents) await unlink(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`OpenDoc could not remove its workspace runtime lock after the operation: ${error instanceof Error ? error.message : String(error)}. Confirm no OpenDoc command is running, then remove ${file} and retry.`);
    }
  }
}
