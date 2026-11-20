#!/usr/bin/env node
// Checks the Linux installers in desktop/dist: each file carries the app version and the build number in its own metadata (not
// just its name; the AppImage has no version in its name), and latest-linux.yml lists every installer and carries build: and commit:.
//
// It also checks that each package carries the agent integrations with their dot folders and the design pack file type (the
// shared-mime entry and the .desktop file's MimeType line).
//
// Usage: node desktop/tests/packaging/check-artifacts.mjs [--dist <folder>] [--runtime <folder>] [--require-rpm]
// Reads package metadata with dpkg-deb, pacman and rpm where they exist, and otherwise straight from the archive (ar and bsdtar),
// except for rpm, which then is checked by file name only. Without --require-rpm a dist with no .rpm at all is fine (a machine
// without rpm cannot build one); an .rpm that is there is always checked. --runtime is the folder holding build-info.json (default:
// desktop/build/runtime/<platform>-<arch>).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const desktop = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const { values } = parseArgs({ options: { dist: { type: 'string' }, runtime: { type: 'string' }, 'require-rpm': { type: 'boolean', default: false } }, strict: true });
const dist = path.resolve(values.dist ?? path.join(desktop, 'dist'));
const version = JSON.parse(readFileSync(path.join(desktop, 'package.json'), 'utf8')).version;
const runtime = path.resolve(values.runtime ?? path.join(desktop, 'build', 'runtime', `${process.platform}-${process.arch}`));
const info = JSON.parse(readFileSync(path.join(runtime, 'build-info.json'), 'utf8'));
const build = String(info.build);

const tool = (command, args, input) => {
  const result = spawnSync(command, args, { encoding: 'utf8', input, maxBuffer: 64 << 20 });
  return result.error || result.status !== 0 ? null : result.stdout;
};
const field = (text, name) => text.match(new RegExp(`^${name}\\s*[:=]\\s*(.*)$`, 'm'))?.[1].trim();
const files = readdirSync(dist);

// The scalable and symbolic icons are mapped in through fpm (electron-builder installs only the sized PNGs).
const iconFiles = [
  '/usr/share/icons/hicolor/scalable/apps/opendoc-desktop.svg',
  '/usr/share/icons/hicolor/symbolic/apps/opendoc-desktop-symbolic.svg',
];
// The agent integrations sit in the app's resources with their dot folders, which a careless file filter would drop, and the
// design pack file type is a shared-mime entry that the package installs next to the .desktop file.
const integrationFiles = [
  'resources/integrations/claude/.claude-plugin/marketplace.json',
  'resources/integrations/codex/.agents/plugins/marketplace.json',
];
const mimeFile = 'usr/share/mime/packages/opendoc-desktop.xml';
const assertIntegrations = (listing) => { for (const file of integrationFiles) assert.ok(listing.split('\n').some((line) => line.trim().endsWith(file)), `missing ${file}`); };
const assertMimeListing = (listing) => assert.ok(listing.split('\n').some((line) => line.trim().endsWith(mimeFile)), `missing /${mimeFile}`);
const assertIcons = (listing) => { for (const icon of iconFiles) assert.ok(listing.split('\n').some((line) => line.trim().endsWith(icon.slice(1))), `missing ${icon}`); };
const debListing = (file) => {
  const direct = tool('dpkg-deb', ['-c', file]);
  if (direct !== null) return direct;
  const member = tool('ar', ['t', file]).split('\n').find((entry) => entry.startsWith('data.tar'));
  const data = spawnSync('ar', ['p', file, member], { maxBuffer: 1 << 30 }).stdout;
  return spawnSync('bsdtar', ['-tf', '-'], { input: data, encoding: 'utf8', maxBuffer: 64 << 20 }).stdout;
};
const only = (extension) => {
  const found = files.filter((name) => name.endsWith(extension));
  assert.equal(found.length, 1, `expected one ${extension} in ${dist}, found ${found.length}`);
  return found[0];
};

const checks = [];
const check = (label, run) => {
  try { checks.push(`ok    ${label}: ${run()}`); } catch (error) { checks.push(`FAIL  ${label}: ${error.message}`); process.exitCode = 1; }
};

check('deb', () => {
  const name = only('.deb');
  const file = path.join(dist, name);
  let control = tool('dpkg-deb', ['-f', file]);
  if (control === null) {
    const members = tool('ar', ['t', file]).split('\n');
    const member = members.find((entry) => entry.startsWith('control.tar'));
    const bytes = spawnSync('ar', ['p', file, member], { maxBuffer: 64 << 20 }).stdout;
    control = spawnSync('bsdtar', ['-xOf', '-', './control'], { input: bytes, encoding: 'utf8' }).stdout;
  }
  assert.equal(field(control, 'Package'), 'opendoc-desktop');
  assert.equal(field(control, 'Version'), `${version}-${build}`);
  assert.equal(name, `opendoc-desktop_${version}-${build}_amd64.deb`);
  const listing = debListing(file);
  assertIcons(listing);
  assertIntegrations(listing);
  assertMimeListing(listing);
  return `${field(control, 'Version')} (${field(control, 'Architecture')}, Maintainer ${field(control, 'Maintainer')})`;
});

check('pacman', () => {
  const name = only('.pacman');
  const file = path.join(dist, name);
  const text = tool('pacman', ['-Qip', file]) ?? tool('bsdtar', ['-xOf', file, '.PKGINFO']);
  const pkgver = field(text, 'Version') ?? field(text, 'pkgver');
  assert.equal(pkgver, `${version}-${build}`);
  const listing = tool('bsdtar', ['-tf', file]);
  assertIcons(listing);
  assertIntegrations(listing);
  assertMimeListing(listing);
  assert.equal(name, `opendoc-desktop-${version}-${build}-x64.pacman`);
  return pkgver;
});

const rpmName = files.find((entry) => entry.endsWith('.rpm'));
check('rpm', () => {
  const name = rpmName;
  if (!name) {
    if (values['require-rpm']) throw new Error('no .rpm in dist');
    return 'no .rpm in dist (not required without --require-rpm)';
  }
  assert.equal(name, `opendoc-desktop-${version}-${build}.x86_64.rpm`);
  const text = tool('rpm', ['-qip', path.join(dist, name)]);
  if (text === null) {
    if (values['require-rpm']) throw new Error('rpm is not available to read the package');
    return `${name} (name only: rpm is not installed)`;
  }
  assert.equal(field(text, 'Version'), version);
  assert.equal(field(text, 'Release'), build);
  const listing = tool('rpm', ['-qlp', path.join(dist, name)]);
  assertIcons(listing);
  assertIntegrations(listing);
  assertMimeListing(listing);
  return `${field(text, 'Version')}-${field(text, 'Release')}`;
});

check('AppImage', () => {
  const name = only('.AppImage');
  assert.equal(name, 'opendoc-desktop-x86_64.AppImage');
  return name;
});

// What the updater reads from inside each install: the type word, the feed (app-update.yml) and, for the AUR only, the
// marker that switches it off. A file in a package is read straight from its archive (rpm through rpm2cpio).
const debMember = (file, prefix) => tool('ar', ['t', file]).split('\n').find((entry) => entry.startsWith(prefix));
const inPackage = (kind, file, inner) => {
  if (kind === 'deb') {
    const data = spawnSync('ar', ['p', file, debMember(file, 'data.tar')], { maxBuffer: 1 << 30 }).stdout;
    return spawnSync('bsdtar', ['-xOf', '-', `./${inner}`], { input: data, encoding: 'utf8', maxBuffer: 64 << 20 });
  }
  if (kind === 'rpm') {
    const cpio = spawnSync('rpm2cpio', [file], { maxBuffer: 1 << 30 }).stdout;
    return spawnSync('bsdtar', ['-xOf', '-', `./${inner}`], { input: cpio, encoding: 'utf8', maxBuffer: 64 << 20 });
  }
  return spawnSync('bsdtar', ['-xOf', file, inner], { encoding: 'utf8', maxBuffer: 64 << 20 });
};
// One member's line from the archive's verbose listing: the mode and the owner, which `check` needs for the update helper.
const memberLine = (kind, file, inner) => {
  let listing;
  if (kind === 'deb') listing = spawnSync('bsdtar', ['-tvf', '-'], { input: spawnSync('ar', ['p', file, debMember(file, 'data.tar')], { maxBuffer: 1 << 30 }).stdout, encoding: 'utf8', maxBuffer: 64 << 20 }).stdout;
  else if (kind === 'rpm') listing = spawnSync('bsdtar', ['-tvf', '-'], { input: spawnSync('rpm2cpio', [file], { maxBuffer: 1 << 30 }).stdout, encoding: 'utf8', maxBuffer: 64 << 20 }).stdout;
  else listing = spawnSync('bsdtar', ['-tvf', file], { encoding: 'utf8', maxBuffer: 64 << 20 }).stdout;
  const line = listing.split('\n').find((entry) => entry.endsWith(` ${inner}`) || entry.endsWith(` ./${inner}`));
  const match = line?.match(/^(\S+)\s+\d+\s+(\S+)\s+(\S+)\s+\d+ /);
  return match ? { mode: match[1], owner: match[2], group: match[3] } : null;
};

// The password prompt for an update (deb, rpm and pacman): a polkit action that names a root-owned helper, both installed by the
// package. The policy's exec path must be the helper's installed path, or polkit shows the command line instead of the message.
const policyRelative = 'usr/share/polkit-1/actions/io.github.ryanyahya.opendocdesktop.install-update.policy';
const helperRelative = 'opt/opendoc-desktop/resources/updater/install-update';
const policySource = readFileSync(path.join(desktop, 'resources', 'polkit', path.basename(policyRelative)), 'utf8');
const helperSource = readFileSync(path.join(desktop, 'resources', 'updater', 'install-update'), 'utf8');
for (const [kind, extension] of [['deb', '.deb'], ['pacman', '.pacman'], ['rpm', '.rpm']]) {
  check(`${kind} update prompt`, () => {
    const name = files.find((entry) => entry.endsWith(extension));
    if (!name && kind === 'rpm' && !values['require-rpm']) return 'no .rpm in dist (not required without --require-rpm)';
    if (!name) throw new Error(`no ${extension} in dist`);
    const file = path.join(dist, name);
    assert.equal(inPackage(kind, file, policyRelative).stdout, policySource, 'the installed polkit policy differs from resources/polkit');
    const execPath = policySource.match(/<annotate key="org\.freedesktop\.policykit\.exec\.path">([^<]*)</)[1];
    assert.equal(execPath, `/${helperRelative}`, 'the policy must name the helper\'s installed path');
    assert.equal(inPackage(kind, file, helperRelative).stdout, helperSource, 'the installed helper differs from resources/updater/install-update');
    const policy = memberLine(kind, file, policyRelative);
    assert.ok(policy && /^-rw-r--r--$/.test(policy.mode) && /^(0|root)$/.test(policy.owner), `the policy must be a root-owned 0644 file (found ${JSON.stringify(policy)})`);
    const helper = memberLine(kind, file, helperRelative);
    assert.ok(helper && helper.mode === '-rwxr-xr-x' && /^(0|root)$/.test(helper.owner) && /^(0|root)$/.test(helper.group), `the helper must be a root-owned 0755 file (found ${JSON.stringify(helper)})`);
    return `action ${execPath} (policy 0644, helper 0755, both root-owned)`;
  });
}

for (const [kind, extension] of [['deb', '.deb'], ['pacman', '.pacman'], ['rpm', '.rpm']]) {
  check(`${kind} update files`, () => {
    const name = files.find((entry) => entry.endsWith(extension));
    if (!name && kind === 'rpm' && !values['require-rpm']) return 'no .rpm in dist (not required without --require-rpm)';
    if (!name) throw new Error(`no ${extension} in dist`);
    const file = path.join(dist, name);
    const type = inPackage(kind, file, 'opt/opendoc-desktop/resources/package-type');
    assert.equal(type.stdout.trim(), kind, `package-type: ${type.stdout.trim() || type.stderr.trim()}`);
    const feed = inPackage(kind, file, 'opt/opendoc-desktop/resources/app-update.yml').stdout;
    assert.match(feed, /^provider: github$/m);
    assert.match(feed, /^owner: .+$/m);
    const marker = inPackage(kind, file, 'opt/opendoc-desktop/resources/update-disabled');
    assert.notEqual(marker.status, 0, 'the updater-off marker must not ship in this package (only the AUR package adds it)');
    return `package-type ${kind}, app-update.yml (github), no update-disabled`;
  });
}

// The design pack file type: the shared-mime entry is the repository's own file, and the .desktop file names its type, so a
// double-click on a *.opendoc.zip offers this app.
const mimeSource = readFileSync(path.join(desktop, 'resources', 'mime', 'opendoc-desktop.xml'), 'utf8');
const mimeType = mimeSource.match(/<mime-type type="([^"]+)"/)[1];
for (const [kind, extension] of [['deb', '.deb'], ['pacman', '.pacman'], ['rpm', '.rpm']]) {
  check(`${kind} file type`, () => {
    const name = files.find((entry) => entry.endsWith(extension));
    if (!name && kind === 'rpm' && !values['require-rpm']) return 'no .rpm in dist (not required without --require-rpm)';
    if (!name) throw new Error(`no ${extension} in dist`);
    const file = path.join(dist, name);
    assert.equal(inPackage(kind, file, mimeFile).stdout, mimeSource, 'the installed shared-mime entry differs from resources/mime/opendoc-desktop.xml');
    const entry = inPackage(kind, file, 'usr/share/applications/opendoc-desktop.desktop').stdout;
    assert.equal(field(entry, 'MimeType'), `${mimeType};`);
    assert.match(field(entry, 'Exec'), / %U$/, 'Exec must pass the opened file (%U)');
    return `${mimeType} for *.opendoc.zip, MimeType and %U in the .desktop file`;
  });
}

check('AppImage update files', () => {
  const name = only('.AppImage');
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'opendoc-appimage-'));
  try {
    // The AppImage runtime's own extract flag: it unpacks files and starts nothing.
    const extract = spawnSync(path.join(dist, name), ['--appimage-extract', 'resources/app-update.yml'], { cwd: scratch, encoding: 'utf8', timeout: 120_000 });
    assert.equal(extract.status, 0, extract.stderr);
    const feed = readFileSync(path.join(scratch, 'squashfs-root', 'resources', 'app-update.yml'), 'utf8');
    assert.match(feed, /^provider: github$/m);
    assert.ok(!existsSync(path.join(scratch, 'squashfs-root', 'resources', 'package-type')), 'an AppImage has no package-type (the updater uses $APPIMAGE)');
    // The desktop entry inside the image names the type (an AppImage cannot install the shared-mime entry itself; docs/DESKTOP.md).
    const entry = spawnSync(path.join(dist, name), ['--appimage-extract', 'opendoc-desktop.desktop'], { cwd: scratch, encoding: 'utf8', timeout: 120_000 });
    assert.equal(entry.status, 0, entry.stderr);
    assert.equal(field(readFileSync(path.join(scratch, 'squashfs-root', 'opendoc-desktop.desktop'), 'utf8'), 'MimeType'), `${mimeType};`);
    return 'app-update.yml (github), no package-type, MimeType in the desktop entry';
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

check('latest-linux.yml', () => {
  const text = readFileSync(path.join(dist, 'latest-linux.yml'), 'utf8');
  assert.equal(field(text, 'version'), version);
  assert.equal(field(text, 'build'), build);
  assert.equal(field(text, 'commit'), info.commit);
  // The updater only offers a file whose entry exists, so every installer needs one, with the file's real size and SHA-512.
  const entries = [...text.matchAll(/^ {2}- url: (.*)\n {4}sha512: (.*)\n {4}size: (\d+)/gm)].map((match) => ({ url: match[1], sha512: match[2], size: Number(match[3]) }));
  for (const extension of ['.deb', '.pacman', '.rpm', '.AppImage']) {
    if (extension === '.rpm' && !rpmName && !values['require-rpm']) { assert.ok(!entries.some((candidate) => candidate.url.endsWith('.rpm')), 'an .rpm is listed that is not in dist'); continue; }
    const entry = entries.find((candidate) => candidate.url.endsWith(extension));
    assert.ok(entry, `no ${extension} listed`);
    const bytes = readFileSync(path.join(dist, entry.url));
    assert.equal(entry.size, bytes.length, `${entry.url}: size`);
    assert.equal(entry.sha512, createHash('sha512').update(bytes).digest('base64'), `${entry.url}: sha512`);
  }
  assert.equal(field(text, 'path'), 'opendoc-desktop-x86_64.AppImage');
  return `build ${build}, commit ${info.commit.slice(0, 12)}, ${entries.length} files with sha512 and size, all matching`;
});

console.log(checks.join('\n'));
