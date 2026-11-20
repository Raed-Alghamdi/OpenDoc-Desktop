// check-artifacts.mjs against a made-up dist folder: which installers it demands (no .rpm at all is fine unless
// --require-rpm), and that it notices a package that lost the integrations or the design pack file type. The tools it falls back to
// (ar and bsdtar) are the only ones on the PATH it gets, so the result is the same on every machine; without them the test skips.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { desktop } from './builder-support.mjs';

const version = JSON.parse(readFileSync(path.join(desktop, 'package.json'), 'utf8')).version;
const script = path.join(desktop, 'tests', 'packaging', 'check-artifacts.mjs');
const build = '7';
const commit = 'abcdef0123456789abcdef0123456789abcdef01';
const mimeSource = readFileSync(path.join(desktop, 'resources', 'mime', 'opendoc-desktop.xml'), 'utf8');

const which = (name) => {
  for (const folder of (process.env.PATH ?? '').split(path.delimiter)) {
    const result = spawnSync(path.join(folder, name), ['--version'], { encoding: 'utf8' });
    if (!result.error) return path.join(folder, name);
  }
  return null;
};
const ar = which('ar');
const bsdtar = which('bsdtar');

// The files a package carries that the script reads, as a folder tree.
function stage(root, kind, { mime = true, integrations = true } = {}) {
  const write = (file, text) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), text); };
  write('usr/share/icons/hicolor/scalable/apps/opendoc-desktop.svg', '<svg/>');
  write('usr/share/icons/hicolor/symbolic/apps/opendoc-desktop-symbolic.svg', '<svg/>');
  write('opt/opendoc-desktop/resources/package-type', `${kind}\n`);
  write('opt/opendoc-desktop/resources/app-update.yml', 'provider: github\nowner: someone\nrepo: something\n');
  write('usr/share/applications/opendoc-desktop.desktop', '[Desktop Entry]\nName=opendoc-desktop\nExec=/opt/opendoc-desktop/opendoc-desktop %U\nMimeType=application/x-opendoc-pack;\n');
  if (mime) write('usr/share/mime/packages/opendoc-desktop.xml', mimeSource);
  if (integrations) {
    write('opt/opendoc-desktop/resources/integrations/claude/.claude-plugin/marketplace.json', '{}');
    write('opt/opendoc-desktop/resources/integrations/codex/.agents/plugins/marketplace.json', '{}');
  }
}
const pack = (archive, folder, ...members) => { const result = spawnSync(bsdtar, ['-cf', archive, '-C', folder, ...members], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); };

function makeDist(scratch, options = {}) {
  const dist = path.join(scratch, 'dist');
  const runtime = path.join(scratch, 'runtime');
  mkdirSync(dist, { recursive: true });
  mkdirSync(runtime, { recursive: true });
  writeFileSync(path.join(runtime, 'build-info.json'), JSON.stringify({ build: Number(build), commit }));

  const debRoot = path.join(scratch, 'deb-root');
  stage(debRoot, 'deb', options);
  mkdirSync(path.join(scratch, 'deb-control'));
  writeFileSync(path.join(scratch, 'deb-control', 'control'), `Package: opendoc-desktop\nVersion: ${version}-${build}\nArchitecture: amd64\nMaintainer: someone <someone@example.invalid>\nDescription: a test package\n`);
  writeFileSync(path.join(scratch, 'debian-binary'), '2.0\n');
  pack(path.join(scratch, 'control.tar'), path.join(scratch, 'deb-control'), '.');
  pack(path.join(scratch, 'data.tar'), debRoot, '.');
  const deb = path.join(dist, `opendoc-desktop_${version}-${build}_amd64.deb`);
  assert.equal(spawnSync(ar, ['rc', deb, 'debian-binary', 'control.tar', 'data.tar'], { cwd: scratch, encoding: 'utf8' }).status, 0);

  const pacmanRoot = path.join(scratch, 'pacman-root');
  stage(pacmanRoot, 'pacman', options);
  writeFileSync(path.join(pacmanRoot, '.PKGINFO'), `pkgname = opendoc-desktop\npkgver = ${version}-${build}\n`);
  pack(path.join(dist, `opendoc-desktop-${version}-${build}-x64.pacman`), pacmanRoot, '.PKGINFO', 'opt', 'usr');

  // A stand-in for the AppImage: only the runtime's extract flag, which unpacks files and starts nothing. It is a Node script (the
  // script under test gets a PATH with no shell tools).
  const appImage = path.join(dist, 'opendoc-desktop-x86_64.AppImage');
  writeFileSync(appImage, [
    `#!${process.execPath}`,
    "const fs = require('fs');",
    "const files = { 'resources/app-update.yml': 'provider: github\\nowner: someone\\n', 'opendoc-desktop.desktop': '[Desktop Entry]\\nMimeType=application/x-opendoc-pack;\\n' };",
    "if (process.argv[2] !== '--appimage-extract' || !(process.argv[3] in files)) process.exit(1);",
    "const target = 'squashfs-root/' + process.argv[3];",
    "fs.mkdirSync(require('path').dirname(target), { recursive: true });",
    "fs.writeFileSync(target, files[process.argv[3]]);",
    '',
  ].join('\n'));
  chmodSync(appImage, 0o755);

  const entry = (name) => { const bytes = readFileSync(path.join(dist, name)); return `  - url: ${name}\n    sha512: ${createHash('sha512').update(bytes).digest('base64')}\n    size: ${bytes.length}\n`; };
  writeFileSync(path.join(dist, 'latest-linux.yml'), `version: ${version}\nbuild: ${build}\ncommit: ${commit}\nfiles:\n${['opendoc-desktop-x86_64.AppImage', `opendoc-desktop_${version}-${build}_amd64.deb`, `opendoc-desktop-${version}-${build}-x64.pacman`].map(entry).join('')}path: opendoc-desktop-x86_64.AppImage\n`);
  return { dist, runtime };
}

function run(scratch, ...args) {
  const tools = path.join(scratch, 'tools');
  mkdirSync(tools, { recursive: true });
  for (const [name, target] of [['ar', ar], ['bsdtar', bsdtar]]) try { symlinkSync(target, path.join(tools, name)); } catch { /* already there */ }
  const { dist, runtime } = makeDist.last;
  const result = spawnSync(process.execPath, [script, '--dist', dist, '--runtime', runtime, ...args], { encoding: 'utf8', env: { PATH: tools, HOME: scratch } });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function withDist(options, body) {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'opendoc-artifacts-'));
  try {
    makeDist.last = makeDist(scratch, options);
    return body(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Linux packages are built and checked on Linux only (desktop.yml's linux job). macOS's own ar and bsdtar write these archives
// differently, so the hand-made deb would not read back there; the test would be checking the Mac's tools, not the script.
const skip = process.platform !== 'linux' ? 'Linux packages are checked on Linux' : !ar || !bsdtar ? 'ar and bsdtar are needed' : false;

test('a dist with no .rpm passes without --require-rpm and every installer that is there is checked', { skip }, () => {
  withDist({}, (scratch) => {
    const result = run(scratch);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /FAIL/);
    assert.match(result.stdout, /^ok {4}rpm: no \.rpm in dist/m);
    assert.match(result.stdout, /^ok {4}rpm update files: no \.rpm/m);
    assert.match(result.stdout, /^ok {4}rpm file type: no \.rpm/m);
    assert.match(result.stdout, /^ok {4}deb file type: application\/x-opendoc-pack/m);
    assert.match(result.stdout, /^ok {4}pacman file type: application\/x-opendoc-pack/m);
    assert.match(result.stdout, /^ok {4}AppImage update files: .*MimeType/m);
    assert.match(result.stdout, /^ok {4}latest-linux\.yml: .*3 files/m);
  });
});

test('--require-rpm turns a missing .rpm back into a failure, in every check that reads it', { skip }, () => {
  withDist({}, (scratch) => {
    const result = run(scratch, '--require-rpm');
    assert.equal(result.status, 1);
    for (const label of ['rpm', 'rpm update files', 'rpm file type', 'latest-linux.yml']) assert.match(result.stdout, new RegExp(`^FAIL {2}${label}: `, 'm'), label);
    assert.match(result.stdout, /^ok {4}deb: /m);
  });
});

test('an .rpm that is listed in latest-linux.yml but missing from dist is an error even without the flag', { skip }, () => {
  withDist({}, (scratch) => {
    const file = path.join(makeDist.last.dist, 'latest-linux.yml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('files:\n', `files:\n  - url: opendoc-desktop-${version}-${build}.x86_64.rpm\n    sha512: x\n    size: 1\n`));
    const result = run(scratch);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^FAIL {2}latest-linux\.yml: .*listed that is not in dist/m);
  });
});

test('a package without the shared-mime entry or the integrations fails, naming the file', { skip }, () => {
  withDist({ mime: false }, (scratch) => {
    const result = run(scratch);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^FAIL {2}deb: missing \/usr\/share\/mime\/packages\/opendoc-desktop\.xml/m);
    assert.match(result.stdout, /^FAIL {2}pacman: missing \/usr\/share\/mime\/packages\/opendoc-desktop\.xml/m);
    assert.match(result.stdout, /^FAIL {2}deb file type: /m);
  });
  withDist({ integrations: false }, (scratch) => {
    const result = run(scratch);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /^FAIL {2}deb: missing resources\/integrations\/claude\/\.claude-plugin\/marketplace\.json/m);
    assert.match(result.stdout, /^FAIL {2}pacman: missing resources\/integrations\//m);
  });
});
