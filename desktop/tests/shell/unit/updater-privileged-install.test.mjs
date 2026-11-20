// Installing a deb, rpm or pacman file with one asynchronous pkexec call: the command lines, the checksum check done as
// root on a copy, and what exit codes 126 and 127 mean. A fake pkexec first on PATH runs the real script with fake package tools.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { actionId, checksumExitCode, classifyExit, findHelper, helperRelativePath, installCommands, installPackage, installScript, manualCommand, pkexecArguments, policyFile, safePath, sha512Hex } from '../../../src/main/updater/privileged-install.mjs';
import { fakeTools, scratch } from '../support/updater.mjs';

const resources = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'resources');
const helperSource = join(resources, 'updater', 'install-update');
const policySource = join(resources, 'polkit', `${actionId}.policy`);

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

// The packaged app's install: a root-owned helper that a polkit action names, so the password prompt shows a sentence (not the
// script). The same checks and exit codes as the script the fallback passes to /bin/sh -c.

const installedResources = '/opt/opendoc-desktop/resources';
const rootFile = { isFile: () => true, uid: 0, mode: 0o100755 };

test('with the helper, pkexec gets the helper path and the three arguments, not a script', async () => {
  const { file, sha512 } = await packageFile();
  const helper = join(installedResources, helperRelativePath);
  assert.deepEqual(pkexecArguments({ type: 'deb', file, sha512, helper }), ['--disable-internal-agent', helper, file, sha512Hex(sha512), 'deb']);
  assert.equal(pkexecArguments({ type: 'pacman', file: '/x/y.pacman', sha512, helper }).at(-1), 'pacman');
  assert.throws(() => pkexecArguments({ type: 'snap', file, sha512, helper }), /No installer/);
  assert.throws(() => pkexecArguments({ type: 'deb', file: 'relative.deb', sha512, helper }), /absolute/);
  assert.throws(() => pkexecArguments({ type: 'deb', file, sha512: 'nope', helper }), /SHA-512/);
});

test('the repository policy names the action and the helper path the packages install, and the app looks there', async () => {
  const policy = await readFile(policySource, 'utf8');
  assert.match(policy, new RegExp(`<action id="${actionId}">`));
  assert.equal(actionId, actionId.toLowerCase());
  assert.equal(policyFile, `/usr/share/polkit-1/actions/${actionId}.policy`);
  assert.match(policy, /<message>Authentication is required to install an OpenDoc Desktop update\.<\/message>/);
  for (const key of ['allow_any', 'allow_inactive', 'allow_active']) assert.match(policy, new RegExp(`<${key}>auth_admin</${key}>`), key);
  assert.doesNotMatch(policy, /auth_admin_keep|<allow_[a-z_]+>(yes|auth_self|auth_self_keep)</, 'always the admin password, never remembered');
  assert.deepEqual([...policy.matchAll(/<annotate key="([^"]+)">([^<]*)</g)].map(match => [match[1], match[2]]), [['org.freedesktop.policykit.exec.path', join(installedResources, helperRelativePath)]]);
  // The check the app makes, against the repository's own policy text.
  const found = await findHelper({ resourcesPath: installedResources, readText: async path => { assert.equal(path, policyFile); return policy; }, statFile: async () => rootFile });
  assert.equal(found, join(installedResources, helperRelativePath));
});

test('the helper is used only when it and its policy are both installed, agree, and are root-owned', async () => {
  const policy = await readFile(policySource, 'utf8');
  const helper = join(installedResources, helperRelativePath);
  const find = (overrides = {}) => findHelper({ resourcesPath: installedResources, readText: async () => policy, statFile: async () => rootFile, ...overrides });
  assert.equal(await find(), helper);
  assert.equal(await find({ statFile: async () => ({ ...rootFile, uid: 1000 }) }), null, 'owned by a user');
  assert.equal(await find({ statFile: async () => ({ ...rootFile, mode: 0o100775 }) }), null, 'group-writable');
  assert.equal(await find({ statFile: async () => ({ ...rootFile, mode: 0o100757 }) }), null, 'world-writable');
  assert.equal(await find({ statFile: async () => ({ ...rootFile, mode: 0o100644 }) }), null, 'not executable');
  assert.equal(await find({ statFile: async () => ({ ...rootFile, isFile: () => false }) }), null, 'not a file');
  assert.equal(await find({ statFile: async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); } }), null, 'helper missing');
  assert.equal(await find({ readText: async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); } }), null, 'policy missing');
  assert.equal(await find({ readText: async () => policy.replace(helper, '/usr/lib/other/install-update') }), null, 'the policy names another file');
  assert.equal(await find({ readText: async () => policy.replace(`<action id="${actionId}">`, '<action id="org.example.other">') }), null, 'the policy has another action');
  assert.equal(await find({ readText: async () => '<policyconfig/>' }), null, 'an empty policy');
  assert.equal(await find({ resourcesPath: undefined }), null, 'not an Electron run');
  assert.equal(await find({ resourcesPath: 'relative/resources' }), null);
});

test('an unpackaged run, or an install without the helper, keeps the /bin/sh -c call', async () => {
  const tools = await fakeTools();
  const { file, sha512 } = await packageFile();
  // Nothing installed at this process's resources path (there is none outside Electron): the fallback.
  assert.equal((await installPackage({ type: 'deb', file, sha512, env: tools.env() })).outcome, 'installed');
  assert.equal((await installPackage({ type: 'deb', file, sha512, env: tools.env(), helper: null })).outcome, 'installed');
  for (const call of await tools.calls('pkexec')) assert.deepEqual(call.slice(0, 3), ['--disable-internal-agent', '/bin/sh', '-c']);
  assert.equal((await tools.calls('pkexec')).length, 2);
});

test('the shipped helper is a root-run script: executable, a shell shebang, no bash-isms', async () => {
  const info = await stat(helperSource);
  assert.equal(info.mode & 0o777, 0o755);
  const text = await readFile(helperSource, 'utf8');
  assert.ok(text.startsWith('#!/bin/sh\n'));
  assert.equal(spawnSync('/bin/sh', ['-n', helperSource], { encoding: 'utf8' }).status, 0);
  assert.doesNotMatch(text, /\[\[|\bsource\b|\$\{[A-Za-z_]+\/|<\(/, 'POSIX sh only (it runs under /bin/sh, which is dash on Debian)');
  assert.doesNotMatch(text.replace(/^#.*$/gm, ''), /\bPATH=/, 'pkexec sets a safe PATH; the helper must not take one from the caller');
});

test('the helper installs with the same commands as the fallback script, for every type', async () => {
  const text = (await readFile(helperSource, 'utf8')).replace(/\s+/g, ' ');
  for (const type of ['deb', 'rpm', 'pacman']) {
    const command = installCommands[type].replace(/\s+/g, ' ');
    assert.ok(text.includes(command), `${type}: the helper's install step differs from privileged-install.mjs`);
  }
  // The checksum failure and the remapping of 126 and 127 are the script's too.
  assert.match(text, new RegExp(`exit ${checksumExitCode}`));
  assert.match(installScript('deb'), new RegExp(`exit ${checksumExitCode}`));
  assert.ok(text.includes('if [ "$status" -eq 126 ] || [ "$status" -eq 127 ]; then status=1; fi'));
  assert.ok(installScript('deb').includes('if [ "$status" -eq 126 ] || [ "$status" -eq 127 ]; then status=1; fi'));
});

async function viaHelper(extra = {}, { type = 'deb', name, tools } = {}) {
  tools ??= await fakeTools();
  const { file, sha512 } = await packageFile(name);
  const result = await installPackage({ type, file, sha512, env: tools.env(extra), helper: helperSource });
  return { tools, file, sha512, result };
}

test('through the helper: one pkexec call with the helper, the checked copy is installed', async () => {
  const { tools, file, sha512, result } = await viaHelper();
  assert.equal(result.outcome, 'installed');
  const [call, ...more] = await tools.calls('pkexec');
  assert.deepEqual(more, []);
  assert.deepEqual(call, ['--disable-internal-agent', helperSource, file, sha512Hex(sha512), 'deb']);
  const [dpkg] = await tools.calls('dpkg');
  assert.equal(dpkg[0], '-i');
  assert.notEqual(dpkg[1], file, 'the copy is installed, not the file in the user cache');
  assert.match(dpkg[1], /update\.deb$/);
});

test('through the helper: the exit codes are the script\'s', async () => {
  const fall = await viaHelper({ FAKE_DPKG_EXIT: '1' });
  assert.equal(fall.result.outcome, 'installed');
  assert.deepEqual(await fall.tools.calls('apt-get'), [['install', '-f', '-y']]);
  const failed = await viaHelper({ FAKE_DPKG_EXIT: '1', FAKE_APT_GET_EXIT: '100' });
  assert.deepEqual([failed.result.outcome, failed.result.reason, failed.result.code], ['failed', 'install', 100]);
  const missing = await viaHelper({ FAKE_DPKG_EXIT: '127', FAKE_APT_GET_EXIT: '127' });
  assert.deepEqual([missing.result.outcome, missing.result.code], ['failed', 1], 'a missing tool is a failure, never "dismissed"');
  for (const code of ['126', '127']) assert.equal((await viaHelper({ FAKE_PKEXEC_EXIT: code })).result.outcome, 'cancelled', code);
});

test('through the helper: a wrong or swapped file is never installed (exit 70)', async () => {
  const tools = await fakeTools();
  const { file } = await packageFile();
  const wrong = await installPackage({ type: 'deb', file, sha512: base64('another file'), env: tools.env(), helper: helperSource });
  assert.deepEqual([wrong.outcome, wrong.reason, wrong.code], ['failed', 'checksum', checksumExitCode]);
  const { file: second, sha512 } = await packageFile();
  await writeFile(second, 'swapped by another program');
  assert.equal((await installPackage({ type: 'deb', file: second, sha512, env: tools.env(), helper: helperSource })).reason, 'checksum');
  assert.deepEqual(await tools.calls('dpkg'), []);
});

test('through the helper: rpm and pacman use their own tools', async () => {
  const arch = await fakeTools(['pkexec', 'pacman']);
  assert.equal((await viaHelper({}, { type: 'pacman', name: 'opendoc-desktop-0.6.1-2-x86_64.pacman', tools: arch })).result.outcome, 'installed');
  assert.deepEqual((await arch.calls('pacman'))[0].slice(0, 2), ['-U', '--noconfirm']);
  const suse = await fakeTools(['pkexec', 'zypper', 'dnf']);
  assert.equal((await viaHelper({}, { type: 'rpm', name: 'opendoc-desktop-0.6.1-2.x86_64.rpm', tools: suse })).result.outcome, 'installed');
  assert.equal((await suse.calls('zypper')).length, 1);
  assert.deepEqual(await suse.calls('dnf'), []);
});

test('the helper refuses anything but exactly its three arguments, and installs nothing', async () => {
  const tools = await fakeTools();
  const { file, sha512 } = await packageFile();
  const hex = sha512Hex(sha512);
  const folder = await scratch('helper-input');
  await mkdir(join(folder, 'dir.deb'));
  await symlink(file, join(folder, 'link.deb'));
  await writeFile(join(folder, 'a\nb.deb'), 'x');
  await writeFile(join(folder, 'plain.deb'), 'x');
  const cases = [
    ['no arguments', []],
    ['two arguments', [file, hex]],
    ['four arguments', [file, hex, 'deb', 'extra']],
    ['an unknown type', [file, hex, 'snap']],
    ['an empty type', [file, hex, '']],
    ['an option instead of a type', [file, hex, '-i']],
    ['a short checksum', [file, hex.slice(1), 'deb']],
    ['a long checksum', [file, `${hex}0`, 'deb']],
    ['an uppercase checksum', [file, hex.toUpperCase(), 'deb']],
    ['a non-hex checksum', [file, `${hex.slice(1)}g`, 'deb']],
    ['a checksum with a space', [file, `${hex.slice(2)} ab`, 'deb']],
    ['a relative path', ['plain.deb', hex, 'deb']],
    ['a path that does not end in the type', [file, hex, 'rpm']],
    ['a line break in the name', [join(folder, 'a\nb.deb'), hex, 'deb']],
    ['a missing file', [join(folder, 'missing.deb'), hex, 'deb']],
    ['a folder', [join(folder, 'dir.deb'), hex, 'deb']],
    ['a link', [join(folder, 'link.deb'), hex, 'deb']],
  ];
  for (const [label, args] of cases) {
    const run = spawnSync('/bin/sh', [helperSource, ...args], { encoding: 'utf8', env: tools.env() });
    assert.equal(run.status, 64, `${label}: exit ${run.status} ${run.stderr}`);
    assert.match(run.stderr, /^opendoc-desktop: /, label);
  }
  assert.deepEqual(await tools.calls('dpkg'), []);
  assert.deepEqual(await tools.calls('apt-get'), []);
  assert.deepEqual(await tools.calls('pacman'), []);
});

test('the helper leaves no copy behind', async () => {
  const tools = await fakeTools();
  const temp = await scratch('helper-tmp');
  const before = spawnSync('/bin/sh', ['-c', `ls "${temp}" | wc -l`], { encoding: 'utf8' }).stdout.trim();
  await viaHelper({ TMPDIR: temp }, { tools });
  await viaHelper({ TMPDIR: temp, FAKE_DPKG_EXIT: '1', FAKE_APT_GET_EXIT: '100' }, { tools });
  const after = spawnSync('/bin/sh', ['-c', `ls "${temp}" | wc -l`], { encoding: 'utf8' }).stdout.trim();
  assert.equal(after, before);
});
