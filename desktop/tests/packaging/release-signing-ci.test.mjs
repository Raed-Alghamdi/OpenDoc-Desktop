// How the signing key reaches the release (desktop.yml and upstream-watch.yml): only the signing step sees the secret, the step comes
// before anything is attached, a called workflow is handed the secret explicitly, and no unsigned release can be drafted.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { desktop } from './builder-support.mjs';

const read = (name) => readFileSync(path.join(desktop, '..', '.github', 'workflows', name), 'utf8');
const desktopYml = read('desktop.yml');
const watchYml = read('upstream-watch.yml');
const releaseJob = desktopYml.slice(desktopYml.indexOf('\n  release:\n'));

/** The text of one step of the release job, from its "- name:" line to the next step. */
const step = (name) => {
  const start = releaseJob.indexOf(`- name: ${name}\n`);
  assert.ok(start > 0, `no step "${name}"`);
  const next = releaseJob.indexOf('\n      - ', start + 1);
  return releaseJob.slice(start, next < 0 ? undefined : next);
};

test('desktop.yml takes the signing key as a required secret of workflow_call', () => {
  assert.match(desktopYml, /workflow_call:[\s\S]*?\n    secrets:\n      DESKTOP_SIGNING_KEY:\n(?:        .*\n)*?        required: true\n/);
});

test('the secret is read in one place: the environment of the signing step of the release job', () => {
  assert.equal(desktopYml.match(/secrets\.DESKTOP_SIGNING_KEY/g).length, 1);
  assert.match(step('Sign the installers'), /env:\n          DESKTOP_SIGNING_KEY: \$\{\{ secrets\.DESKTOP_SIGNING_KEY \}\}\n/);
  assert.doesNotMatch(desktopYml, /secrets: inherit/);
  assert.doesNotMatch(step('Sign the installers'), /echo|printenv|\benv\b(?!:)|set -x/, 'the key is never printed');
});

test('the signing step signs every installer type and nothing else, between the test build check and the draft release', () => {
  const signing = step('Sign the installers');
  for (const extension of ['AppImage', 'deb', 'rpm', 'pacman', 'dmg', 'zip']) assert.match(signing, new RegExp(`\\b${extension}\\b`), extension);
  assert.doesNotMatch(signing, /blockmap|\.yml/);
  assert.match(signing, /node desktop\/release\/sign\.mjs "\$\{files\[@\]\}"/);
  const order = ['Check that no release file is a test build', 'Sign the installers', 'Check the signatures', 'Create the draft release'].map((name) => releaseJob.indexOf(`- name: ${name}\n`));
  assert.ok(order.every((position) => position > 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'the order of the steps');
  // What is attached includes the signature files: the whole folders, not a list of extensions.
  assert.match(releaseJob, /release\/desktop-linux\/\* release\/desktop-mac-\*\/\* release\/latest-mac\.yml/);
});

test('every signature is checked after signing; the checks before signing leave signatures out', () => {
  assert.match(step('Check the signatures'), /check-release\.mjs release\s*$/);
  const calls = [...desktopYml.matchAll(/check-release\.mjs (.*)/g)].map((match) => match[1]);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.filter((call) => !call.startsWith('--skip-signatures')), ['release']);
});

test('upstream-watch hands desktop.yml the secret by name, and not the others', () => {
  const call = watchYml.slice(watchYml.indexOf('  desktop:\n'), watchYml.indexOf('  finish:\n'));
  assert.match(call, /uses: \.\/\.github\/workflows\/desktop\.yml\n/);
  assert.match(call, /\n    secrets:\n      DESKTOP_SIGNING_KEY: \$\{\{ secrets\.DESKTOP_SIGNING_KEY \}\}\n/);
  assert.doesNotMatch(call, /secrets: inherit/, 'not every secret of the repository');
});
