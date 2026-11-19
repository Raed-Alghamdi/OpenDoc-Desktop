import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeMacMetadata } from '../../runtime/merge-mac-metadata.mjs';

const make = (arch, sha) => `version: 0.6.1\nbuild: 2\ncommit: abcdef1\nfiles:\n  - url: opendoc-desktop-0.6.1-2-${arch}.zip\n    sha512: ${sha}\n    size: 10\n  - url: opendoc-desktop-0.6.1-2-${arch}.dmg\n    sha512: ${sha}d\n    size: 11\npath: opendoc-desktop-0.6.1-2-${arch}.zip\nsha512: ${sha}\nreleaseDate: '2026-11-18T00:00:00.000Z'\n`;

test('lists the files of both architectures and keeps the first file otherwise', () => {
  const merged = mergeMacMetadata([make('arm64', 'aaa'), make('x64', 'bbb')]);
  assert.deepEqual([...merged.matchAll(/^ {2}- url: (.*)$/gm)].map((m) => m[1]), [
    'opendoc-desktop-0.6.1-2-arm64.zip', 'opendoc-desktop-0.6.1-2-arm64.dmg',
    'opendoc-desktop-0.6.1-2-x64.zip', 'opendoc-desktop-0.6.1-2-x64.dmg',
  ]);
  assert.ok(merged.startsWith('version: 0.6.1\nbuild: 2\ncommit: abcdef1\nfiles:\n'));
  assert.ok(merged.includes('path: opendoc-desktop-0.6.1-2-arm64.zip\nsha512: aaa\n'));
});

test('refuses files that disagree on version, build or commit', () => {
  assert.throws(() => mergeMacMetadata([make('arm64', 'a'), make('x64', 'b').replace('build: 2', 'build: 3')]), /build/);
  assert.throws(() => mergeMacMetadata([make('arm64', 'a'), make('x64', 'b').replace('version: 0.6.1', 'version: 0.6.2')]), /version/);
});

test('refuses a file without a files list', () => {
  assert.throws(() => mergeMacMetadata(['version: 0.6.1\n']), /files/);
});
