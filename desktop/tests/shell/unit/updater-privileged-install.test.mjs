// Installing a deb, rpm or pacman file with one asynchronous pkexec call: the command lines, the checksum and signature checks done as
// root on a copy, and what exit codes 126 and 127 mean. A fake pkexec first on PATH runs the real script with fake package tools
// and the real openssl; the files are signed with a throwaway key, whose public half stands where the release key stands.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { actionId, checksumExitCode, classifyExit, findHelper, helperRelativePath, installCommands, installPackage, installScript, keyRelativePath, manualCommand, opensslExitCode, pkexecArguments, policyFile, readReleaseKey, safePath, sha512Hex, signatureExitCode } from '../../../src/main/updater/privileged-install.mjs';
import { fakeTools, scratch, testReleaseKey } from '../support/updater.mjs';

const resources = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'resources');
const helperSource = join(resources, 'updater', 'install-update');
const policySource = join(resources, 'polkit', `${actionId}.policy`);

const base64 = bytes => createHash('sha512').update(bytes).digest('base64');

const releaseKey = testReleaseKey();
/** The fallback script with the test key's public half in it. */
const install = options => installPackage({ publicKey: releaseKey.publicPem, ...options });
let installedHelper = null;
/** The real helper in a folder of its own with the test key beside it (where the production helper looks). */
const helperPath = async () => installedHelper ??= join(await releaseKey.helperFolder(), 'install-update');

async function packageFile(name = 'opendoc-desktop_0.6.1-2_amd64.deb', bytes = 'package bytes') {
  const folder = await scratch('package');
  const file = join(folder, name);
  await writeFile(file, bytes);
  await writeFile(`${file}.sig`, releaseKey.sign(bytes));
  return { file, sha512: base64(bytes), signature: `${file}.sig` };
}

test('the sha512 from the metadata (base64) becomes the hex that sha512sum prints', () => {
  const sum = createHash('sha512').update('x').digest();
  assert.equal(sha512Hex(sum.toString('base64')), sum.toString('hex'));
  for (const bad of [undefined, null, '', 'abc', 'AAAA', Buffer.alloc(32).toString('base64'), `${sum.toString('base64')}x`]) assert.equal(sha512Hex(bad), null, String(bad));
});

test('the pkexec command line: one call, no internal agent, the file, its hex checksum, its extension and its signature as arguments', async () => {
  const { file, sha512, signature } = await packageFile();
  const publicKey = releaseKey.publicPem;
  const args = pkexecArguments({ type: 'deb', file, sha512, signature, publicKey });
  assert.deepEqual([args[0], args[1], args[2]], ['--disable-internal-agent', '/bin/sh', '-c']);
  assert.equal(args[3], installScript('deb', publicKey));
  assert.deepEqual(args.slice(4), ['opendoc-desktop-update', file, sha512Hex(sha512), 'deb', signature]);
  assert.throws(() => pkexecArguments({ type: 'deb', file: 'relative.deb', sha512, signature, publicKey }), /absolute/);
  assert.throws(() => pkexecArguments({ type: 'deb', file, sha512: 'nope', signature, publicKey }), /SHA-512/);
  assert.throws(() => pkexecArguments({ type: 'deb', file, sha512, publicKey }), /no signature/);
  assert.throws(() => pkexecArguments({ type: 'deb', file, sha512, signature: 'relative.deb.sig', publicKey }), /no signature/);
  assert.throws(() => pkexecArguments({ type: 'deb', file, sha512, signature: `${file}.txt`, publicKey }), /no signature/);
  assert.throws(() => installScript('snap', publicKey), /No installer/);
});

test('the fallback script carries the public key text, and nothing else reaches the key', () => {
  const script = installScript('deb', releaseKey.publicPem);
  assert.ok(script.includes(releaseKey.publicPem.trimEnd()));
  assert.match(script, /openssl pkeyutl -verify -pubin -inkey "\$key" -rawin -in "\$pkg" -sigfile "\$tmp\/update\.sig"/);
  // The key is written by the script into its own temporary folder, and the pkexec arguments carry no key.
  assert.match(script, /key="\$tmp\/release-key\.pem"/);
  for (const bad of [undefined, '', 'key', releaseKey.publicPem.replace('PUBLIC KEY', 'PRIVATE KEY'), `${releaseKey.publicPem}'; touch /tmp/x; '`, releaseKey.publicPem.replace('\n', "'\n"), `${releaseKey.publicPem}${releaseKey.publicPem}`]) {
    assert.throws(() => installScript('deb', bad), /public key/, String(bad));
  }
});

test('the release key is read from the app resources folder when there is one, else from the source tree, and must be plain PEM', async () => {
  const seen = [];
  const text = await readReleaseKey({ resourcesPath: '/opt/opendoc-desktop/resources', readText: async path => { seen.push(path); return releaseKey.publicPem; } });
  assert.equal(text, releaseKey.publicPem);
  assert.deepEqual(seen, [join('/opt/opendoc-desktop/resources', keyRelativePath)]);
  const source = await readReleaseKey({ resourcesPath: undefined });
  assert.equal(source, await readFile(join(resources, 'updater', 'release-key.pem'), 'utf8'));
  await assert.rejects(readReleaseKey({ resourcesPath: '/x', readText: async () => { throw new Error('gone'); } }), /could not be read/);
  await assert.rejects(readReleaseKey({ resourcesPath: '/x', readText: async () => 'not a key' }), /expected form/);
});

test('the install step of each type', () => {
  const key = releaseKey.publicPem;
  assert.match(installScript('deb', key), /dpkg -i "\$pkg" \|\| apt-get install -f -y/);
  assert.match(installScript('pacman', key), /pacman -U --noconfirm "\$pkg"/);
  const rpm = installScript('rpm', key);
  for (const part of ['zypper --non-interactive --no-refresh install --allow-unsigned-rpm -f "$pkg"', 'dnf install --nogpgcheck -y "$pkg"', 'yum install --nogpgcheck -y "$pkg"', 'rpm -Uvh --replacepkgs --replacefiles --nodeps "$pkg"']) assert.ok(rpm.includes(part), part);
  assert.doesNotMatch(installScript('pacman', key), /-Sy/, 'never a partial upgrade');
});

test('a deb is installed with dpkg, after being copied and checked, in one pkexec call', async () => {
  const tools = await fakeTools();
  const { file, sha512, signature } = await packageFile();
  const result = await install({ type: 'deb', file, sha512, signature, env: tools.env() });
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
  const { file, sha512, signature } = await packageFile();
  const result = await install({ type: 'deb', file, sha512, signature, env: tools.env({ FAKE_DPKG_EXIT: '1' }) });
  assert.equal(result.outcome, 'installed');
  assert.deepEqual(await tools.calls('apt-get'), [['install', '-f', '-y']]);
  assert.equal((await tools.calls('pkexec')).length, 1);
});

test('when dpkg and apt-get both fail the install failed, with what they printed', async () => {
  const tools = await fakeTools();
  const { file, sha512, signature } = await packageFile();
  const result = await install({ type: 'deb', file, sha512, signature, env: tools.env({ FAKE_DPKG_EXIT: '1', FAKE_APT_GET_EXIT: '100' }) });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.reason, 'install');
  assert.equal(result.code, 100);
});

test('a file whose checksum is wrong is never installed, even though it was downloaded', async () => {
  const tools = await fakeTools();
  const { file, signature } = await packageFile();
  const result = await install({ type: 'deb', file, sha512: base64('another file'), signature, env: tools.env() });
  assert.deepEqual([result.outcome, result.reason, result.code], ['failed', 'checksum', checksumExitCode]);
  assert.deepEqual(await tools.calls('dpkg'), []);
  assert.deepEqual(await tools.calls('apt-get'), []);
});

test('a file changed after the download is caught when root checks the copy', async () => {
  const tools = await fakeTools();
  const { file, sha512, signature } = await packageFile();
  await writeFile(file, 'swapped by another program');
  const result = await install({ type: 'deb', file, sha512, signature, env: tools.env() });
  assert.equal(result.reason, 'checksum');
  assert.deepEqual(await tools.calls('dpkg'), []);
});

test('exit 126 and 127 from pkexec mean "Update cancelled": the prompt was dismissed, nothing ran', async () => {
  const tools = await fakeTools();
  const { file, sha512, signature } = await packageFile();
  for (const code of ['126', '127']) {
    const result = await install({ type: 'deb', file, sha512, signature, env: tools.env({ FAKE_PKEXEC_EXIT: code }) });
    assert.equal(result.outcome, 'cancelled', code);
    assert.equal(result.code, Number(code));
  }
  assert.deepEqual(await tools.calls('dpkg'), []);
  assert.equal((await tools.calls('pkexec')).length, 2, 'one prompt for each try, never a second one after Cancel');
});

test('a tool that is missing inside the script (exit 127) is a failure, not a cancel', async () => {
  const tools = await fakeTools();
  const { file, sha512, signature } = await packageFile();
  const result = await install({ type: 'deb', file, sha512, signature, env: tools.env({ FAKE_DPKG_EXIT: '127', FAKE_APT_GET_EXIT: '127' }) });
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
  const { file, sha512, signature } = await packageFile();
  const result = await install({ type: 'deb', file, sha512, signature, env: tools.env() });
  assert.deepEqual([result.outcome, result.reason], ['failed', 'no-pkexec']);
  assert.match(result.message, /pkexec was not found/);
});

test('the install does not block the event loop while the prompt is open', async () => {
  const tools = await fakeTools();
  const { file, sha512, signature } = await packageFile();
  // A pkexec that waits (the user typing a password) for a moment.
  await writeFile(join(tools.bin, 'pkexec'), '#!/bin/sh\nsleep 0.6\nexit 126\n', { mode: 0o755 });
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 50);
  const result = await install({ type: 'deb', file, sha512, signature, env: tools.env() });
  clearInterval(timer);
  assert.equal(result.outcome, 'cancelled');
  assert.ok(ticks >= 6, `the event loop kept running (${ticks} ticks while pkexec waited)`);
});

test('rpm and pacman packages go through the same single call with their own tools', async () => {
  const pacman = await fakeTools(['pkexec', 'pacman']);
  const arch = await packageFile('opendoc-desktop-0.6.1-2-x86_64.pacman');
  assert.equal((await install({ type: 'pacman', ...arch, env: pacman.env() })).outcome, 'installed');
  const [call] = await pacman.calls('pacman');
  assert.deepEqual(call.slice(0, 2), ['-U', '--noconfirm']);
  assert.match(call[2], /update\.pacman$/);

  const rpm = await fakeTools(['pkexec', 'dnf']);
  const fedora = await packageFile('opendoc-desktop-0.6.1-2.x86_64.rpm');
  assert.equal((await install({ type: 'rpm', ...fedora, env: rpm.env() })).outcome, 'installed');
  assert.deepEqual((await rpm.calls('dnf'))[0].slice(0, 3), ['install', '--nogpgcheck', '-y']);

  const suse = await fakeTools(['pkexec', 'zypper', 'dnf']);
  await install({ type: 'rpm', ...fedora, env: suse.env() });
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

test('with the helper, pkexec gets the helper path and the four arguments, not a script', async () => {
  const { file, sha512, signature } = await packageFile();
  const helper = join(installedResources, helperRelativePath);
  assert.deepEqual(pkexecArguments({ type: 'deb', file, sha512, signature, helper }), ['--disable-internal-agent', helper, file, sha512Hex(sha512), 'deb', signature]);
  assert.equal(pkexecArguments({ type: 'pacman', file: '/x/y.pacman', sha512, signature: '/x/y.pacman.sig', helper }).at(-2), 'pacman');
  assert.throws(() => pkexecArguments({ type: 'snap', file, sha512, signature, helper }), /No installer/);
  assert.throws(() => pkexecArguments({ type: 'deb', file: 'relative.deb', sha512, signature, helper }), /absolute/);
  assert.throws(() => pkexecArguments({ type: 'deb', file, sha512: 'nope', signature, helper }), /SHA-512/);
  assert.throws(() => pkexecArguments({ type: 'deb', file, sha512, helper }), /no signature/);
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
  const { file, sha512, signature } = await packageFile();
  // Nothing installed at this process's resources path (there is none outside Electron): the fallback.
  assert.equal((await install({ type: 'deb', file, sha512, signature, env: tools.env() })).outcome, 'installed');
  assert.equal((await install({ type: 'deb', file, sha512, signature, env: tools.env(), helper: null })).outcome, 'installed');
  for (const call of await tools.calls('pkexec')) assert.deepEqual(call.slice(0, 3), ['--disable-internal-agent', '/bin/sh', '-c']);
  assert.equal((await tools.calls('pkexec')).length, 2);
});

test('the fallback with no key given reads the app\'s own release key, which a test key\'s signature does not satisfy', async () => {
  const tools = await fakeTools();
  const { file, sha512, signature } = await packageFile();
  const result = await installPackage({ type: 'deb', file, sha512, signature, env: tools.env(), helper: null });
  assert.deepEqual([result.outcome, result.reason, result.code], ['failed', 'signature', signatureExitCode]);
  assert.deepEqual(await tools.calls('dpkg'), []);
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
  assert.match(installScript('deb', releaseKey.publicPem), new RegExp(`exit ${checksumExitCode}`));
  assert.ok(text.includes('if [ "$status" -eq 126 ] || [ "$status" -eq 127 ]; then status=1; fi'));
  assert.ok(installScript('deb', releaseKey.publicPem).includes('if [ "$status" -eq 126 ] || [ "$status" -eq 127 ]; then status=1; fi'));
  // The signature check is the same call in both, with the same exit codes and messages.
  const verify = 'openssl pkeyutl -verify -pubin -inkey "$key" -rawin -in "$pkg" -sigfile "$tmp/update.sig"';
  assert.ok(text.includes(verify));
  assert.ok(installScript('deb', releaseKey.publicPem).includes(verify));
  for (const [code, message] of [[signatureExitCode, 'the update file is not signed with the opendoc-desktop release key'], [opensslExitCode, 'openssl is needed to check the update signature and is not installed']]) {
    assert.ok(text.includes(`${message}' >&2; exit ${code}`), `helper ${code}`);
    assert.ok(installScript('deb', releaseKey.publicPem).includes(`${message}' >&2; exit ${code}`), `script ${code}`);
  }
});

async function viaHelper(extra = {}, { type = 'deb', name, tools } = {}) {
  tools ??= await fakeTools();
  const { file, sha512, signature } = await packageFile(name);
  const helper = await helperPath();
  const result = await installPackage({ type, file, sha512, signature, env: tools.env(extra), helper });
  return { tools, file, sha512, signature, helper, result };
}

test('through the helper: one pkexec call with the helper, the checked copy is installed', async () => {
  const { tools, file, sha512, signature, helper, result } = await viaHelper();
  assert.equal(result.outcome, 'installed');
  const [call, ...more] = await tools.calls('pkexec');
  assert.deepEqual(more, []);
  assert.deepEqual(call, ['--disable-internal-agent', helper, file, sha512Hex(sha512), 'deb', signature]);
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
  const helper = await helperPath();
  const { file, signature } = await packageFile();
  const wrong = await installPackage({ type: 'deb', file, sha512: base64('another file'), signature, env: tools.env(), helper });
  assert.deepEqual([wrong.outcome, wrong.reason, wrong.code], ['failed', 'checksum', checksumExitCode]);
  const { file: second, sha512, signature: secondSignature } = await packageFile();
  await writeFile(second, 'swapped by another program');
  assert.equal((await installPackage({ type: 'deb', file: second, sha512, signature: secondSignature, env: tools.env(), helper })).reason, 'checksum');
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

test('the helper refuses anything but exactly its four arguments, and installs nothing', async () => {
  const tools = await fakeTools();
  const helper = await helperPath();
  const { file, sha512, signature } = await packageFile();
  const hex = sha512Hex(sha512);
  const folder = await scratch('helper-input');
  await mkdir(join(folder, 'dir.deb'));
  await mkdir(join(folder, 'dir.sig'));
  await symlink(file, join(folder, 'link.deb'));
  await symlink(signature, join(folder, 'link.sig'));
  await writeFile(join(folder, 'a\nb.deb'), 'x');
  await writeFile(join(folder, 'a\nb.sig'), Buffer.alloc(64));
  await writeFile(join(folder, 'plain.deb'), 'x');
  await writeFile(join(folder, 'plain.sig'), Buffer.alloc(64));
  await writeFile(join(folder, 'short.sig'), Buffer.alloc(63));
  await writeFile(join(folder, 'long.sig'), Buffer.alloc(65));
  await writeFile(join(folder, 'empty.sig'), '');
  await writeFile(join(folder, 'sig.txt'), Buffer.alloc(64));
  const cases = [
    ['no arguments', []],
    ['two arguments', [file, hex]],
    ['three arguments (no signature)', [file, hex, 'deb']],
    ['five arguments', [file, hex, 'deb', signature, 'extra']],
    ['an unknown type', [file, hex, 'snap', signature]],
    ['an empty type', [file, hex, '', signature]],
    ['an option instead of a type', [file, hex, '-i', signature]],
    ['a short checksum', [file, hex.slice(1), 'deb', signature]],
    ['a long checksum', [file, `${hex}0`, 'deb', signature]],
    ['an uppercase checksum', [file, hex.toUpperCase(), 'deb', signature]],
    ['a non-hex checksum', [file, `${hex.slice(1)}g`, 'deb', signature]],
    ['a checksum with a space', [file, `${hex.slice(2)} ab`, 'deb', signature]],
    ['a relative path', ['plain.deb', hex, 'deb', join(folder, 'plain.sig')]],
    ['a path that does not end in the type', [file, hex, 'rpm', signature]],
    ['a line break in the name', [join(folder, 'a\nb.deb'), hex, 'deb', signature]],
    ['a missing file', [join(folder, 'missing.deb'), hex, 'deb', signature]],
    ['a folder', [join(folder, 'dir.deb'), hex, 'deb', signature]],
    ['a link', [join(folder, 'link.deb'), hex, 'deb', signature]],
    ['a relative signature path', [file, hex, 'deb', 'plain.sig']],
    ['a signature name that does not end in .sig', [file, hex, 'deb', join(folder, 'sig.txt')]],
    ['a line break in the signature name', [file, hex, 'deb', join(folder, 'a\nb.sig')]],
    ['a missing signature file', [file, hex, 'deb', join(folder, 'missing.sig')]],
    ['a signature that is a folder', [file, hex, 'deb', join(folder, 'dir.sig')]],
    ['a signature that is a link', [file, hex, 'deb', join(folder, 'link.sig')]],
    ['a truncated signature (63 bytes)', [file, hex, 'deb', join(folder, 'short.sig')]],
    ['a 65-byte signature', [file, hex, 'deb', join(folder, 'long.sig')]],
    ['an empty signature', [file, hex, 'deb', join(folder, 'empty.sig')]],
  ];
  for (const [label, args] of cases) {
    const run = spawnSync('/bin/sh', [helper, ...args], { encoding: 'utf8', env: tools.env() });
    assert.equal(run.status, 64, `${label}: exit ${run.status} ${run.stderr}`);
    assert.match(run.stderr, /^opendoc-desktop: /, label);
  }
  assert.deepEqual(await tools.calls('dpkg'), []);
  assert.deepEqual(await tools.calls('apt-get'), []);
  assert.deepEqual(await tools.calls('pacman'), []);
});

/** The helper run directly with these arguments (no pkexec), as root's script would: { status, stderr, tools }. */
async function runHelper({ helper, bytes = 'package bytes', signedBytes = bytes, signWith = releaseKey, sha512, tools, extra = {} }) {
  tools ??= await fakeTools();
  helper ??= await helperPath();
  const folder = await scratch('signed');
  const file = join(folder, 'opendoc-desktop_0.6.1-2_amd64.deb');
  await writeFile(file, bytes);
  await writeFile(`${file}.sig`, signWith.sign(signedBytes));
  const run = spawnSync('/bin/sh', [helper, file, sha512Hex(sha512 ?? base64(bytes)), 'deb', `${file}.sig`], { encoding: 'utf8', env: tools.env(extra) });
  return { status: run.status, stderr: run.stderr, tools, file };
}

const notSigned = /not signed with the opendoc-desktop release key/;

test('through the helper: a good signature installs', async () => {
  const run = await runHelper({});
  assert.equal(run.status, 0, run.stderr);
  assert.equal((await run.tools.calls('dpkg')).length, 1);
});

test('through the helper: a signature of other bytes, or by another key, is refused with 71 and nothing is installed', async () => {
  const wrongBytes = await runHelper({ signedBytes: 'another file' });
  assert.equal(wrongBytes.status, signatureExitCode);
  assert.match(wrongBytes.stderr, notSigned);
  assert.deepEqual(await wrongBytes.tools.calls('dpkg'), []);
  const otherKey = await runHelper({ signWith: testReleaseKey() });
  assert.equal(otherKey.status, signatureExitCode);
  assert.match(otherKey.stderr, notSigned);
  assert.deepEqual(await otherKey.tools.calls('dpkg'), []);
  assert.deepEqual(await otherKey.tools.calls('apt-get'), []);
});

test('through the helper: the SHA-512 check still comes first (70 before 71), and 64 bytes of nothing signed is not a signature', async () => {
  const wrongSum = await runHelper({ signWith: testReleaseKey(), sha512: base64('another file') });
  assert.equal(wrongSum.status, checksumExitCode);
  assert.deepEqual(await wrongSum.tools.calls('dpkg'), []);
  // A file whose signature is 64 zero bytes passes the length check and fails the verification.
  const tools = await fakeTools();
  const helper = await helperPath();
  const { file } = await packageFile();
  const zero = join(await scratch('zero'), 'zero.sig');
  await writeFile(zero, Buffer.alloc(64));
  const run = spawnSync('/bin/sh', [helper, file, sha512Hex(base64('package bytes')), 'deb', zero], { encoding: 'utf8', env: tools.env() });
  assert.equal(run.status, signatureExitCode, run.stderr);
  assert.deepEqual(await tools.calls('dpkg'), []);
});

test('through the helper: a missing key file is 71, a missing openssl is 72, and nothing is installed either way', async () => {
  const keyless = await releaseKey.helperFolder();
  await rm(join(keyless, 'release-key.pem'));
  const noKey = await runHelper({ helper: join(keyless, 'install-update') });
  assert.equal(noKey.status, signatureExitCode);
  assert.match(noKey.stderr, notSigned);
  assert.deepEqual(await noKey.tools.calls('dpkg'), []);

  const noOpenssl = await runHelper({ tools: await fakeTools(['pkexec', 'dpkg', 'apt-get'], { withOpenssl: false }) });
  assert.equal(noOpenssl.status, opensslExitCode);
  assert.match(noOpenssl.stderr, /openssl is needed/);
  assert.deepEqual(await noOpenssl.tools.calls('dpkg'), []);
  assert.deepEqual(await noOpenssl.tools.calls('apt-get'), []);
});

test('the helper takes its key from its own folder, not from the environment or the current folder', async () => {
  const other = testReleaseKey();
  const folder = await other.helperFolder();
  // The helper next to a key that is not the one that signed: refused. The key that signed, anywhere else, is not looked for.
  const run = await runHelper({ helper: join(folder, 'install-update') });
  assert.equal(run.status, signatureExitCode);
  const tools = await fakeTools();
  await writeFile(join(folder, 'elsewhere.pem'), releaseKey.publicPem);
  const viaEnvironment = await runHelper({ helper: join(folder, 'install-update'), tools, extra: { KEY: join(folder, 'elsewhere.pem'), OPENDOC_RELEASE_KEY: join(folder, 'elsewhere.pem') } });
  assert.equal(viaEnvironment.status, signatureExitCode);
});

test('through the helper (app side): 71 and 72 come back as failures with their own messages', async () => {
  const wrong = await viaHelper({}, { name: 'opendoc-desktop_0.6.2-1_amd64.deb' });
  assert.equal(wrong.result.outcome, 'installed');
  const { file, sha512 } = await packageFile();
  const bad = join(await scratch('bad-sig'), 'x.deb.sig');
  await writeFile(bad, testReleaseKey().sign('package bytes'));
  const tools = await fakeTools();
  const result = await installPackage({ type: 'deb', file, sha512, signature: bad, env: tools.env(), helper: await helperPath() });
  assert.deepEqual([result.outcome, result.reason, result.code], ['failed', 'signature', signatureExitCode]);
  assert.match(result.message, /not signed with the OpenDoc Desktop release key/);
  assert.deepEqual(await tools.calls('dpkg'), []);
  const noOpenssl = await fakeTools(['pkexec', 'dpkg', 'apt-get'], { withOpenssl: false });
  const missing = await installPackage({ type: 'deb', file, sha512, signature: `${file}.sig`, env: noOpenssl.env(), helper: await helperPath() });
  assert.deepEqual([missing.outcome, missing.reason, missing.code], ['failed', 'no-openssl', opensslExitCode]);
  assert.match(missing.message, /openssl is needed/);
  assert.equal(classifyExit(signatureExitCode).reason, 'signature');
  assert.equal(classifyExit(opensslExitCode).reason, 'no-openssl');
});

test('the fallback script refuses the same bad signatures and installs nothing', async () => {
  const tools = await fakeTools();
  const { file, sha512 } = await packageFile();
  const foreign = join(await scratch('foreign'), 'x.deb.sig');
  await writeFile(foreign, testReleaseKey().sign('package bytes'));
  const wrong = await install({ type: 'deb', file, sha512, signature: foreign, env: tools.env(), helper: null });
  assert.deepEqual([wrong.outcome, wrong.reason, wrong.code], ['failed', 'signature', signatureExitCode]);
  const short = join(await scratch('short'), 'x.deb.sig');
  await writeFile(short, Buffer.alloc(63));
  assert.equal((await install({ type: 'deb', file, sha512, signature: short, env: tools.env(), helper: null })).reason, 'signature');
  const missing = await install({ type: 'deb', file, sha512, signature: `${file}.nope.sig`, env: tools.env(), helper: null });
  assert.equal(missing.outcome, 'failed');
  const sumFirst = await install({ type: 'deb', file, sha512: base64('another file'), signature: foreign, env: tools.env(), helper: null });
  assert.equal(sumFirst.reason, 'checksum');
  const noOpenssl = await fakeTools(['pkexec', 'dpkg', 'apt-get'], { withOpenssl: false });
  const result = await install({ type: 'deb', file, sha512, signature: `${file}.sig`, env: noOpenssl.env(), helper: null });
  assert.deepEqual([result.reason, result.code], ['no-openssl', opensslExitCode]);
  assert.deepEqual(await tools.calls('dpkg'), []);
  assert.deepEqual(await noOpenssl.calls('dpkg'), []);
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
