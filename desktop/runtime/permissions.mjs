// Write permission on the runtime folder. runtime/build.mjs leaves the runtime read-only, so a workspace that links to it cannot
// change it; the macOS signing hooks (runtime/mac-signing.mjs) open it for codesign and close it again.
import { chmodSync, lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';

export function walk(directory, visit) {
  for (const name of readdirSync(directory)) {
    const file = path.join(directory, name);
    const stat = lstatSync(file);
    visit(file, stat);
    if (stat.isDirectory()) walk(file, visit);
  }
}

// Symlinks are skipped on purpose: chmod would follow them. The runtime's only links are relative ones under node_modules/.bin.
export function setWritable(directory, writable) {
  const mode = (stat) => (writable ? stat.mode | 0o200 : stat.mode & ~0o222) & 0o7777;
  const root = lstatSync(directory);
  chmodSync(directory, mode(root));
  walk(directory, (file, stat) => {
    if (!stat.isSymbolicLink()) chmodSync(file, mode(stat));
  });
}

/** The folder and everything in it that has a write bit (symlinks aside), relative to the folder ('.' for itself). */
export function writableEntries(directory) {
  const found = [];
  if (lstatSync(directory).mode & 0o222) found.push('.');
  walk(directory, (file, stat) => {
    if (!stat.isSymbolicLink() && (stat.mode & 0o222)) found.push(path.relative(directory, file));
  });
  return found;
}
