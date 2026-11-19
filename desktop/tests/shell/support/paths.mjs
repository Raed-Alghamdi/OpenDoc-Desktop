import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const repo = resolve(here, '../../../..');
export const desktopDir = join(repo, 'desktop');
export const mainEntry = join(desktopDir, 'src/main/index.mjs');
// The package's main export is the path of the real binary (not the .bin wrapper); process checks match on it.
export const electronExecutable = realpathSync(createRequire(join(desktopDir, 'package.json'))('electron'));
// Everything the tests build (tarball, runtime, template workspace, copies) lives here; the repository ignores tmp/.
export const cache = process.env.OPENDOC_SHELL_TEST_CACHE ?? join(repo, 'tmp', 'shell-tests');
export const runtimeDir = join(cache, 'runtime');
export const goldenWorkspace = join(cache, 'golden');
export const workDir = join(cache, 'work');
// A linux-unpacked layout (the app's executable, resources/runtime, resources/cli) the agent command is tested against:
// the Electron of this worktree with the test runtime, or a copy of a real build named by OPENDOC_SHELL_TEST_UNPACKED.
export const unpackedDir = join(cache, 'unpacked');
export const unpackedExecutable = join(unpackedDir, 'opendoc-desktop');
export const cliResources = join(desktopDir, 'resources', 'cli');
