// The app's config.json (contracts.md, "the app's config.json keys"). Written only by the shell, read by the
// router skill and the updater. Unknown keys survive a rewrite; the file is replaced atomically with mode 0600.
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const maxRecentWorkspaces = 10;

export function createConfig(file) {
  let queue = Promise.resolve();

  async function read() {
    let text;
    try { text = await readFile(file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
    try {
      const value = JSON.parse(text);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch { /* Fall through: a damaged file is moved aside below. */ }
    await rename(file, `${file}.damaged-${Date.now()}`).catch(() => {});
    return {};
  }

  async function write(value) {
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
  }

  /** Apply a change (an object to merge, or a function from the current value to the next) one at a time. */
  function update(change) {
    const run = queue.then(async () => {
      const current = await read();
      const next = typeof change === 'function' ? change({ ...current }) : { ...current, ...change };
      await write(next);
      return next;
    });
    queue = run.catch(() => {});
    return run;
  }

  return { file, read: () => queue.then(read), update };
}

/** The recent list after opening `path`: newest first, no duplicates, at most ten. */
export function withRecentWorkspace(recent, path) {
  const list = Array.isArray(recent) ? recent.filter(item => typeof item === 'string' && item !== path) : [];
  return [path, ...list].slice(0, maxRecentWorkspaces);
}

/** Record a workspace the user opened: it becomes the default and heads the recent list. */
export function rememberWorkspace(config, path) {
  return config.update(current => ({ ...current, defaultWorkspace: path, recentWorkspaces: withRecentWorkspace(current.recentWorkspaces, path) }));
}

/** Drop a workspace from the recent list (and from the default when it was the default). */
export function forgetWorkspace(config, path) {
  return config.update(current => {
    const next = { ...current, recentWorkspaces: (Array.isArray(current.recentWorkspaces) ? current.recentWorkspaces : []).filter(item => item !== path) };
    if (next.defaultWorkspace === path) delete next.defaultWorkspace;
    return next;
  });
}

/** The checkbox "Upgrade my workspaces without asking from now on" (contracts: `upgradeWithoutAsking`, a boolean). */
export const upgradesWithoutAsking = async config => (await config.read()).upgradeWithoutAsking === true;
export const setUpgradeWithoutAsking = (config, value) => config.update({ upgradeWithoutAsking: Boolean(value) });

/** The first-run "Connect your AI apps" screen (contracts: `aiAppsOffered`, a boolean). Absent means it has not been shown. */
export const aiAppsOffered = async config => (await config.read()).aiAppsOffered === true;
export const markAiAppsOffered = config => config.update({ aiAppsOffered: true });
