#!/usr/bin/env node
// Checks the unpacked apps in desktop/dist (the folders electron-builder builds the installers from): the agent integrations
// with their dot folders, through the source check script, and on macOS the design pack document type in Info.plist.
//
// Usage: node desktop/tests/packaging/check-packaged.mjs [--dist <folder>] [--require <linux|mac>...]
// Looks for dist/linux-unpacked and for every .app folder under dist/mac*. Without --require it checks what it finds and fails when
// it finds nothing; with --require each named platform must be there.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { builderConfig, desktop, documentTypeProblems, readPlist } from './builder-support.mjs';

const { values } = parseArgs({ options: { dist: { type: 'string' }, require: { type: 'string', multiple: true, default: [] } }, strict: true });
const dist = path.resolve(values.dist ?? path.join(desktop, 'dist'));
const appId = builderConfig().appId;

// The same script CI runs on the source folder, pointed at the packaged copy. A bad file filter shows up as a missing file here.
const dotFiles = ['claude/.claude-plugin/marketplace.json', 'codex/.agents/plugins/marketplace.json'];
function checkIntegrations(resources) {
  const folder = path.join(resources, 'integrations');
  for (const file of dotFiles) assert.ok(existsSync(path.join(folder, file)), `missing ${path.join(folder, file)}`);
  const run = spawnSync(process.execPath, [path.join(desktop, 'integrations', 'check.mjs'), folder], { encoding: 'utf8' });
  assert.equal(run.status, 0, `integrations/check.mjs failed on ${folder}:\n${run.stdout}${run.stderr}`);
  return run.stdout.trim();
}

// The helper the Linux packages' polkit action names (resources/updater/install-update): there, and the repository's own file. A Mac
// app has no use for it (no pkexec), so it must not be there.
const helperFile = path.join('updater', 'install-update');
function checkHelper(resources) {
  const file = path.join(resources, helperFile);
  assert.ok(existsSync(file), `missing ${file}`);
  assert.ok((statSync(file).mode & 0o111) === 0o111, `${file} is not executable`);
  assert.equal(readFileSync(file, 'utf8'), readFileSync(path.join(desktop, 'resources', helperFile), 'utf8'), `${file} differs from the repository's helper`);
  return 'present, executable, the repository\'s text';
}

const results = [];
const check = (label, run) => {
  try { results.push(`ok    ${label}: ${run()}`); } catch (error) { results.push(`FAIL  ${label}: ${error.message}`); process.exitCode = 1; }
};

const found = new Set();
const entries = existsSync(dist) ? readdirSync(dist) : [];
if (entries.includes('linux-unpacked')) {
  found.add('linux');
  check('linux-unpacked integrations', () => checkIntegrations(path.join(dist, 'linux-unpacked', 'resources')));
  check('linux-unpacked update helper', () => checkHelper(path.join(dist, 'linux-unpacked', 'resources')));
}
for (const folder of entries.filter((name) => /^mac/.test(name))) {
  for (const app of readdirSync(path.join(dist, folder)).filter((name) => name.endsWith('.app'))) {
    found.add('mac');
    const contents = path.join(dist, folder, app, 'Contents');
    check(`${folder}/${app} integrations`, () => checkIntegrations(path.join(contents, 'Resources')));
    check(`${folder}/${app} has no update helper`, () => {
      assert.ok(!existsSync(path.join(contents, 'Resources', 'updater')), 'a Mac app must not carry the Linux update helper');
      return 'none';
    });
    check(`${folder}/${app} document type`, () => {
      const problems = documentTypeProblems(readPlist(path.join(contents, 'Info.plist')), appId);
      assert.deepEqual(problems, []);
      return 'design packs only, plain ZIP files not claimed';
    });
  }
}
for (const platform of values.require) if (!found.has(platform)) { results.push(`FAIL  ${platform}: no unpacked app found in ${dist}`); process.exitCode = 1; }
if (found.size === 0 && values.require.length === 0) { results.push(`FAIL  no unpacked app found in ${dist}`); process.exitCode = 1; }
console.log(results.join('\n'));
