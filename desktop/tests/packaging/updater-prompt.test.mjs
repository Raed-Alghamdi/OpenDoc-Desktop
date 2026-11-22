// The clean password prompt for an update (deb, rpm and pacman): a polkit action, the root-owned helper it names, and the three
// packages that install both. The app side is tests/shell/unit/updater-privileged-install.test.mjs; the built packages are checked by
// check-artifacts.mjs. Reads the config and the files it names.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { actionId, helperRelativePath, policyFile } from '../../src/main/updater/privileged-install.mjs';
import { builderConfig, desktop } from './builder-support.mjs';

const config = builderConfig();
const policyName = `${actionId}.policy`;
const policyPath = path.join(desktop, 'resources', 'polkit', policyName);
const helperPath = path.join(desktop, 'resources', 'updater', 'install-update');
const installedHelper = path.posix.join('/opt/opendoc-desktop/resources', ...helperRelativePath.split(path.sep));

test('the helper and the release key are shipped for Linux only, into resources/updater, next to the other extra resources', () => {
  assert.deepEqual(config.linux.extraResources, [{ from: 'resources/updater', to: 'updater', filter: ['install-update', 'release-key.pem'] }]);
  assert.equal(config.mac.extraResources, undefined, 'a Mac app has no pkexec');
  assert.ok(!config.extraResources.some((entry) => /updater/.test(entry.to)), 'the top-level list reaches every platform');
  assert.ok(config.extraResources.some((entry) => entry.to === 'runtime'), 'the runtime entries stay');
  assert.equal(installedHelper, '/opt/opendoc-desktop/resources/updater/install-update');
  assert.ok(statSync(helperPath).mode & 0o100, 'the helper is executable in the repository (extraResources keeps the mode)');
});

test('deb, pacman and rpm install the policy where polkit reads it', () => {
  for (const target of ['deb', 'pacman', 'rpm']) {
    const mapped = config[target].fpm.filter((entry) => entry.endsWith(`=${policyFile}`));
    assert.deepEqual(mapped, [`resources/polkit/${policyName}=${policyFile}`], target);
  }
  assert.equal(policyFile, `/usr/share/polkit-1/actions/${policyName}`);
});

test('the policy: one action, the admin password every time, the sentence, and the helper\'s installed path', () => {
  const policy = readFileSync(policyPath, 'utf8');
  const lint = spawnSync('xmllint', ['--noout', policyPath], { encoding: 'utf8' });
  if (!lint.error) assert.equal(lint.status, 0, lint.stderr);
  assert.equal(actionId, 'io.github.ryanyahya.opendocdesktop.install-update', 'polkit wants lowercase ids');
  assert.deepEqual([...policy.matchAll(/<action id="([^"]+)"/g)].map((match) => match[1]), [actionId]);
  assert.match(policy, /<message>Authentication is required to install an OpenDoc Desktop update\.<\/message>/);
  assert.deepEqual([...policy.matchAll(/<(allow_[a-z]+)>([^<]*)</g)].map((match) => [match[1], match[2]]), [['allow_any', 'auth_admin'], ['allow_inactive', 'auth_admin'], ['allow_active', 'auth_admin']]);
  assert.deepEqual([...policy.matchAll(/<annotate key="([^"]+)">([^<]*)</g)].map((match) => [match[1], match[2]]), [['org.freedesktop.policykit.exec.path', installedHelper]]);
  assert.doesNotMatch(policy, /allow_gui|_keep/);
});

test('the AUR package leaves the helper and the policy out: its updater is off, so nothing would run them', () => {
  const pkgbuild = readFileSync(path.join(desktop, 'aur', 'PKGBUILD'), 'utf8');
  const extract = pkgbuild.match(/bsdtar -xpf[\s\S]*?\n\n/)[0];
  assert.match(extract, /--exclude='usr\/share\/polkit-1'/);
  assert.match(extract, /--exclude='opt\/opendoc-desktop\/resources\/updater'/);
  assert.match(pkgbuild, /resources\/update-disabled/);
});

test('openssl is a dependency of the deb, rpm and pacman packages and of the AUR package, which check an update signature with it', () => {
  for (const target of ['deb', 'rpm', 'pacman']) assert.ok(config[target].depends.includes('openssl'), target);
  // deb and rpm keep electron-builder's own default dependencies (setting `depends` replaces them).
  assert.ok(['libgtk-3-0', 'libnss3', 'xdg-utils', 'libatspi2.0-0'].every((name) => config.deb.depends.includes(name)));
  assert.ok(['gtk3', 'nss', 'xdg-utils', 'at-spi2-core', '(libXtst or libXtst6)'].every((name) => config.rpm.depends.includes(name)));
  const pkgbuild = readFileSync(path.join(desktop, 'aur', 'PKGBUILD'), 'utf8');
  assert.match(pkgbuild, /^depends=\(.*\bopenssl\b.*\)$/m);
  assert.match(readFileSync(path.join(desktop, 'aur', '.SRCINFO'), 'utf8'), /^\tdepends = openssl$/m);
});

test('the release key in the repository is the SPKI public key the helper reads, and the helper looks for it in its own folder', () => {
  const key = readFileSync(path.join(desktop, 'resources', 'updater', 'release-key.pem'), 'utf8');
  assert.match(key, /^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+-----END PUBLIC KEY-----\n$/);
  assert.match(readFileSync(helperPath, 'utf8'), /^key=\$\(dirname -- "\$0"\)\/release-key\.pem$/m);
});
