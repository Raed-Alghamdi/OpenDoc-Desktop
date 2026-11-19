import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cliPath, nodeModeEnvironment, readBuildInfo, runtimeLocation } from '../../../src/main/runtime.mjs';

test('the runtime is where the override says, else in the resources, else in the dev build folder', () => {
  assert.equal(runtimeLocation({ env: { OPENDOC_DESKTOP_RUNTIME: '/x/rt' }, packaged: true, resourcesPath: '/r', developmentRoot: '/d' }), '/x/rt');
  assert.equal(runtimeLocation({ env: {}, packaged: true, resourcesPath: '/r', developmentRoot: '/d' }), '/r/runtime');
  assert.equal(runtimeLocation({ env: {}, packaged: false, resourcesPath: '/r', developmentRoot: '/d', platform: 'linux', arch: 'x64' }), '/d/build/runtime/linux-x64');
  assert.equal(cliPath('/r/runtime'), '/r/runtime/node_modules/opendoc/bin/opendoc.mjs');
});

test('build-info.json gives the build number; a missing or odd file gives null', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'opendoc-runtime-'));
  assert.equal(await readBuildInfo(dir), null);
  await writeFile(join(dir, 'build-info.json'), JSON.stringify({ build: 4, commit: 'abc', builtAt: '2026-01-01' }));
  assert.deepEqual(await readBuildInfo(dir), { build: 4, commit: 'abc', builtAt: '2026-01-01' });
  await writeFile(join(dir, 'build-info.json'), JSON.stringify({ build: 'four' }));
  assert.equal(await readBuildInfo(dir), null);
});

test('a child that runs this executable as Node never inherits ELECTRON_FORCE_IS_PACKAGED', () => {
  const env = nodeModeEnvironment({ A: '1' }, { ELECTRON_FORCE_IS_PACKAGED: 'true', ELECTRON_RUN_AS_NODE: '', PATH: '/bin' });
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal('ELECTRON_FORCE_IS_PACKAGED' in env, false);
  assert.equal(env.A, '1');
});
