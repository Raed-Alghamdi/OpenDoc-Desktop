// Installing a deb, rpm or pacman file with one asynchronous pkexec call: the command lines, the checksum check done as
// root on a copy, and what exit codes 126 and 127 mean. A fake pkexec first on PATH runs the real script with fake package tools.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { checksumExitCode, classifyExit, installPackage, installScript, manualCommand, pkexecArguments, safePath, sha512Hex } from '../../../src/main/updater/privileged-install.mjs';
import { fakeTools, scratch } from '../support/updater.mjs';

const base64 = bytes => createHash('sha512').update(bytes).digest('base64');

async function packageFile(name = 'opendoc-desktop_0.6.1-2_amd64.deb', bytes = 'package bytes') {
  const folder = await scratch('package');
  const file = join(folder, name);
  await writeFile(file, bytes);
  return { file, sha512: base64(bytes) };
}

test('the sha512 from the metadata (base64) becomes the hex that sha512sum prints', () => {
  const sum = createHash('sha512').update('x').digest();
  assert.equal(sha512Hex(sum.toString('base64')), sum.toString('hex'));
  for (const bad of [undefined, null, '', 'abc', 'AAAA', Buffer.alloc(32).toString('base64'), `${sum.toString('base64')}x`]) assert.equal(sha512Hex(bad), null, String(bad));
});

test('the pkexec command line: one call, no internal agent, the file, its hex checksum and its extension as arguments', async () => {
  const { file, sha512 } = await packageFile();
  const args = pkexecArguments({ type: 'deb', file, sha512 });
  assert.deepEqual([args[0], args[1], args[2]], ['--disable-internal-agent', '/bin/sh', '-c']);
  assert.equal(args[3], installScript('deb'));
  assert.deepEqual(args.slice(4), ['opendoc-desktop-update', file, sha512Hex(sha512), 'deb']);
  assert.throws(() => pkexecArguments({ type: 'deb', file: 'relative.deb', sha512 }), /absolute/);
  assert.throws(() => pkexecArguments({ type: 'deb', file, sha512: 'nope' }), /SHA-512/);
  assert.throws(() => installScript('snap'), /No installer/);
});

test('the install step of each type', () => {
  assert.match(installScript('deb'), /dpkg -i "\$pkg" \|\| apt-get install -f -y/);
  assert.match(installScript('pacman'), /pacman -U --noconfirm "\$pkg"/);
  const rpm = installScript('rpm');
  for (const part of ['zypper --non-interactive --no-refresh install --allow-unsigned-rpm -f "$pkg"', 'dnf install --nogpgcheck -y "$pkg"', 'yum install --nogpgcheck -y "$pkg"', 'rpm -Uvh --replacepkgs --replacefiles --nodeps "$pkg"']) assert.ok(rpm.includes(part), part);
  assert.doesNotMatch(installScript('pacman'), /-Sy/, 'never a partial upgrade');
});

test('a deb is installed with dpkg, after being copied and checked, in one pkexec call', async () => {
  const tools = await fakeTools();
  const { file, sha512 } = await packageFile();
  const result = await installPackage({ type: 'deb', file, sha512, env: tools.env() });
  assert.equal(result.outcome, 'installed');
  assert.equal((await tools.calls('pkexec')).length, 1);
  const dpkg = await tools.calls('dpkg');
  assert.equal(dpkg.length, 1);
  assert.equal(dpkg[0][0], '-i');
  assert.notEqual(dpkg[0][1], file, 'the copy is installed, not the file in the user cache');
  assert.match(dpkg[0][1], /update\.deb$/);
  assert.deepEqual(await tools.calls('apt-get'), []);
});

test('a failed dpkg falls through to apt-get install -f -y inside the same pkexec call (no second prompt)', async () => {
  const tools = await fakeTools();
  const { file, sha512 } = await packageFile();
  const result = await installPackage({ type: 'deb', file, sha512, env: tools.env({ FAKE_DPKG_EXIT: '1' }) });
  assert.equal(result.outcome, 'installed');
  assert.deepEqual(await tools.calls('apt-get'), [['install', '-f', '-y']]);
  assert.equal((await tools.calls('pkexec')).length, 1);
});

test('when dpkg and apt-get both fail the install failed, with what they printed', async () => {
  const tools = await fakeTools();
  const { file, sha512 } = await packageFile();
  const result = await installPackage({ type: 'deb', file, sha512, env: tools.env({ FAKE_DPKG_EXIT: '1', FAKE_APT_GET_EXIT: '100' }) });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.reason, 'install');
  assert.equal(result.code, 100);
});

test('a file whose checksum is wrong is never installed, even though it was downloaded', async () => {
  const tools = await fakeTools();
  const { file } = await packageFile();
  const result = await installPackage({ type: 'deb', file, sha512: base64('another file'), env: tools.env() });
  assert.deepEqual([result.outcome, result.reason, result.code], ['failed', 'checksum', checksumExitCode]);
  assert.deepEqual(await tools.calls('dpkg'), []);
  assert.deepEqual(await tools.calls('apt-get'), []);
});

test('a file changed after the download is caught when root checks the copy', async () => {
  const tools = await fakeTools();
  const { file, sha512 } = await packageFile();
  await writeFile(file, 'swapped by another program');
  const result = await installPackage({ type: 'deb', file, sha512, env: tools.env() });
  assert.equal(result.reason, 'checksum');
  assert.deepEqual(await tools.calls('dpkg'), []);
});

test('exit 126 and 127 from pkexec mean "Update cancelled": the prompt was dismissed, nothing ran', async () => {
  const tools = await fakeTools();
  const { file, sha512 } = await packageFile();
  for (const code of ['126', '127']) {
    const result = await installPackage({ type: 'deb', file, sha512, env: tools.env({ FAKE_PKEXEC_EXIT: code }) });
    assert.equal(result.outcome, 'cancelled', code);
    assert.equal(result.code, Number(code));
  }
  assert.deepEqual(await tools.calls('dpkg'), []);
  assert.equal((await tools.calls('pkexec')).length, 2, 'one prompt for each try, never a second one after Cancel');
});

test('a tool that is missing inside the script (exit 127) is a failure, not a cancel', async () => {
  const tools = await fakeTools();
  const { file, sha512 } = await packageFile();
  const result = await installPackage({ type: 'deb', file, sha512, env: tools.env({ FAKE_DPKG_EXIT: '127', FAKE_APT_GET_EXIT: '127' }) });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.code, 1);
});

test('exit 127 with "no authentication agent" is a failure with a reason, not a cancel', () => {
  assert.equal(classifyExit(127, 'Error getting authority: No authentication agent found.').reason, 'no-agent');
  assert.equal(classifyExit(127, 'Error: dismissed').outcome, 'cancelled');
  assert.equal(classifyExit(126, '').outcome, 'cancelled');
  assert.equal(classifyExit(0, '').outcome, 'installed');
  assert.equal(classifyExit(1, 'line one\nline two').message, 'line one\nline two');
  assert.match(classifyExit(2, '').message, /code 2/);
});

test('pkexec missing from PATH is a failure that says so', async () => {
  const tools = await fakeTools(['dpkg']);
  const { file, sha512 } = await packageFile();
  const result = await installPackage({ type: 'deb', file, sha512, env: tools.env() });
  assert.deepEqual([result.outcome, result.reason], ['failed', 'no-pkexec']);
  assert.match(result.message, /pkexec was not found/);
});

test('the install does not block the event loop while the prompt is open', async () => {
  const tools = await fakeTools();
  const { file, sha512 } = await packageFile();
  // A pkexec that waits (the user typing a password) for a moment.
  await writeFile(join(tools.bin, 'pkexec'), '#!/bin/sh\nsleep 0.6\nexit 126\n', { mode: 0o755 });
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 50);
  const result = await installPackage({ type: 'deb', file, sha512, env: tools.env() });
  clearInterval(timer);
  assert.equal(result.outcome, 'cancelled');
  assert.ok(ticks >= 6, `the event loop kept running (${ticks} ticks while pkexec waited)`);
});

test('rpm and pacman packages go through the same single call with their own tools', async () => {
  const pacman = await fakeTools(['pkexec', 'pacman']);
  const arch = await packageFile('opendoc-desktop-0.6.1-2-x86_64.pacman');
  assert.equal((await installPackage({ type: 'pacman', ...arch, env: pacman.env() })).outcome, 'installed');
  const [call] = await pacman.calls('pacman');
  assert.deepEqual(call.slice(0, 2), ['-U', '--noconfirm']);
  assert.match(call[2], /update\.pacman$/);

  const rpm = await fakeTools(['pkexec', 'dnf']);
  const fedora = await packageFile('opendoc-desktop-0.6.1-2.x86_64.rpm');
  assert.equal((await installPackage({ type: 'rpm', ...fedora, env: rpm.env() })).outcome, 'installed');
  assert.deepEqual((await rpm.calls('dnf'))[0].slice(0, 3), ['install', '--nogpgcheck', '-y']);

  const suse = await fakeTools(['pkexec', 'zypper', 'dnf']);
  await installPackage({ type: 'rpm', ...fedora, env: suse.env() });
  assert.equal((await suse.calls('zypper')).length, 1, 'zypper comes first');
  assert.deepEqual(await suse.calls('dnf'), []);
});

test('the PATH pkexec is found on has no relative entries', () => {
  assert.equal(safePath('/usr/bin::bin:./x:/opt/y'), '/usr/bin:/opt/y');
  assert.equal(safePath(undefined), '');
});

test('a line to install the downloaded file by hand, quoted for the shell', () => {
  assert.equal(manualCommand('deb', "/home/a b/it's.deb"), `sudo apt install '/home/a b/it'\\''s.deb'`);
  assert.equal(manualCommand('rpm', '/x.rpm'), "sudo dnf install '/x.rpm'");
  assert.equal(manualCommand('pacman', '/x.pacman'), "sudo pacman -U '/x.pacman'");
  assert.equal(manualCommand('appimage', '/x'), null);
});
