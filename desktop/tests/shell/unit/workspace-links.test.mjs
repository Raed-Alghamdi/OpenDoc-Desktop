import assert from 'node:assert/strict';
import { lstat, mkdir, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { ensureModulesLink, ensureSkillsLink, inspectModules, linkModules } from '../../../src/main/workspace/links.mjs';
import { makeRuntime, scratch } from '../support/workspace-fixtures.mjs';

async function setup() {
  const base = await scratch('links');
  const runtime = await makeRuntime(join(base, 'runtime'));
  const root = join(base, 'ws');
  await mkdir(root, { recursive: true });
  return { base, root, runtime, wanted: { path: join(runtime, 'node_modules') } };
}
const modules = root => join(root, 'node_modules');

test('node_modules missing: it is created as a link to the runtime', async () => {
  const { root, wanted } = await setup();
  assert.deepEqual(await inspectModules(root, wanted), { state: 'missing' });
  const result = await ensureModulesLink(root, wanted);
  assert.equal(result.state, 'missing');
  assert.equal(result.changed, true);
  assert.equal(await readlink(modules(root)), wanted.path);
  assert.equal((await inspectModules(root, wanted)).state, 'correct');
});

test('a correct link is left alone', async () => {
  const { root, wanted } = await setup();
  await symlink(wanted.path, modules(root), 'dir');
  const before = await lstat(modules(root));
  const result = await ensureModulesLink(root, wanted);
  assert.equal(result.state, 'correct');
  assert.equal(result.changed, false);
  assert.equal((await lstat(modules(root))).ino, before.ino);
});

test('a link that reaches the runtime another way (a relative link) counts as correct', async () => {
  const { root, wanted } = await setup();
  await symlink(join('..', 'runtime', 'node_modules'), modules(root), 'dir');
  assert.equal((await inspectModules(root, wanted)).state, 'correct');
});

test('a dangling link is replaced (a new link under a temporary name, then a rename)', async () => {
  const { root, wanted } = await setup();
  await symlink(join(root, 'nowhere'), modules(root), 'dir');
  assert.equal((await inspectModules(root, wanted)).state, 'dangling');
  const result = await ensureModulesLink(root, wanted);
  assert.equal(result.state, 'dangling');
  assert.equal(await readlink(modules(root)), wanted.path);
  assert.deepEqual((await readdir(root)).filter(name => name.includes('tmp')), []);
});

test('a foreign link (to a folder that exists, not the runtime) is replaced', async () => {
  const { root, wanted, base } = await setup();
  await mkdir(join(base, 'other', 'node_modules'), { recursive: true });
  await symlink(join(base, 'other', 'node_modules'), modules(root), 'dir');
  assert.equal((await inspectModules(root, wanted)).state, 'foreign');
  await ensureModulesLink(root, wanted);
  assert.equal(await realpath(modules(root)), await realpath(wanted.path));
  assert.equal((await readdir(join(base, 'other', 'node_modules'))).length, 0, 'the folder the foreign link named is untouched');
});

test('a real folder is never replaced here: it is reported, and replaced only through replaceReal', async () => {
  const { root, wanted } = await setup();
  await mkdir(join(modules(root), 'left-pad'), { recursive: true });
  await writeFile(join(modules(root), 'left-pad', 'index.js'), 'x');
  assert.deepEqual(await inspectModules(root, wanted), { state: 'real', kind: 'folder' });
  const result = await ensureModulesLink(root, wanted);
  assert.deepEqual([result.state, result.changed], ['real', false]);
  assert.equal(await readFile(join(modules(root), 'left-pad', 'index.js'), 'utf8'), 'x');
  const removed = [];
  const again = await ensureModulesLink(root, wanted, { replaceReal: async path => { removed.push(path); await rm(path, { recursive: true }); } });
  assert.deepEqual(removed, [modules(root)]);
  assert.equal(again.changed, true);
  assert.equal(await readlink(modules(root)), wanted.path);
});

test('a file named node_modules is reported as a real file and never replaced', async () => {
  const { root, wanted } = await setup();
  await writeFile(modules(root), 'not a folder');
  assert.deepEqual(await inspectModules(root, wanted), { state: 'real', kind: 'file' });
  const result = await ensureModulesLink(root, wanted);
  assert.equal(result.state, 'real');
  assert.equal(await readFile(modules(root), 'utf8'), 'not a folder');
});

test('with exact, only a link that names the wanted path itself is correct (the AppImage current link)', async () => {
  const { base, root, runtime } = await setup();
  const current = join(base, 'data', 'runtime', 'current');
  await mkdir(join(base, 'data', 'runtime'), { recursive: true });
  await symlink(runtime, current, 'dir');
  const wanted = { path: join(current, 'node_modules') };
  await symlink(join(runtime, 'node_modules'), modules(root), 'dir'); // reaches the same folder, but not through `current`
  assert.equal((await inspectModules(root, wanted)).state, 'correct');
  assert.equal((await inspectModules(root, wanted, { exact: true })).state, 'foreign');
  await ensureModulesLink(root, wanted, { exact: true });
  assert.equal(await readlink(modules(root)), wanted.path);
});

test('linking to a runtime that is not there fails and leaves the workspace as it was', async () => {
  const { root } = await setup();
  await assert.rejects(linkModules(root, { path: join(root, 'no-runtime') }), /runtime is not at/);
  assert.deepEqual(await readdir(root), []);
});

test('.claude/skills: missing, with .agents/skills present, is linked to ../.agents/skills', async () => {
  const { root } = await setup();
  await mkdir(join(root, '.agents', 'skills', 'one'), { recursive: true });
  assert.equal((await ensureSkillsLink(root)).state, 'repaired');
  assert.equal(await readlink(join(root, '.claude', 'skills')), join('..', '.agents', 'skills'));
  assert.equal((await ensureSkillsLink(root)).state, 'correct');
  assert.deepEqual(await readdir(join(root, '.claude', 'skills')), ['one']);
});

test('.claude/skills: a dangling link is repaired', async () => {
  const { root } = await setup();
  await mkdir(join(root, '.agents', 'skills'), { recursive: true });
  await mkdir(join(root, '.claude'), { recursive: true });
  await symlink('../elsewhere', join(root, '.claude', 'skills'), 'dir');
  assert.equal((await ensureSkillsLink(root)).state, 'repaired');
  assert.equal(await readlink(join(root, '.claude', 'skills')), join('..', '.agents', 'skills'));
});

test('.claude/skills: a real folder is never replaced, and a link that works to somewhere else is left', async () => {
  const { root, base } = await setup();
  await mkdir(join(root, '.agents', 'skills'), { recursive: true });
  await mkdir(join(root, '.claude', 'skills', 'mine'), { recursive: true });
  assert.equal((await ensureSkillsLink(root)).state, 'real');
  assert.deepEqual(await readdir(join(root, '.claude', 'skills')), ['mine']);
  await rm(join(root, '.claude', 'skills'), { recursive: true });
  await mkdir(join(base, 'shared'), { recursive: true });
  await symlink(join(base, 'shared'), join(root, '.claude', 'skills'), 'dir');
  assert.equal((await ensureSkillsLink(root)).state, 'other-link');
  assert.equal(await readlink(join(root, '.claude', 'skills')), join(base, 'shared'));
});

test('.claude/skills: without .agents/skills nothing is created', async () => {
  const { root } = await setup();
  assert.equal((await ensureSkillsLink(root)).state, 'no-agents');
  assert.deepEqual(await readdir(root), []);
  await writeFile(join(root, '.agents'), 'a file');
  assert.equal((await ensureSkillsLink(root)).state, 'no-agents');
});
