import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addBuildFields } from '../../runtime/release-metadata.mjs';

const metadata = 'version: 0.6.1\nfiles:\n  - url: a.AppImage\n    sha512: abc\n    size: 1\npath: a.AppImage\nreleaseDate: \'2026-11-18T00:00:00.000Z\'\n';

test('adds build and commit right after the version', () => {
  const text = addBuildFields(metadata, 3, 'abcdef1234567');
  assert.ok(text.startsWith('version: 0.6.1\nbuild: 3\ncommit: abcdef1234567\nfiles:\n'));
  assert.ok(text.endsWith(metadata.slice(metadata.indexOf('files:'))));
});

test('is idempotent and replaces earlier values', () => {
  const once = addBuildFields(metadata, 2, 'abcdef1');
  assert.equal(addBuildFields(once, 2, 'abcdef1'), once);
  const text = addBuildFields(once, 5, 'fedcba9');
  assert.equal(text.match(/^build: /gm).length, 1);
  assert.equal(text.match(/^commit: /gm).length, 1);
  assert.ok(text.includes('build: 5\ncommit: fedcba9\n'));
});

test('writes only build when there is no commit', () => {
  assert.equal(addBuildFields(metadata, 1), metadata.replace('\n', '\nbuild: 1\n'));
});

test('refuses a build that is not a positive whole number', () => {
  for (const build of [0, -1, 1.5, 'x', '', '01', undefined]) assert.throws(() => addBuildFields(metadata, build), /build number/);
});

test('refuses a commit that is not a hash, and metadata without a version', () => {
  assert.throws(() => addBuildFields(metadata, 1, 'not a hash'), /commit/);
  assert.throws(() => addBuildFields('files: []\n', 1), /version/);
});
