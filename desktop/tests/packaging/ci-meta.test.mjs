// desktop/runtime/ci-meta.mjs, the check that keeps a mislabelled release from being built: the tag, the app version and the build
// number must agree (a tag pushed by hand, or the one upstream-watch.yml names for a release).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const version = JSON.parse(readFileSync(path.join(desktop, 'package.json'), 'utf8')).version;
const script = path.join(desktop, 'runtime', 'ci-meta.mjs');

function run(env) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'opendoc-ci-meta-'));
  try {
    const output = path.join(scratch, 'output.txt');
    const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(GITHUB_|INPUT_|RELEASE_TAG)/.test(key)));
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...clean, GITHUB_OUTPUT: output, ...env } });
    let outputs = '';
    try { outputs = readFileSync(output, 'utf8'); } catch { /* the script failed before writing */ }
    return { status: result.status, stderr: result.stderr, build: outputs.match(/^build=(.*)$/m)?.[1] };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test('without a tag the build number is the input, or 1', () => {
  assert.equal(run({}).build, '1');
  assert.equal(run({ INPUT_BUILD: '3' }).build, '3');
  for (const bad of ['0', '01', 'x', '-1']) assert.notEqual(run({ INPUT_BUILD: bad }).status, 0, bad);
});

test('a pushed tag gives the build number and must match the app version', () => {
  assert.equal(run({ GITHUB_REF: `refs/tags/desktop-v${version}-4` }).build, '4');
  assert.match(run({ GITHUB_REF: 'refs/tags/desktop-v9.9.9-1' }).stderr, /says 9\.9\.9/);
  assert.match(run({ GITHUB_REF: `refs/tags/desktop-v${version}` }).stderr, /not desktop-v<version>-<build>/);
  assert.equal(run({ GITHUB_REF: 'refs/heads/roadmap', INPUT_BUILD: '2' }).build, '2');
});

test('a release named by upstream-watch gives the build number, rehearsal prefix included, and must agree with the build input', () => {
  assert.equal(run({ RELEASE_TAG: `desktop-v${version}-2`, INPUT_BUILD: '2', GITHUB_REF: 'refs/heads/roadmap' }).build, '2');
  assert.equal(run({ RELEASE_TAG: `dryrun-desktop-v${version}-5`, INPUT_BUILD: '5' }).build, '5');
  assert.equal(run({ RELEASE_TAG: `desktop-v${version}-2` }).build, '2');
  assert.match(run({ RELEASE_TAG: `desktop-v${version}-2`, INPUT_BUILD: '3' }).stderr, /build input is 3/);
  assert.match(run({ RELEASE_TAG: 'desktop-v9.9.9-1', INPUT_BUILD: '1' }).stderr, /says 9\.9\.9/);
  assert.match(run({ RELEASE_TAG: 'v0.6.1' }).stderr, /not desktop-v<version>-<build>/);
});
