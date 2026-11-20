// The AUR bump (desktop/release/aur-package.mjs): the PKGBUILD and .SRCINFO for a release, checked against the release's metadata, and a
// push that happens only with both the AUR key secret and the AUR_PUSH variable. No network: the "AUR" is a local bare repository.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { aurPushDecision, generate, PACKAGE_FILES, pushToAur, renderPackage, renderPkgbuild, renderSrcinfo } from '../../release/aur-package.mjs';

const desktop = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const template = path.join(desktop, 'aur');
const SHA = createHash('sha256').update('x').digest('hex');
let scratch;
before(() => { scratch = mkdtempSync(path.join(os.tmpdir(), 'opendoc-aur-test-')); });
after(() => rmSync(scratch, { recursive: true, force: true }));
const folder = (name) => { const dir = path.join(scratch, name); mkdirSync(dir, { recursive: true }); return dir; };

const run = (command, args, cwd) => spawnSync(command, args, { cwd, encoding: 'utf8' });

// A release's downloaded files: the pacman file and latest-linux.yml that describes it.
function release(name, { version = '0.6.2', build = 1, size = 4096, tamper } = {}) {
  const dir = folder(name);
  const asset = `opendoc-desktop-${version}-${build}-x64.pacman`;
  const bytes = randomBytes(size);
  writeFileSync(path.join(dir, asset), bytes);
  const sha512 = createHash('sha512').update(bytes).digest('base64');
  writeFileSync(path.join(dir, 'latest-linux.yml'), [
    `version: ${version}`, `build: ${tamper === 'build' ? build + 1 : build}`, 'commit: abcdef0123456789', 'files:',
    '  - url: opendoc-desktop-x86_64.AppImage', '    sha512: AAAA', '    size: 5',
    `  - url: ${asset}`, `    sha512: ${tamper === 'sha' ? 'A'.repeat(88) : sha512}`, `    size: ${tamper === 'size' ? size + 1 : size}`,
    `path: ${asset}`, `sha512: ${sha512}`, "releaseDate: '2026-11-20T00:00:00.000Z'", '',
  ].join('\n'));
  if (tamper === 'missing-entry') writeFileSync(path.join(dir, 'latest-linux.yml'), `version: ${version}\nbuild: ${build}\nfiles:\n  - url: other.deb\n    sha512: A\n    size: 1\n`);
  return { dir, asset, sha256: createHash('sha256').update(bytes).digest('hex') };
}

test('the committed package files survive a render with their own values', () => {
  const pkgbuild = readFileSync(path.join(template, 'PKGBUILD'), 'utf8');
  const version = pkgbuild.match(/^pkgver=(.*)$/m)[1];
  const build = pkgbuild.match(/^pkgrel=(.*)$/m)[1];
  const files = renderPackage(template, { version, build });
  for (const name of PACKAGE_FILES) assert.equal(files[name], readFileSync(path.join(template, name), 'utf8'), name);
});

test('a release gives the right PKGBUILD: version, pkgrel from the build number, and the real checksum', () => {
  const pkgbuild = renderPkgbuild(readFileSync(path.join(template, 'PKGBUILD'), 'utf8'), { version: '0.6.2', build: 3, sha256: SHA });
  assert.match(pkgbuild, /^pkgver=0\.6\.2$/m);
  assert.match(pkgbuild, /^pkgrel=3$/m);
  assert.match(pkgbuild, new RegExp(`^sha256sums=\\('${SHA}'\\)$`, 'm'));
  assert.ok(!pkgbuild.includes('SKIP\')'), 'SKIP is gone');
  // Nothing else moves: the asset and URL are built from pkgver and pkgrel inside the file.
  const before = readFileSync(path.join(template, 'PKGBUILD'), 'utf8').split('\n');
  const changed = pkgbuild.split('\n').filter((line, index) => line !== before[index]);
  assert.deepEqual(changed, ['pkgver=0.6.2', 'pkgrel=3', `sha256sums=('${SHA}')`]);
});

test('the .SRCINFO follows: version, pkgrel, the file name, the release URL and the checksum', () => {
  const srcinfo = renderSrcinfo(readFileSync(path.join(template, '.SRCINFO'), 'utf8'), { version: '0.6.2', build: 3, sha256: SHA });
  assert.match(srcinfo, /^\tpkgver = 0\.6\.2$/m);
  assert.match(srcinfo, /^\tpkgrel = 3$/m);
  assert.match(srcinfo, /^\tnoextract = opendoc-desktop-0\.6\.2-3-x64\.pacman$/m);
  assert.match(srcinfo, /^\tsource = opendoc-desktop-0\.6\.2-3-x64\.pacman::https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/desktop-v0\.6\.2-3\/opendoc-desktop-0\.6\.2-3-x64\.pacman$/m);
  assert.match(srcinfo, new RegExp(`^\\tsha256sums = ${SHA}$`, 'm'));
});

test('the generated .SRCINFO is what makepkg prints for the generated PKGBUILD', { skip: run('makepkg', ['--version']).status !== 0 && 'makepkg is not installed' }, () => {
  const out = folder('makepkg');
  const files = renderPackage(template, { version: '0.6.2', build: 3, sha256: SHA });
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(out, name), text);
  const printed = run('makepkg', ['--printsrcinfo'], out);
  assert.equal(printed.status, 0, printed.stderr);
  assert.equal(printed.stdout, files['.SRCINFO']);
});

test('a template that lost or doubled a line is refused, not patched around', () => {
  const text = readFileSync(path.join(template, 'PKGBUILD'), 'utf8');
  assert.throws(() => renderPkgbuild(text.replace(/^pkgrel=.*\n/m, ''), { version: '0.6.2', build: 1 }), /pkgrel/);
  assert.throws(() => renderPkgbuild(`${text}pkgver=9.9.9\n`, { version: '0.6.2', build: 1 }), /pkgver/);
  assert.throws(() => renderSrcinfo(readFileSync(path.join(template, '.SRCINFO'), 'utf8').replace(/^\tsource = .*\n/m, ''), { version: '0.6.2', build: 1 }), /source/);
  for (const bad of [{ version: '0.6', build: 1 }, { version: '0.6.2', build: 0 }, { version: '0.6.2', build: 1, sha256: 'abc' }]) {
    assert.throws(() => renderPkgbuild(text, bad));
  }
});

test('generate: the release gives the files, with the file\'s own SHA-256', () => {
  const { dir, sha256 } = release('release-ok', { version: '0.6.2', build: 4 });
  const result = generate({ tag: 'desktop-v0.6.2-4', assets: dir, template });
  assert.equal(result.sha256, sha256);
  assert.equal(result.asset, 'opendoc-desktop-0.6.2-4-x64.pacman');
  assert.match(result.files.PKGBUILD, /^pkgrel=4$/m);
  assert.match(result.files.PKGBUILD, new RegExp(`'${sha256}'`));
  assert.deepEqual(Object.keys(result.files), PACKAGE_FILES);
});

test('generate: a damaged, mismatched or missing upload stops the bump', () => {
  assert.throws(() => generate({ tag: 'desktop-v0.6.2-1', assets: release('bad-sha', { tamper: 'sha' }).dir, template }), /SHA-512/);
  assert.throws(() => generate({ tag: 'desktop-v0.6.2-1', assets: release('bad-size', { tamper: 'size' }).dir, template }), /bytes/);
  assert.throws(() => generate({ tag: 'desktop-v0.6.2-1', assets: release('bad-build', { tamper: 'build' }).dir, template }), /says 0\.6\.2-2/);
  assert.throws(() => generate({ tag: 'desktop-v0.6.2-1', assets: release('no-entry', { tamper: 'missing-entry' }).dir, template }), /does not list/);
  assert.throws(() => generate({ tag: 'desktop-v0.6.2-2', assets: release('wrong-tag').dir, template }), /no opendoc-desktop-0\.6\.2-2/);
  assert.throws(() => generate({ tag: 'v0.6.2', assets: release('not-a-tag').dir, template }), /desktop-v/);
});

test('the push needs both the secret and the variable, and never happens for a rehearsal', () => {
  const table = [
    [{ keyPresent: 'false', variable: undefined }, false],
    [{ keyPresent: 'true', variable: undefined }, false],
    [{ keyPresent: 'true', variable: '' }, false],
    [{ keyPresent: 'true', variable: 'false' }, false],
    [{ keyPresent: 'false', variable: 'true' }, false],
    [{ keyPresent: '', variable: 'true' }, false],
    [{ keyPresent: 'true', variable: 'true' }, true],
    [{ keyPresent: 'true', variable: 'true', tag: 'desktop-v0.6.2-1' }, true],
    [{ keyPresent: 'true', variable: 'true', tag: 'dryrun-desktop-v0.6.2-1' }, false],
    [{ keyPresent: 'true', variable: 'true', tag: 'v0.6.2' }, false],
  ];
  for (const [input, expected] of table) assert.equal(aurPushDecision(input).push, expected, JSON.stringify(input));
  assert.match(aurPushDecision({ keyPresent: 'true', variable: 'false' }).reasons.join(), /AUR_PUSH/);
  assert.match(aurPushDecision({ keyPresent: 'false', variable: 'true' }).reasons.join(), /secret/);
});

function bareRemote(name) {
  const remote = path.join(folder(name), 'aur.git');
  assert.equal(run('git', ['init', '--bare', '--quiet', remote]).status, 0);
  return remote;
}
const branches = (remote) => run('git', ['--git-dir', remote, 'branch', '--list'], scratch).stdout.trim();

test('pushToAur pushes nothing without both the secret and the variable, and pushes the three files with both', () => {
  const { dir } = release('push-release', { version: '0.6.2', build: 1 });
  const out = folder('push-out');
  const result = generate({ tag: 'desktop-v0.6.2-1', assets: dir, template });
  for (const [name, text] of Object.entries(result.files)) writeFileSync(path.join(out, name), text);
  const remote = bareRemote('push-remote');
  const tag = 'desktop-v0.6.2-1';

  for (const [keyPresent, variable] of [['false', 'false'], ['true', undefined], ['false', 'true'], ['true', 'false']]) {
    const outcome = pushToAur({ dir: out, remote, tag, keyPresent, variable });
    assert.equal(outcome.pushed, false, `${keyPresent} ${variable}`);
    assert.match(outcome.reason, /not pushing/);
  }
  assert.equal(pushToAur({ dir: out, remote, tag: 'dryrun-desktop-v0.6.2-1', keyPresent: 'true', variable: 'true' }).pushed, false);
  assert.equal(branches(remote), '', 'the AUR repository is still empty');

  const pushed = pushToAur({ dir: out, remote, tag, keyPresent: 'true', variable: 'true' });
  assert.equal(pushed.pushed, true, pushed.reason);
  assert.match(branches(remote), /master/);
  const listing = run('git', ['--git-dir', remote, 'ls-tree', '--name-only', 'master'], scratch).stdout.trim().split('\n').sort();
  assert.deepEqual(listing, ['.SRCINFO', 'PKGBUILD', 'opendoc-desktop-bin.install']);
  assert.equal(run('git', ['--git-dir', remote, 'log', '-1', '--format=%s', 'master'], scratch).stdout.trim(), 'Update to 0.6.2-1');
  assert.equal(run('git', ['--git-dir', remote, 'show', 'master:PKGBUILD'], scratch).stdout, result.files.PKGBUILD);

  // The same release again changes nothing and adds no commit.
  const again = pushToAur({ dir: out, remote, tag, keyPresent: 'true', variable: 'true' });
  assert.equal(again.pushed, false);
  assert.equal(run('git', ['--git-dir', remote, 'rev-list', '--count', 'master'], scratch).stdout.trim(), '1');

  // The next build is a second commit.
  const { dir: dir2 } = release('push-release-2', { version: '0.6.2', build: 2 });
  const out2 = folder('push-out-2');
  for (const [name, text] of Object.entries(generate({ tag: 'desktop-v0.6.2-2', assets: dir2, template }).files)) writeFileSync(path.join(out2, name), text);
  assert.equal(pushToAur({ dir: out2, remote, tag: 'desktop-v0.6.2-2', keyPresent: 'true', variable: 'true' }).pushed, true);
  assert.equal(run('git', ['--git-dir', remote, 'rev-list', '--count', 'master'], scratch).stdout.trim(), '2');
});

test('the command line: generate writes the files, gate and push say no without both switches', () => {
  const { dir } = release('cli-release', { version: '0.6.2', build: 1 });
  const out = path.join(scratch, 'cli-out');
  const cli = path.join(desktop, 'release', 'aur-package.mjs');
  const made = run(process.execPath, [cli, 'generate', '--tag', 'desktop-v0.6.2-1', '--assets', dir, '--template', template, '--out', out]);
  assert.equal(made.status, 0, made.stderr);
  for (const name of PACKAGE_FILES) assert.ok(existsSync(path.join(out, name)), name);
  const gate = run(process.execPath, [cli, 'gate', '--key', 'true', '--variable', 'false', '--tag', 'desktop-v0.6.2-1']);
  assert.equal(gate.status, 0);
  assert.match(gate.stdout, /stays off/);
  const remote = bareRemote('cli-remote');
  const push = spawnSync(process.execPath, [cli, 'push', '--dir', out, '--remote', remote, '--tag', 'desktop-v0.6.2-1'], { encoding: 'utf8', env: { ...process.env, AUR_KEY_PRESENT: 'true', AUR_PUSH: '' } });
  assert.equal(push.status, 0, push.stderr);
  assert.match(push.stdout, /not pushing/);
  assert.equal(branches(remote), '');
});
