import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { projectRoot } from './helpers';
import { comparePin } from '../src/cli/workspace';

const run = promisify(execFile);
const pkg = JSON.parse(await readFile(resolve(projectRoot, 'package.json'), 'utf8')) as { version: string };
const [major, minor, patch] = pkg.version.split('.').map(Number);
const pinFor = (version: string) => `npm:@ryanyahya/opendoc@${version}`;

/**
 * A stand-in for the desktop app's runtime: `<runtime>/node_modules/opendoc` holds this checkout's code as a real copy
 * (a link would resolve back to the checkout), the dependencies are links to the checkout's, `build-info.json` sits
 * beside `node_modules`, and everything is made read-only like the real one.
 */
let runtimePromise: Promise<{ directory: string; opendoc: string; cli: string }> | undefined;
function managedRuntime() {
  runtimePromise ??= (async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'opendoc-runtime-'));
    const nodeModules = resolve(directory, 'node_modules'), opendoc = resolve(nodeModules, 'opendoc');
    await mkdir(opendoc, { recursive: true });
    for (const entry of ['src', 'bin', '.agents', 'docs', 'vendor', 'AGENTS.md', 'CLAUDE.md', 'package.json', 'tsconfig.workspace.json']) await cp(resolve(projectRoot, entry), resolve(opendoc, entry), { recursive: true });
    await symlink(resolve(projectRoot, 'dist'), resolve(opendoc, 'dist'));
    for (const entry of await readdir(resolve(projectRoot, 'node_modules'))) if (entry !== '.bin' && entry !== 'opendoc') await symlink(resolve(projectRoot, 'node_modules', entry), resolve(nodeModules, entry));
    // The workspace tsconfig resolves types from the package's own folder, where the real package bundles them.
    await mkdir(resolve(opendoc, 'node_modules'), { recursive: true });
    for (const entry of ['@types', '@formepdf']) await symlink(resolve(projectRoot, 'node_modules', entry), resolve(opendoc, 'node_modules', entry));
    // The starter library, as scripts/pack.mjs assembles it.
    const starter = resolve(opendoc, 'starter');
    for (const id of ['welcome', 'welcome-presentation']) await cp(resolve(projectRoot, 'documents', id), resolve(starter, 'documents', id), { recursive: true });
    for (const folder of ['templates', 'themes', 'assets']) await cp(resolve(projectRoot, folder), resolve(starter, folder), { recursive: true });
    await writeFile(resolve(starter, 'projects.json'), JSON.stringify({ version: 1, projects: [{ id: 'getting-started', name: 'Getting started', defaultTheme: null }], assignments: { welcome: 'getting-started', 'welcome-presentation': 'getting-started' }, formats: { 'welcome-presentation': 'presentation' } }));
    await writeFile(resolve(directory, 'build-info.json'), JSON.stringify({ build: 1, commit: 'abc1234', builtAt: '2026-11-19T00:00:00.000Z' }));
    // Read-only, as the app ships it: files lose their write bit, folders keep theirs until the end.
    const lock = async (path: string): Promise<void> => {
      const info = await lstat(path);
      if (info.isSymbolicLink()) return;
      if (info.isDirectory()) { for (const entry of await readdir(path)) await lock(resolve(path, entry)); await chmod(path, 0o555); }
      else await chmod(path, info.mode & ~0o222);
    };
    await lock(opendoc); await lock(resolve(directory, 'build-info.json'));
    return { directory, opendoc, cli: resolve(opendoc, 'bin/opendoc.mjs') };
  })();
  return runtimePromise;
}

test.after(async () => {
  if (!runtimePromise) return;
  const { opendoc, directory } = await runtimePromise;
  await run('chmod', ['-R', 'u+w', opendoc]);
  await rm(directory, { recursive: true, force: true });
});

/** Run the app's `opendoc` the way its shim does: the runtime's own bin, with no npm or PATH help. */
async function opendoc(cwd: string, ...args: string[]) {
  const { cli } = await managedRuntime();
  try {
    const result = await run(process.execPath, [cli, ...args], { cwd, env: { ...process.env, PATH: '/nonexistent' }, timeout: 120_000 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr };
  }
}

async function scratch(t: TestContext) {
  const folder = await mkdtemp(resolve(tmpdir(), 'opendoc-managed-'));
  t.after(async () => { await run('chmod', ['-R', 'u+w', folder]).catch(() => {}); await rm(folder, { recursive: true, force: true }); });
  return folder;
}

/** A workspace made by the app's runtime without npm. */
async function created(t: TestContext) {
  const folder = await scratch(t);
  const destination = resolve(folder, 'ws');
  const result = await opendoc(folder, 'init', destination, '--no-start', '--json');
  assert.equal(result.code, 0, result.stderr);
  return destination;
}

test('the 3.4 version table', () => {
  assert.equal(comparePin('0.6.1', '0.6.1'), 'current');
  assert.equal(comparePin('0.6.0', '0.6.1'), 'current', 'an older patch opens normally');
  assert.equal(comparePin('0.6.2', '0.6.1'), 'newer-patch');
  assert.equal(comparePin('0.5.9', '0.6.1'), 'older-minor');
  assert.equal(comparePin('0.7.0', '0.6.1'), 'newer-minor');
  assert.equal(comparePin('0.10.0', '0.9.9'), 'newer-minor');
  assert.equal(comparePin('1.0.0', '0.9.9'), 'newer-minor');
  assert.equal(comparePin('0.9.9', '1.0.0'), 'older-minor');
  assert.throws(() => comparePin('^0.6.1', '0.6.1'), /exact stable/);
});

test('init in the app\'s runtime makes a managed workspace without npm, and its files are editable', { timeout: 240_000 }, async t => {
  const workspace = await created(t);
  const { directory } = await managedRuntime();
  const marker = JSON.parse(await readFile(resolve(workspace, '.opendoc/workspace.json'), 'utf8'));
  assert.deepEqual(marker, { formatVersion: 1, createdWith: pkg.version, edition: 'normal', managed: true });
  assert.equal(resolve(workspace, await readlink(resolve(workspace, 'node_modules'))), resolve(directory, 'node_modules'));
  await assert.rejects(stat(resolve(workspace, 'package-lock.json')), { code: 'ENOENT' }, 'No npm lockfile.');
  assert.equal(JSON.parse(await readFile(resolve(workspace, 'package.json'), 'utf8')).dependencies.opendoc, pinFor(pkg.version));
  // Copies out of a read-only runtime stay writable (the starter files, folders and the agent files).
  for (const path of ['documents', 'documents/welcome', 'documents/welcome/index.tsx', 'projects.json', 'themes', 'assets', 'AGENTS.md']) {
    const mode = (await stat(resolve(workspace, path))).mode;
    assert.ok(mode & 0o200, `${path} is writable`);
  }
  const agents = await readFile(resolve(workspace, 'AGENTS.md'), 'utf8');
  assert.match(agents, /update the app, not this workspace/);
  assert.doesNotMatch(agents, /npx opendoc update|opendoc start/);
  await writeFile(resolve(workspace, 'documents/welcome/index.tsx'), (await readFile(resolve(workspace, 'documents/welcome/index.tsx'), 'utf8')) + '\n');
  assert.equal((await opendoc(workspace, '--version', '--json')).code, 0);
});

test('a managed workspace repairs its runtime link, so no node_modules, a dangling link and a foreign link all work, even --version', { timeout: 300_000 }, async t => {
  const workspace = await created(t);
  const { directory } = await managedRuntime();
  const link = resolve(workspace, 'node_modules');
  const works = async () => {
    for (const args of [['--version'], ['projects', 'list'], ['documents', 'trash']]) {
      const result = await opendoc(workspace, ...args);
      assert.equal(result.code, 0, `${args.join(' ')}: ${result.stderr}`);
    }
    assert.equal(await realpath(link), await realpath(resolve(directory, 'node_modules')), 'The link points at the app\'s runtime again.');
  };
  await rm(link);
  await works(); // A: no node_modules
  await rm(link); await symlink(resolve(workspace, 'missing-target'), link, 'dir');
  await works(); // B: dangling link
  const foreign = resolve(await scratch(t), 'node_modules');
  await mkdir(resolve(foreign, 'opendoc'), { recursive: true });
  await writeFile(resolve(foreign, 'opendoc/package.json'), '{"name":"x","version":"0.0.1"}');
  await rm(link); await symlink(foreign, link, 'dir');
  await works(); // D: a link to another folder
  // A real folder is left alone: its owner is npm, not the app.
  await rm(link);
  await mkdir(resolve(link, 'opendoc'), { recursive: true });
  await writeFile(resolve(link, 'opendoc/package.json'), '{"name":"@ryanyahya/opendoc","version":"9.9.9"}');
  assert.equal((await lstat(link)).isSymbolicLink(), false);
  const result = await opendoc(workspace, 'projects', 'list');
  assert.equal((await lstat(link)).isSymbolicLink(), false, 'The real folder stays.');
  assert.notEqual(result.code, 0);
});

test('the 3.4 table in a managed workspace: older patch opens, newer patch and minor are read-only, older minor is the app\'s to upgrade', { timeout: 300_000 }, async t => {
  const workspace = await created(t);
  const setPin = async (version: string) => {
    const manifest = JSON.parse(await readFile(resolve(workspace, 'package.json'), 'utf8'));
    manifest.dependencies.opendoc = pinFor(version);
    await writeFile(resolve(workspace, 'package.json'), JSON.stringify(manifest));
  };
  const json = (text: string) => JSON.parse(text.trim().split('\n').at(-1)!);
  // Same minor, older patch (when there is one): opens and writes.
  if (patch > 0) { await setPin(`${major}.${minor}.${patch - 1}`); assert.equal((await opendoc(workspace, 'documents', 'rename', 'welcome', 'Renamed')).code, 0); }
  // Same minor, newer patch.
  const tree = async (): Promise<string[]> => (await readdir(resolve(workspace, 'documents'), { recursive: true })).sort();
  const before = await tree();
  await setPin(`${major}.${minor}.${patch + 1}`);
  let result = await opendoc(workspace, 'documents', 'rename', 'welcome', 'Again', '--json');
  assert.equal(result.code, 1);
  assert.deepEqual(json(result.stdout), { ok: false, error: `This workspace is on OpenDoc ${major}.${minor}.${patch + 1}, newer than the ${pkg.version} in this app. Update the app to edit it.`, code: 'workspace-read-only' });
  assert.equal((await opendoc(workspace, 'documents', 'trash')).code, 0, 'reading still works');
  assert.equal((await opendoc(workspace, 'review', 'welcome', '--json')).code, 0, 'review still works');
  assert.deepEqual(await tree(), before, 'and nothing under documents/ changes');
  // Newer minor.
  await setPin(`${major}.${minor + 1}.0`);
  result = await opendoc(workspace, 'comments', 'add', 'welcome', 'x', 'No', '--json');
  assert.equal(json(result.stdout).code, 'workspace-read-only');
  assert.match(json(result.stdout).error, new RegExp(`upgraded by OpenDoc ${major}\\.${minor + 1}\\. Update the app to edit it\\.`));
  // Older minor: only the app upgrades. Every command says so; --version still answers.
  await setPin(minor > 0 ? `${major}.${minor - 1}.0` : '0.0.1');
  if (minor > 0) {
    result = await opendoc(workspace, 'projects', 'list', '--json');
    assert.equal(result.code, 1);
    assert.match(json(result.stdout).error, /Open this workspace in opendoc-desktop to upgrade it\./);
    assert.doesNotMatch(json(result.stdout).error, /npm install/);
    assert.equal((await opendoc(workspace, '--version')).code, 0);
  }
});

test('update in a managed workspace says to update the app, before it asks any registry', { timeout: 120_000 }, async t => {
  const workspace = await created(t);
  for (const args of [['update'], ['update', '--check'], ['update', '--version', '9.9.9']]) {
    const result = await opendoc(workspace, ...args, '--json');
    assert.equal(result.code, 1, args.join(' '));
    assert.match(JSON.parse(result.stdout.trim().split('\n').at(-1)!).error, /managed by the OpenDoc desktop app\. Update the app instead\./);
  }
});

test('the flag counts only where the app\'s runtime is found: an npm checkout treats a managed marker as an npm workspace', { timeout: 120_000 }, async t => {
  const folder = await scratch(t);
  const root = resolve(folder, 'ws');
  await mkdir(resolve(root, '.opendoc'), { recursive: true });
  await writeFile(resolve(root, '.opendoc/workspace.json'), JSON.stringify({ formatVersion: 1, edition: 'normal', managed: true }));
  await writeFile(resolve(root, 'package.json'), JSON.stringify({ name: 'ws', private: true, dependencies: { opendoc: pinFor(pkg.version) } }));
  // This checkout is not the app's runtime, so with no node_modules the old npm message stays, and nothing is linked.
  const result = await run(process.execPath, ['--import', 'tsx', '-e', `const { installedApplication } = await import(${JSON.stringify(resolve(projectRoot, 'src/cli/workspace.ts'))}); await installedApplication(${JSON.stringify(root)}).catch(error => console.log(error.message));`], { cwd: projectRoot });
  assert.match(result.stdout, /Run npm install in/);
  await assert.rejects(lstat(resolve(root, 'node_modules')), { code: 'ENOENT' });
  const update = await run(process.execPath, ['--import', 'tsx', '-e', `const { updateWorkspace } = await import(${JSON.stringify(resolve(projectRoot, 'src/cli/update.ts'))}); await updateWorkspace(${JSON.stringify(root)}, { check: true }, { npm: async () => { throw new Error('registry reached'); } }).catch(error => console.log(error.message));`], { cwd: projectRoot });
  assert.match(update.stdout, /registry reached/, 'update goes on to npm instead of refusing');
});

test('a marker whose managed value is not true or false is refused', async t => {
  const folder = await scratch(t);
  await mkdir(resolve(folder, '.opendoc'), { recursive: true });
  await writeFile(resolve(folder, '.opendoc/workspace.json'), JSON.stringify({ formatVersion: 1, managed: 'yes' }));
  const { readWorkspaceMarker } = await import('../src/cli/workspace');
  await assert.rejects(readWorkspaceMarker(folder), /managed must be true or false/);
  await writeFile(resolve(folder, '.opendoc/workspace.json'), JSON.stringify({ formatVersion: 1, managed: true, extra: 1 }));
  assert.equal((await readWorkspaceMarker(folder)).managed, true);
  void join;
});

test('--version still answers in an unmanaged workspace whose install is missing, while other commands explain', { timeout: 120_000 }, async t => {
  const folder = await scratch(t);
  await mkdir(resolve(folder, '.opendoc'), { recursive: true });
  await writeFile(resolve(folder, '.opendoc/workspace.json'), JSON.stringify({ formatVersion: 1, edition: 'normal' }));
  await writeFile(resolve(folder, 'package.json'), JSON.stringify({ name: 'ws', private: true, dependencies: { opendoc: pinFor(pkg.version) } }));
  const version = await opendoc(folder, '--version');
  assert.equal(version.code, 0, version.stderr);
  assert.match(version.stdout, new RegExp(pkg.version.replaceAll('.', '\\.')));
  const other = await opendoc(folder, 'projects', 'list');
  assert.notEqual(other.code, 0);
  assert.match(other.stderr, /npm install/);
});
