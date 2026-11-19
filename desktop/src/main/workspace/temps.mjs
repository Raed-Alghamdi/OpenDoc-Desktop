// Temporary files the app leaves beside a workspace's files while it replaces one atomically (a link, the pin, the marker, the
// restore journal) are named `.<name>.opendoc-<pid>.part` (`package.json.opendoc-<pid>.part`). `.part` is on the default exclude
// lists of the sync clients, so they are not uploaded. A crash can leave one behind; the next open removes those whose process is gone.
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { processExists } from '../process-info.mjs';

const pattern = /\.opendoc-(\d+)\.part$/;

/** Remove leftover temporary files in the workspace folder, `.claude` and `.opendoc` (one level each). Returns the names removed. */
export async function cleanStaleTemps(root, exists = processExists) {
  const removed = [];
  for (const folder of [root, join(root, '.claude'), join(root, '.opendoc')]) {
    for (const name of await readdir(folder).catch(() => [])) {
      const match = pattern.exec(name);
      if (!match || exists(Number(match[1]))) continue;
      await rm(join(folder, name), { recursive: true, force: true }).catch(() => {});
      removed.push(join(folder, name));
    }
  }
  return removed;
}
