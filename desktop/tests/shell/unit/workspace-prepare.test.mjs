import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { listBackups } from '../../../src/main/workspace/backup.mjs';
import { prepareWorkspace } from '../../../src/main/workspace/prepare.mjs';
import { readRuntimeInfo } from '../../../src/main/workspace/runtime-info.mjs';
import { lockBytes, makeRuntime, makeWorkspace, scratch } from '../support/workspace-fixtures.mjs';

const pinOf = async root => JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).dependencies.opendoc.split('@').at(-1);
const exists = path => lstat(path).then(() => true, () => false);

/** Everything a workspace folder holds, as a map from path to a description, to prove "nothing was changed". */
async function snapshot(root) {
  const found = {};
  const walk = async (path, relative) => {
    const info = await lstat(path);
    if (info.isSymbolicLink()) found[relative] = `link:${await readlink(path)}`;
    else if (info.isDirectory()) { found[relative] = 'dir'; for (const name of (await readdir(path)).sort()) await walk(join(path, name), join(relative, name)); }
    else found[relative] = `file:${await readFile(path, 'utf8')}`;
  };
  await walk(root, '.');
  return found;
}

/** A runtime at 0.6.1, a workspace as `workspace` says, a recording ui, and a fake CLI that passes unless `fail` names a document. */
async function setup({ workspace = {}, answers = {}, runtime: runtimeOptions = {}, readOnlySupport = false, ...options } = {}) {
  const base = await scratch('prepare');
  const runtimeFolder = await makeRuntime(join(base, 'runtime'), runtimeOptions);
  const root = join(base, 'ws');
  await makeWorkspace(root, workspace);
  const calls = { ui: [], cli: [], removed: [] };
  const ui = {
    askAdopt: async () => { calls.ui.push('adopt'); return answers.adopt ?? true; },
    askRealModules: async (_root, kind) => { calls.ui.push(`real:${kind}`); return answers.real ?? true; },
    askUpgrade: async info => { calls.ui.push(`upgrade:${info.from}>${info.to}`); return answers.upgrade ?? { choice: 'upgrade', remember: false }; },
    remember: async () => { calls.ui.push('remember'); },
    progress: text => { if (text) calls.ui.push(`progress:${text}`); },
    showResult: async info => { calls.ui.push('result'); calls.result = info; return answers.result ?? { action: 'close' }; },
  };
  const failing = new Set(options.failDocuments ?? []);
  const runCli = async (args, { cwd }) => {
    calls.cli.push({ args, cwd });
    if (args[0] === 'check' && options.failCheck) return { code: 1, stdout: JSON.stringify({ error: 'Type error in theme.ts' }), stderr: 'theme.ts(3,1): error TS2322' };
    if (args[0] === 'review' && failing.has(args[1])) return { code: 1, stdout: JSON.stringify({ status: 'error', error: `boom in ${args[1]}` }), stderr: '' };
    return { code: 0, stdout: '{}', stderr: '' };
  };
  const wanted = { path: join(runtimeFolder, 'node_modules') };
  const dataDir = join(base, 'data');
  const info = await readRuntimeInfo(runtimeFolder);
  const run = async extra => prepareWorkspace({ root, runtime: info, wanted, readOnlySupport, upgradeWithoutAsking: false, replaceReal: async path => { calls.removed.push(path); await rm(path, { recursive: true }); }, runCli, ui, dataDir, now: new Date(2026, 10, 18, 14, 25, 30), ...extra });
  return { base, root, calls, run, dataDir, wanted, runtimeFolder, ui };
}

/** Run, and prove package-lock.json (when the workspace has one) is byte-identical afterwards. */
async function attempt(context, extra) {
  const before = await lockBytes(context.root);
  const result = await context.run(extra);
  assert.deepEqual(await lockBytes(context.root), before, 'package-lock.json must be byte-identical');
  return result;
}

// ---- the version table through the open

test('pin 0.6.0, runtime 0.6.1: opens, and the pin moves up to 0.6.1', async () => {
  const context = await setup({ workspace: { pin: '0.6.0' } });
  const result = await attempt(context);
  assert.equal(result.ok, true);
  assert.equal(result.readOnly, null);
  assert.equal(await pinOf(context.root), '0.6.1');
  assert.equal(await readlink(join(context.root, 'node_modules')), context.wanted.path);
  assert.equal(JSON.parse(await readFile(join(context.root, '.opendoc', 'workspace.json'), 'utf8')).managed, true);
  assert.deepEqual(context.calls.ui, []);
});

test('pin 0.6.1: opens and package.json is not rewritten', async () => {
  const context = await setup();
  const text = await readFile(join(context.root, 'package.json'), 'utf8');
  assert.equal((await attempt(context)).ok, true);
  assert.equal(await readFile(join(context.root, 'package.json'), 'utf8'), text);
});

test('pin 0.6.9 without read-only support: refused with the newer-patch message, nothing changed', async () => {
  const context = await setup({ workspace: { pin: '0.6.9' } });
  const before = await snapshot(context.root);
  const result = await attempt(context);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'read-only-unsupported');
  assert.match(result.message, /newer than this app \(0\.6\.1\)\. Update the app to edit it\./);
  assert.deepEqual(await snapshot(context.root), before);
  assert.equal(context.calls.cli.length, 0);
});

test('pin 0.6.9 with read-only support: read-only for newer-patch, the pin stays, node_modules is linked', async () => {
  const context = await setup({ workspace: { pin: '0.6.9' }, readOnlySupport: true });
  const result = await attempt(context);
  assert.equal(result.ok, true);
  assert.equal(result.readOnly.reason, 'newer-patch');
  assert.match(result.readOnly.message, /Update the app to edit it/);
  assert.equal(await pinOf(context.root), '0.6.9');
});

test('pin 0.7.0: refused with the newer-version message (no read-only support), nothing changed', async () => {
  const context = await setup({ workspace: { pin: '0.7.0' } });
  const before = await snapshot(context.root);
  const result = await attempt(context);
  assert.equal(result.code, 'read-only-unsupported');
  assert.match(result.message, /^This workspace was upgraded by OpenDoc 0\.7\. Update the app to edit it\./);
  assert.deepEqual(await snapshot(context.root), before);
});

test('pin 0.7.0 with read-only support: read-only for newer-minor, the pin is never lowered', async () => {
  const context = await setup({ workspace: { pin: '0.7.0' }, readOnlySupport: true });
  const result = await attempt(context);
  assert.equal(result.readOnly.reason, 'newer-minor');
  assert.equal(await pinOf(context.root), '0.7.0');
});

test('a malformed pin is refused and nothing is changed', async () => {
  for (const pin of ['{"name":"w","dependencies":{"opendoc":"^0.6.1"}}\n', '{"name":"w"}\n']) {
    const context = await setup({ workspace: { pin } });
    const before = await snapshot(context.root);
    const result = await attempt(context);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'malformed-pin');
    assert.deepEqual(await snapshot(context.root), before);
  }
});

test('a package.json that is not JSON is refused with its own code', async () => {
  const context = await setup({ workspace: { pin: '{ nope' } });
  assert.equal((await attempt(context)).code, 'bad-package');
});

test('a headless pin (with or without a marker) is refused: the app opens the normal edition only', async () => {
  const headless = '{"name":"w","dependencies":{"opendoc":"npm:@ryanyahya/opendoc-headless@0.6.1"}}\n';
  const bare = await setup({ workspace: { pin: headless, marker: false } });
  const before = await snapshot(bare.root);
  const refused = await attempt(bare);
  assert.equal(refused.code, 'headless');
  assert.match(refused.message, /headless edition/);
  assert.deepEqual(await snapshot(bare.root), before);
  assert.equal(bare.calls.ui.length, 0, 'it does not even ask to adopt');
  const marked = await setup({ workspace: { pin: headless, marker: { formatVersion: 1, edition: 'headless' } } });
  assert.equal((await attempt(marked)).code, 'headless');
});

test('a marker of another workspace format is refused', async () => {
  const context = await setup({ workspace: { marker: { formatVersion: 2, edition: 'normal' } } });
  const result = await attempt(context);
  assert.equal(result.code, 'unsupported-format');
  assert.match(result.message, /format 2/);
});

test('a damaged marker is refused', async () => {
  const context = await setup();
  await writeFile(join(context.root, '.opendoc', 'workspace.json'), '{ nope');
  assert.equal((await attempt(context)).code, 'bad-marker');
});

test('a folder with no marker and no OpenDoc pin is not a workspace, and nothing is created in it', async () => {
  const context = await setup({ workspace: { pin: false, marker: false, documents: [], lock: false } });
  const result = await attempt(context);
  assert.equal(result.code, 'not-a-workspace');
  assert.deepEqual(await readdir(context.root), []);
  const plain = await setup({ workspace: { pin: '{"name":"app","dependencies":{"react":"19.0.0"}}\n', marker: false } });
  assert.equal((await attempt(plain)).code, 'not-a-workspace');
});

// ---- adoption

test('a synced folder (a pin, no marker, no node_modules, no .claude/skills) is adopted after the user says yes', async () => {
  const context = await setup({ workspace: { marker: false, skills: true } });
  const result = await attempt(context);
  assert.equal(result.ok, true);
  assert.equal(result.adopted, true);
  assert.deepEqual(context.calls.ui, ['adopt']);
  assert.deepEqual(JSON.parse(await readFile(join(context.root, '.opendoc', 'workspace.json'), 'utf8')), { formatVersion: 1, edition: 'normal', managed: true });
  assert.equal(await readlink(join(context.root, 'node_modules')), context.wanted.path);
  assert.equal(await readlink(join(context.root, '.claude', 'skills')), join('..', '.agents', 'skills'));
});

test('declining the adoption changes nothing and does not open', async () => {
  const context = await setup({ workspace: { marker: false, skills: true }, answers: { adopt: false } });
  const before = await snapshot(context.root);
  const result = await attempt(context);
  assert.deepEqual(result, { ok: false, canceled: true });
  assert.deepEqual(await snapshot(context.root), before);
});

test('an existing marker without managed gets managed: true once the link is in place', async () => {
  const context = await setup({ workspace: { marker: { formatVersion: 1, createdWith: '0.5.0', edition: 'normal' } } });
  await attempt(context);
  assert.equal(JSON.parse(await readFile(join(context.root, '.opendoc', 'workspace.json'), 'utf8')).managed, true);
  assert.deepEqual(context.calls.ui, [], 'no question for a workspace that already has its marker');
});

test('a failure to link (the runtime is gone) leaves the marker without managed', async () => {
  const context = await setup();
  await rm(join(context.runtimeFolder, 'node_modules'), { recursive: true });
  await assert.rejects(attempt(context), /runtime is not at/);
  assert.equal(JSON.parse(await readFile(join(context.root, '.opendoc', 'workspace.json'), 'utf8')).managed, undefined);
});

// ---- links on open

test('dangling and foreign links are repaired without asking', async () => {
  for (const make of [root => symlink(join(root, 'gone'), join(root, 'node_modules'), 'dir'), async root => { await mkdir(join(root, '..', 'other', 'node_modules'), { recursive: true }); await symlink(join(root, '..', 'other', 'node_modules'), join(root, 'node_modules'), 'dir'); }]) {
    const context = await setup();
    await make(context.root);
    assert.equal((await attempt(context)).ok, true);
    assert.equal(await readlink(join(context.root, 'node_modules')), context.wanted.path);
    assert.deepEqual(context.calls.ui, []);
  }
});

test('a real node_modules is asked about once; "no" leaves it untouched and does not open', async () => {
  const context = await setup({ answers: { real: false } });
  await mkdir(join(context.root, 'node_modules', 'left-pad'), { recursive: true });
  await writeFile(join(context.root, 'node_modules', 'left-pad', 'index.js'), 'x');
  const before = await snapshot(context.root);
  const result = await attempt(context);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'modules-kept');
  assert.deepEqual(context.calls.ui, ['real:folder']);
  assert.deepEqual(await snapshot(context.root), before);
  assert.deepEqual(context.calls.removed, []);
});

test('a real node_modules and "use the app\'s OpenDoc": it is handed to replaceReal (the trash), then linked', async () => {
  const context = await setup();
  await mkdir(join(context.root, 'node_modules', 'left-pad'), { recursive: true });
  const result = await attempt(context);
  assert.equal(result.ok, true);
  assert.deepEqual(context.calls.removed, [join(context.root, 'node_modules')]);
  assert.equal(await readlink(join(context.root, 'node_modules')), context.wanted.path);
});

test('a file named node_modules is asked about as a file', async () => {
  const context = await setup({ answers: { real: false } });
  await writeFile(join(context.root, 'node_modules'), 'file');
  assert.equal((await attempt(context)).code, 'modules-kept');
  assert.deepEqual(context.calls.ui, ['real:file']);
  assert.equal(await readFile(join(context.root, 'node_modules'), 'utf8'), 'file');
});

test('a workspace the app created (created: true) has its fresh npm node_modules replaced without asking', async () => {
  const context = await setup();
  await mkdir(join(context.root, 'node_modules', 'opendoc'), { recursive: true });
  assert.equal((await attempt(context, { created: true })).ok, true);
  assert.deepEqual(context.calls.ui, []);
});

test('a refusal after a "no" to an upgrade question leaves the folder as it was, even with a real node_modules', async () => {
  const context = await setup({ workspace: { pin: '0.5.0' }, answers: { upgrade: { choice: 'cancel' } } });
  const before = await snapshot(context.root);
  assert.deepEqual(await attempt(context), { ok: false, canceled: true });
  assert.deepEqual(await snapshot(context.root), before);
});

// ---- the upgrade

test('an older minor: the dialog is asked, Upgrade backs up, runs check and then review on every document in the workspace, moves the pin and opens', async () => {
  const context = await setup({ workspace: { pin: '0.5.0', documents: ['alpha', 'beta'] } });
  const result = await attempt(context);
  assert.equal(result.ok, true);
  assert.equal(result.upgraded, true);
  assert.equal(result.readOnly, null);
  assert.equal(await pinOf(context.root), '0.6.1');
  assert.deepEqual(context.calls.cli.map(call => call.args.join(' ')), ['check --json', 'review alpha --json', 'review beta --json']);
  assert.ok(context.calls.cli.every(call => call.cwd === context.root));
  const backups = await listBackups(context.dataDir);
  assert.equal(backups.length, 1);
  assert.deepEqual([backups[0].manifest.from, backups[0].manifest.to], ['0.5.0', '0.6.1']);
  assert.equal(JSON.parse(await readFile(join(backups[0].directory, 'workspace', 'package.json'), 'utf8')).dependencies.opendoc.split('@').at(-1), '0.5.0');
  assert.equal(await exists(join(backups[0].directory, 'workspace', 'node_modules')), false);
  assert.ok(result.notes[0].detail.includes(backups[0].directory), 'the result says where the backup is');
  assert.match(result.notes[0].detail, /Workspace Backups/);
  const order = context.calls.ui.filter(item => !item.startsWith('progress'));
  assert.deepEqual(order, ['upgrade:0.5.0>0.6.1']);
});

test('the pin moves only after the backup exists (a backup that fails leaves the pin where it was)', async () => {
  const context = await setup({ workspace: { pin: '0.5.0' } });
  const result = await attempt(context, { free: async () => 10 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'backup-failed');
  assert.match(result.message, /not enough free space/);
  assert.equal(await pinOf(context.root), '0.5.0');
  assert.equal(context.calls.cli.length, 0);
});

test('ticking "upgrade without asking" is remembered; with upgradeWithoutAsking set the dialog is not shown', async () => {
  const remembered = await setup({ workspace: { pin: '0.5.0' }, answers: { upgrade: { choice: 'upgrade', remember: true } } });
  await attempt(remembered);
  assert.ok(remembered.calls.ui.includes('remember'));
  const unticked = await setup({ workspace: { pin: '0.5.0' } });
  await attempt(unticked);
  assert.ok(!unticked.calls.ui.includes('remember'));
  const quiet = await setup({ workspace: { pin: '0.5.0' } });
  const result = await attempt(quiet, { upgradeWithoutAsking: true });
  assert.equal(result.ok, true);
  assert.ok(!quiet.calls.ui.some(item => item.startsWith('upgrade:')), 'no dialog');
  assert.equal(await pinOf(quiet.root), '0.6.1');
});

test('"Open read-only" with support: no backup, no change to the pin, read-only for declined-upgrade', async () => {
  const context = await setup({ workspace: { pin: '0.5.0' }, readOnlySupport: true, answers: { upgrade: { choice: 'readonly' } } });
  const result = await attempt(context);
  assert.equal(result.ok, true);
  assert.equal(result.readOnly.reason, 'declined-upgrade');
  assert.match(result.readOnly.message, /read-only/);
  assert.equal(await pinOf(context.root), '0.5.0');
  assert.equal((await listBackups(context.dataDir)).length, 0);
  assert.equal(context.calls.cli.length, 0);
});

test('"Open read-only" without support is refused with the same wording as the other read-only rows, nothing changed', async () => {
  const context = await setup({ workspace: { pin: '0.5.0' }, answers: { upgrade: { choice: 'readonly' } } });
  const before = await snapshot(context.root);
  const result = await attempt(context);
  assert.equal(result.code, 'read-only-unsupported');
  assert.match(result.message, /Opening a workspace read-only needs a newer OpenDoc service/);
  assert.deepEqual(await snapshot(context.root), before);
});

test('a document that fails review: the result screen lists it with the message and a prompt for the agent; closing it does not open', async () => {
  const context = await setup({ workspace: { pin: '0.5.0', documents: ['alpha', 'broken', 'gamma'] }, failDocuments: ['broken'] });
  const result = await attempt(context);
  assert.deepEqual(result, { ok: false, canceled: true });
  assert.deepEqual(context.calls.cli.filter(call => call.args[0] === 'review').map(call => call.args[1]), ['alpha', 'broken', 'gamma'], 'the other documents are still reviewed');
  const info = context.calls.result;
  assert.deepEqual(info.failures.map(failure => [failure.id, failure.message]), [['broken', 'boom in broken']]);
  assert.equal(info.canOpen, true);
  assert.equal(info.backup.directory, (await listBackups(context.dataDir))[0].directory);
  assert.match(info.prompt, /broken/);
  assert.match(info.prompt, /opendoc review/);
  assert.equal(await pinOf(context.root), '0.6.1');
});

test('Restore backup brings the old files back, notes the files from before, and (with support) opens read-only', async () => {
  const context = await setup({ workspace: { pin: '0.5.0', documents: ['alpha', 'broken'] }, failDocuments: ['broken'], readOnlySupport: true, answers: { result: { action: 'restore' } } });
  const original = await snapshot(context.root);
  const result = await attempt(context);
  assert.equal(result.ok, true);
  assert.equal(result.readOnly.reason, 'restored-backup');
  assert.equal(await pinOf(context.root), '0.5.0', 'the pin is back where it was');
  const after = await snapshot(context.root);
  for (const [path, value] of Object.entries(original)) if (!path.startsWith('node_modules') && !path.startsWith('.opendoc')) assert.equal(after[path], value, path);
  const kinds = (await listBackups(context.dataDir)).map(item => item.manifest.kind).sort();
  assert.deepEqual(kinds, ['before-restore', 'upgrade']);
  assert.match(result.notes[0].detail, /before-restore/);
});

test('Restore backup without read-only support refuses to open, and the files are restored all the same', async () => {
  const context = await setup({ workspace: { pin: '0.5.0', documents: ['broken'] }, failDocuments: ['broken'], answers: { result: { action: 'restore' } } });
  const result = await attempt(context);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'restored');
  assert.match(result.message, /restored from a backup/);
  assert.equal(await pinOf(context.root), '0.5.0');
});

test('"Open anyway" on the result screen opens the workspace writable when only reviews failed', async () => {
  const context = await setup({ workspace: { pin: '0.5.0', documents: ['broken'] }, failDocuments: ['broken'], answers: { result: { action: 'open' } } });
  const result = await attempt(context);
  assert.equal(result.ok, true);
  assert.equal(result.readOnly, null);
});

test('a failing check is listed as a failure of the workspace, not of a document', async () => {
  const context = await setup({ workspace: { pin: '0.5.0' }, failCheck: true });
  await attempt(context);
  const [failure] = context.calls.result.failures;
  assert.equal(failure.id, null);
  assert.match(failure.message, /Type error in theme\.ts/);
  assert.match(failure.message, /TS2322/);
});

test('a failing upgrade step stops before the pin moves; the result screen cannot "open anyway"', async () => {
  const base = await scratch('step-fail');
  const script = join(base, 'bad.mjs');
  await writeFile(script, "console.error('cannot move the history'); process.exit(2);\n");
  const context = await setup({ workspace: { pin: '0.5.0' } });
  const result = await attempt(context, { registry: [{ from: '0.5', to: '0.6', script }] });
  assert.equal(result.canceled, true);
  assert.equal(context.calls.result.canOpen, false);
  assert.match(context.calls.result.failures[0].message, /cannot move the history/);
  assert.equal(await pinOf(context.root), '0.5.0');
  assert.equal(context.calls.cli.length, 0);
  assert.equal((await listBackups(context.dataDir)).length, 1, 'the backup is kept');
});

test('a missing registry entry still upgrades; a no-op entry does too', async () => {
  const a = await setup({ workspace: { pin: '0.5.0' } });
  assert.equal((await attempt(a, { registry: [] })).ok, true);
  const b = await setup({ workspace: { pin: '0.5.0' } });
  assert.equal((await attempt(b, { registry: [{ from: '0.5', to: '0.6', noChanges: true }] })).ok, true);
});

test('quitting during an upgrade (the signal aborts) stops it; the backup stays and the pin is where it was', async () => {
  const controller = new AbortController();
  const context = await setup({ workspace: { pin: '0.5.0' } });
  const ui = { ...context.ui, progress: text => { if (text?.startsWith('Running')) controller.abort(); } };
  const result = await attempt(context, { signal: controller.signal, ui });
  assert.deepEqual(result, { ok: false, canceled: true });
  assert.equal(await pinOf(context.root), '0.5.0');
  assert.equal((await listBackups(context.dataDir)).length, 1);
  assert.equal(context.calls.cli.length, 0);
});

test('an open that is already cancelled before anything is changed leaves the folder as it was', async () => {
  const controller = new AbortController();
  controller.abort();
  const context = await setup({ workspace: { pin: '0.5.0', marker: false } });
  const before = await snapshot(context.root);
  assert.deepEqual(await attempt(context, { signal: controller.signal }), { ok: false, canceled: true });
  assert.deepEqual(await snapshot(context.root), before);
});

test('after a crash part-way through an upgrade the next open sees the older pin and asks again', async () => {
  const context = await setup({ workspace: { pin: '0.5.0' }, answers: { result: { action: 'close' } } });
  // The crash: the backup was made, the process died before the pin moved.
  const { createBackup } = await import('../../../src/main/workspace/backup.mjs');
  await createBackup({ root: context.root, dataDir: context.dataDir, from: '0.5.0', to: '0.6.1' });
  const result = await attempt(context);
  assert.equal(result.ok, true);
  assert.ok(context.calls.ui.includes('upgrade:0.5.0>0.6.1'), 'it asked again');
  assert.equal((await listBackups(context.dataDir)).length, 2, 'the earlier backup is kept next to the new one');
});
