import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { projectRoot } from './helpers';

const run = promisify(execFile);

/**
 * The desktop app's runtime has the layout `<runtime>/node_modules/opendoc`, with `build-info.json` beside
 * `node_modules` (contracts, "Version numbers"), not inside the package. This makes a light stand-in: a real copy of the
 * package's code (a link would resolve back to the checkout) and links to the checkout's dependencies.
 */
async function runtimeLike(t: TestContext, buildInfo?: unknown) {
  const directory = await realpath(await mkdtemp(resolve(tmpdir(), 'opendoc-build-info-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const nodeModules = resolve(directory, 'node_modules'), opendoc = resolve(nodeModules, 'opendoc');
  await mkdir(opendoc, { recursive: true });
  for (const entry of ['src', 'bin', 'package.json']) await cp(resolve(projectRoot, entry), resolve(opendoc, entry), { recursive: true });
  for (const entry of await readdir(resolve(projectRoot, 'node_modules'))) if (entry !== '.bin' && entry !== 'opendoc') await symlink(resolve(projectRoot, 'node_modules', entry), resolve(nodeModules, entry));
  if (buildInfo !== undefined) await writeFile(resolve(directory, 'build-info.json'), JSON.stringify(buildInfo));
  return resolve(opendoc, 'bin/opendoc.mjs');
}

/** `--version --json` run from the runtime's own bin, with no workspace around it. */
async function versionJson(cli: string, ...extra: string[]) {
  const { stdout } = await run(process.execPath, [cli, '--version', '--json', ...extra], { cwd: tmpdir(), timeout: 120_000 });
  return JSON.parse(stdout);
}

test('--version --json under the desktop runtime reports the build written beside the runtime', async t => {
  const info = { build: 3, commit: 'abc1234', builtAt: '2026-11-20T00:00:00.000Z' };
  const result = await versionJson(await runtimeLike(t, { ...info, extra: 'dropped' }));
  assert.deepEqual(result, { version: result.version, build: info });
  assert.match(result.version, /^\d+\.\d+\.\d+$/);
});

test('--version --json prints only the version where there is no build-info.json', async t => {
  // The same layout without the file, as an npm install under some node_modules folder has it.
  assert.deepEqual(Object.keys(await versionJson(await runtimeLike(t))), ['version']);
});
