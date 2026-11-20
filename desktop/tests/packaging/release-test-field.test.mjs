// A release must never be a test build (runtime/test-build.mjs): dist.mjs makes one only when asked, and the checks fail on any built
// artifact whose app.asar has the field. Real tools (ar, bsdtar) and real asar archives; the AppImage is a stand-in script.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { installerTestBuildMark, readAsarFile, testBuildMark } from './app-archive.mjs';
import { asarModule, desktop } from './builder-support.mjs';
import { testBuildArguments, testBuildField, testBuildVariable } from '../../runtime/test-build.mjs';

const tmp = (name) => mkdtempSync(path.join(os.tmpdir(), `opendoc-${name}-`));

/** A real app.asar holding a package.json (with or without the mark) and a nested file. */
async function makeAsar(scratch, name, { mark }) {
  const source = path.join(scratch, `${name}-src`);
  mkdirSync(path.join(source, 'src', 'main'), { recursive: true });
  writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'opendoc-desktop', version: '0.6.1', main: 'src/main/index.mjs', ...(mark === undefined ? {} : { [testBuildField]: mark }) }, null, 2));
  writeFileSync(path.join(source, 'src', 'main', 'index.mjs'), '// main\n');
  const file = path.join(scratch, `${name}.asar`);
  await asarModule().createPackage(source, file);
  return file;
}

test('only the value 1 asks for a test build, and the argument is electron-builder\'s extraMetadata', () => {
  assert.deepEqual(testBuildArguments({ [testBuildVariable]: '1' }), [`-c.extraMetadata.${testBuildField}=true`]);
  for (const value of [undefined, '', '0', 'true', 'yes', '2', ' 1']) assert.deepEqual(testBuildArguments(value === undefined ? {} : { [testBuildVariable]: value }), [], String(value));
  assert.equal(testBuildVariable, 'OPENDOC_DESKTOP_TEST_BUILD');
  assert.equal(testBuildField, 'opendocTestBuild');
});

// dist.mjs in a scratch copy of its folder, with a fake pnpm that records what electron-builder would have been given.
function distRun(env) {
  const scratch = tmp('dist');
  try {
    const runtime = path.join(scratch, 'desktop', 'runtime');
    mkdirSync(runtime, { recursive: true });
    for (const name of ['dist.mjs', 'release-metadata.mjs', 'test-build.mjs']) copyFileSync(path.join(desktop, 'runtime', name), path.join(runtime, name));
    mkdirSync(path.join(scratch, 'desktop', 'dist'));
    const info = path.join(scratch, 'desktop', 'build', 'runtime', `${process.platform}-${process.arch}`);
    mkdirSync(info, { recursive: true });
    writeFileSync(path.join(info, 'build-info.json'), JSON.stringify({ build: 3, commit: 'a'.repeat(40) }));
    const bin = path.join(scratch, 'bin');
    mkdirSync(bin);
    const record = path.join(scratch, 'args.json');
    writeFileSync(path.join(bin, 'pnpm'), `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));\n`);
    chmodSync(path.join(bin, 'pnpm'), 0o755);
    const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== testBuildVariable));
    const result = spawnSync(process.execPath, [path.join(runtime, 'dist.mjs'), '--linux', 'deb', ...(env.extra ?? [])], { encoding: 'utf8', env: { ...clean, ...env.vars, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
    let args = null;
    try { args = JSON.parse(readFileSync(record, 'utf8')); } catch { /* not reached */ }
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, args };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

test('dist.mjs adds the test build argument, and says so, only when OPENDOC_DESKTOP_TEST_BUILD is 1', () => {
  const plain = distRun({ vars: {} });
  assert.equal(plain.status, 0, plain.stderr);
  assert.ok(!plain.args.some((arg) => arg.includes(testBuildField)), 'no mark by default');
  assert.doesNotMatch(plain.stdout, /TEST BUILD/);
  const other = distRun({ vars: { [testBuildVariable]: '0' } });
  assert.ok(!other.args.some((arg) => arg.includes(testBuildField)));

  const test_ = distRun({ vars: { [testBuildVariable]: '1' } });
  assert.equal(test_.status, 0, test_.stderr);
  assert.ok(test_.args.includes(`-c.extraMetadata.${testBuildField}=true`));
  assert.match(test_.stdout, /OPENDOC_DESKTOP_TEST_BUILD=1: making a TEST BUILD/);
  // Everything else is as in the plain build: the same arguments, plus that one.
  assert.deepEqual(test_.args.filter((arg) => !arg.includes(testBuildField)), plain.args);
  assert.equal(test_.args.filter((arg) => arg.includes(testBuildField)).length, 1);
});

test('the asar reader finds package.json and nested files, and says no to what is not there', async () => {
  const scratch = tmp('asar');
  try {
    const plain = readFileSync(await makeAsar(scratch, 'plain', {}));
    const text = readAsarFile(plain, 'package.json').toString('utf8');
    assert.equal(JSON.parse(text).name, 'opendoc-desktop');
    assert.equal(readAsarFile(plain, 'src/main/index.mjs').toString('utf8'), '// main\n');
    assert.equal(readAsarFile(plain, 'nope.json'), null);
    assert.equal(readAsarFile(plain, 'src'), null, 'a folder is not a file');
    assert.throws(() => readAsarFile(Buffer.from('this is not an archive at all'), 'package.json'), /not an asar/);
    assert.throws(() => readAsarFile(plain.subarray(0, 40), 'package.json'), /cut short|not an asar/);
    assert.deepEqual(testBuildMark(text), { present: false, value: undefined });
    assert.deepEqual(testBuildMark(JSON.stringify({ [testBuildField]: true })), { present: true, value: true });
    assert.equal(testBuildMark(JSON.stringify({ [testBuildField]: false })).present, true, 'present means the key exists, whatever its value');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

const which = (name) => {
  for (const folder of (process.env.PATH ?? '').split(path.delimiter)) {
    const result = spawnSync(path.join(folder, name), ['--version'], { encoding: 'utf8' });
    if (!result.error) return path.join(folder, name);
  }
  return null;
};
const ar = which('ar');
const bsdtar = which('bsdtar');
const skip = !ar || !bsdtar ? 'ar and bsdtar are needed' : false;
const script = path.join(desktop, 'tests', 'packaging', 'check-release.mjs');

/** A folder of fake artifacts, each with `asar` as its app archive: deb, pacman, a Mac zip, an AppImage stand-in and a dmg. */
function artifacts(scratch, asar) {
  const folder = path.join(scratch, 'release');
  mkdirSync(folder, { recursive: true });
  const pack = (archive, root, ...members) => assert.equal(spawnSync(bsdtar, ['-cf', archive, '-C', root, ...members]).status, 0);
  const linux = path.join(scratch, 'linux-root');
  mkdirSync(path.join(linux, 'opt', 'opendoc-desktop', 'resources'), { recursive: true });
  copyFileSync(asar, path.join(linux, 'opt', 'opendoc-desktop', 'resources', 'app.asar'));
  pack(path.join(folder, 'opendoc-desktop-0.6.1-3-x64.pacman'), linux, 'opt');
  mkdirSync(path.join(scratch, 'deb-control'));
  writeFileSync(path.join(scratch, 'deb-control', 'control'), 'Package: x\n');
  writeFileSync(path.join(scratch, 'debian-binary'), '2.0\n');
  pack(path.join(scratch, 'control.tar'), path.join(scratch, 'deb-control'), '.');
  pack(path.join(scratch, 'data.tar'), linux, '.');
  assert.equal(spawnSync(ar, ['rc', path.join(folder, 'opendoc-desktop_0.6.1-3_amd64.deb'), 'debian-binary', 'control.tar', 'data.tar'], { cwd: scratch }).status, 0);
  const mac = path.join(scratch, 'mac-root', 'opendoc-desktop.app', 'Contents', 'Resources');
  mkdirSync(mac, { recursive: true });
  copyFileSync(asar, path.join(mac, 'app.asar'));
  pack(path.join(folder, 'opendoc-desktop-0.6.1-3-arm64.zip'), path.join(scratch, 'mac-root'), 'opendoc-desktop.app');
  const appImage = path.join(folder, 'opendoc-desktop-x86_64.AppImage');
  writeFileSync(appImage, `#!${process.execPath}\nconst fs = require('fs');\nif (process.argv[2] !== '--appimage-extract') process.exit(1);\nfs.mkdirSync('squashfs-root/resources', { recursive: true });\nfs.copyFileSync(${JSON.stringify(asar)}, 'squashfs-root/resources/app.asar');\n`);
  chmodSync(appImage, 0o644); // not executable: actions/download-artifact drops the mode bits, and the release job reads such files
  writeFileSync(path.join(folder, 'opendoc-desktop-0.6.1-3-arm64.dmg'), 'not a real dmg');
  writeFileSync(path.join(folder, 'latest-linux.yml'), 'version: 0.6.1\n');
  return folder;
}

function check(scratch, ...targets) {
  const tools = path.join(scratch, 'tools');
  mkdirSync(tools, { recursive: true });
  for (const [name, target] of [['ar', ar], ['bsdtar', bsdtar]]) try { symlinkSync(target, path.join(tools, name)); } catch { /* there */ }
  const result = spawnSync(process.execPath, [script, ...targets], { encoding: 'utf8', env: { PATH: tools, HOME: scratch } });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('check-release.mjs passes a folder of release artifacts and lists what it read', { skip }, async () => {
  const scratch = tmp('release');
  try {
    const folder = artifacts(scratch, await makeAsar(scratch, 'release', {}));
    const result = check(scratch, folder);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    for (const kind of ['pacman', 'deb', 'zip', 'AppImage']) assert.match(result.stdout, new RegExp(`^ok {4}\\S+ \\(${kind}\\): no ${testBuildField}`, 'm'), kind);
    assert.match(result.stdout, /^skip {2}\S+\.dmg \(dmg\)/m);
    assert.doesNotMatch(result.stdout, /latest-linux/);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('check-release.mjs fails every artifact whose app archive has the field, whatever its value', { skip }, async () => {
  for (const mark of [true, false]) {
    const scratch = tmp('release-test');
    try {
      const folder = artifacts(scratch, await makeAsar(scratch, 'test', { mark }));
      const result = check(scratch, folder);
      assert.equal(result.status, 1, result.stdout);
      for (const kind of ['pacman', 'deb', 'zip', 'AppImage']) assert.match(result.stdout, new RegExp(`^FAIL {2}\\S+ \\(${kind}\\): this is a test build`, 'm'), `${kind} ${mark}`);
      // Handed to the single file, the same.
      assert.equal(check(scratch, path.join(folder, 'opendoc-desktop-0.6.1-3-x64.pacman')).status, 1);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }
});

test('check-release.mjs: one test build among good artifacts fails the run, and an unreadable or missing artifact is an error', { skip }, async () => {
  const scratch = tmp('release-mixed');
  try {
    const good = artifacts(scratch, await makeAsar(scratch, 'good', {}));
    const badAsar = await makeAsar(scratch, 'bad', { mark: true });
    // Replace only the pacman package with a test build.
    const linux = path.join(scratch, 'bad-root', 'opt', 'opendoc-desktop', 'resources');
    mkdirSync(linux, { recursive: true });
    copyFileSync(badAsar, path.join(linux, 'app.asar'));
    assert.equal(spawnSync(bsdtar, ['-cf', path.join(good, 'opendoc-desktop-0.6.1-3-x64.pacman'), '-C', path.join(scratch, 'bad-root'), 'opt']).status, 0);
    const mixed = check(scratch, good);
    assert.equal(mixed.status, 1);
    assert.match(mixed.stdout, /^FAIL {2}\S+\.pacman \(pacman\): this is a test build/m);
    assert.match(mixed.stdout, /^ok {4}\S+\.deb \(deb\)/m);

    // A package that is not an archive, an app.asar that is not an asar, and a folder with nothing in it.
    const broken = path.join(scratch, 'broken');
    mkdirSync(broken);
    writeFileSync(path.join(broken, 'opendoc-desktop-0.6.1-3-x64.pacman'), 'garbage');
    const unreadable = check(scratch, broken);
    assert.equal(unreadable.status, 1);
    assert.match(unreadable.stdout, /^FAIL {2}\S+\.pacman \(pacman\): /m);
    const empty = path.join(scratch, 'empty');
    mkdirSync(empty);
    writeFileSync(path.join(empty, 'latest-linux.yml'), 'version: 0.6.1\n');
    const nothing = check(scratch, empty);
    assert.equal(nothing.status, 1);
    assert.match(nothing.stdout, /FAIL {2}no installer to check/);
    assert.equal(spawnSync(process.execPath, [script], { encoding: 'utf8' }).status, 2, 'no argument is a usage error');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('installerTestBuildMark reads a real zip and a real asar through the same path', { skip }, async () => {
  const scratch = tmp('release-one');
  try {
    const folder = artifacts(scratch, await makeAsar(scratch, 'one', { mark: true }));
    assert.deepEqual(installerTestBuildMark(path.join(folder, 'opendoc-desktop-0.6.1-3-arm64.zip')), { present: true, value: true });
    assert.deepEqual(installerTestBuildMark(path.join(folder, 'opendoc-desktop-0.6.1-3-arm64.dmg')), { skipped: true });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('check-packaged.mjs --release reads the unpacked apps\' app.asar, and plain runs do not look', async () => {
  const scratch = tmp('packaged-release');
  const script2 = path.join(desktop, 'tests', 'packaging', 'check-packaged.mjs');
  try {
    const dist = path.join(scratch, 'dist');
    const resources = path.join(dist, 'linux-unpacked', 'resources');
    mkdirSync(resources, { recursive: true });
    cpSync(path.join(desktop, 'integrations'), path.join(resources, 'integrations'), { recursive: true });
    cpSync(path.join(desktop, 'resources', 'updater'), path.join(resources, 'updater'), { recursive: true });
    const run = (...args) => spawnSync(process.execPath, [script2, '--dist', dist, '--require', 'linux', ...args], { encoding: 'utf8' });

    copyFileSync(await makeAsar(scratch, 'ok', {}), path.join(resources, 'app.asar'));
    const good = run('--release');
    assert.equal(good.status, 0, good.stdout + good.stderr);
    assert.match(good.stdout, /^ok {4}linux-unpacked is not a test build: no opendocTestBuild/m);

    copyFileSync(await makeAsar(scratch, 'marked', { mark: true }), path.join(resources, 'app.asar'));
    const marked = run('--release');
    assert.equal(marked.status, 1);
    assert.match(marked.stdout, /^FAIL {2}linux-unpacked is not a test build: this is a test build/m);
    assert.equal(run().status, 0, 'without --release the mark is not looked for (a test build is a legitimate local build)');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
