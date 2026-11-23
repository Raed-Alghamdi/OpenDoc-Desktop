// The notes a release carries (desktop/release/notes.mjs): what desktop.yml writes for a pushed desktop-v tag, and the install notes
// upstream-watch appends to its own lines.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { installNotes, parseReleaseTag, tagReleaseNotes } from '../../release/notes.mjs';

const emDash = String.fromCodePoint(0x2014);

test('a release tag gives the version and the build; anything else is refused', () => {
  assert.deepEqual(parseReleaseTag('desktop-v0.6.1-1'), { version: '0.6.1', build: 1 });
  assert.deepEqual(parseReleaseTag('dryrun-desktop-v0.6.2-12'), { version: '0.6.2', build: 12 });
  for (const tag of ['v0.6.1', 'desktop-v0.6.1', 'desktop-v0.6.1-0', 'desktop-v0.6-1', 'desktop-v0.6.1-1-extra', '', undefined]) {
    assert.throws(() => parseReleaseTag(tag), /desktop-v<x\.y\.z>-<build>/, String(tag));
  }
});

test('the notes of a tag release credit OpenDoc, name the build and the commit, and carry the install notes', () => {
  const notes = tagReleaseNotes({ tag: 'desktop-v0.6.1-2', commit: '0123456789abcdef0123', repository: 'owner/OpenDoc-Desktop' });
  assert.match(notes, /^OpenDoc Desktop 0\.6\.1, build 2: the desktop app for \[OpenDoc\]\(https:\/\/github\.com\/RyanYahya\/OpenDoc\) 0\.6\.1/);
  assert.match(notes, /original OpenDoc project by RyanYahya, released under the MIT license/);
  assert.match(notes, /Built from commit 0123456789ab of this repository\./);
  assert.match(notes, /## Which file\n/);
  assert.match(notes, /## Installing\n/);
  assert.match(notes, /## Updates\n/);
  assert.match(notes, /https:\/\/github\.com\/owner\/OpenDoc-Desktop\/blob\/0123456789abcdef0123\/docs\/DESKTOP\.md/);
  assert.ok(!notes.includes('\n\n\n'), 'no double blank lines');
  assert.ok(!notes.includes(emDash));
  assert.ok(notes.endsWith('\n') && !notes.endsWith('\n\n'));
});

test('the install notes name every file of this version and build the way electron-builder names them', () => {
  const notes = installNotes({ version: '0.7.0', build: 3 });
  for (const file of ['opendoc-desktop-x86_64.AppImage', 'opendoc-desktop_0.7.0-3_amd64.deb', 'opendoc-desktop-0.7.0-3.x86_64.rpm', 'opendoc-desktop-0.7.0-3-x64.pacman', 'opendoc-desktop-0.7.0-3-arm64.dmg']) {
    assert.ok(notes.includes(`\`${file}\``), file);
  }
  for (const fact of ['libfuse2t64', 'AppArmor', '--nogpgcheck', 'Open Anyway', 'xattr -dr com.apple.quarantine /Applications/opendoc-desktop.app', 'Restart to Update', 'SHA-512']) {
    assert.ok(notes.includes(fact), fact);
  }
  // The signature files: what they are, the command to check one by hand, and where the public key is.
  for (const fact of ['`<file>.sig`', 'Ed25519', 'openssl pkeyutl -verify -pubin -inkey release-key.pem -rawin -in <file> -sigfile <file>.sig', 'desktop/resources/updater/release-key.pem', 'before it installs a deb, rpm or pacman update', 'Keep its `.sig` in another folder']) {
    assert.ok(notes.includes(fact), fact);
  }
  assert.ok(!notes.includes('themselves are not signed'), 'the old "not signed" sentence is gone');
  assert.ok(!notes.includes('user guide'), 'no guide link without a repository');
});

test('the command line writes the notes desktop.yml attaches, and refuses a missing argument or a bad tag', () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'opendoc-notes-cli-'));
  try {
    const cli = fileURLToPath(new URL('../../release/notes.mjs', import.meta.url));
    const out = path.join(scratch, 'notes.md');
    const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(run('--tag', 'desktop-v0.6.1-1', '--commit', 'abcdef0123456789', '--repository', 'owner/repo', '--out', out).status, 0);
    assert.equal(readFileSync(out, 'utf8'), tagReleaseNotes({ tag: 'desktop-v0.6.1-1', commit: 'abcdef0123456789', repository: 'owner/repo' }));
    assert.equal(run('--out', out).status, 2);
    const bad = run('--tag', 'v0.6.1', '--out', out);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /desktop-v<x\.y\.z>-<build>/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('desktop.yml attaches these notes to the draft it creates', () => {
  const workflow = readFileSync(fileURLToPath(new URL('../../../.github/workflows/desktop.yml', import.meta.url)), 'utf8');
  assert.match(workflow, /node desktop\/release\/notes\.mjs --tag "\$TAG" --commit "\$BUILT_SHA" --repository "\$GITHUB_REPOSITORY" --out "\$RUNNER_TEMP\/release-notes\.md"/);
  assert.match(workflow, /--notes-file "\$RUNNER_TEMP\/release-notes\.md"/);
  const watch = readFileSync(fileURLToPath(new URL('../../../.github/workflows/upstream-watch.yml', import.meta.url)), 'utf8');
  assert.match(watch, /decide\.mjs notes .*\n.*--repository "\$GITHUB_REPOSITORY"/);
});
