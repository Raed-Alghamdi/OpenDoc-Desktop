import { relative } from 'node:path';
import type { FSWatcher } from 'chokidar';

/**
 * Paths the service watcher ignores. Generated state, dependencies, exports, and each
 * document's `.history` folder must never trigger discovery or rendering.
 */
export function ignoredByWatcher(applicationRoot: string, root: string, path: string) {
  const installed = relative(applicationRoot, path);
  const rel = installed === '' || (!installed.startsWith('../') && installed !== '..') ? installed : relative(root, path);
  return /(^|[/\\])(node_modules|\.git|\.opendoc|\.history|output|tmp|dist|tests)([/\\]|$)/.test(rel) || /\.forme-render-|\.tmp$/.test(rel);
}

/** Opens a watcher and waits until it has attached to everything that exists now. A failed start closes it. */
export async function readyWatcher(open: () => FSWatcher): Promise<FSWatcher> {
  const watcher = open();
  try { await new Promise<void>((accept, reject) => { watcher.once('ready', accept); watcher.once('error', reject); }); }
  catch (error) { await watcher.close(); throw error; }
  return watcher;
}
