// Runtime smoke test (S1's checks): the runtime folder works as a read-only runtime under the Electron binary run as Node.
// It links a scratch workspace to the runtime the way the app does, then runs `opendoc --version`, `check` and `export`.
//
//   node --test desktop/tests/smoke/runtime.test.mjs
//
// OPENDOC_RUNTIME  the runtime folder (default: desktop/build/runtime/<platform>-<arch>; in an installed app, <resources>/runtime)
// OPENDOC_ELECTRON the binary to run as Node (default: the electron package's own; in an installed app, its executable)
// Electron runs with ELECTRON_RUN_AS_NODE, so it opens no window. Never point OPENDOC_ELECTRON at a build whose RunAsNode fuse is off:
// that build starts as an app instead.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const runtime = path.resolve(process.env.OPENDOC_RUNTIME ?? path.join(desktop, 'build', 'runtime', `${process.platform}-${process.arch}`));
const electron = process.env.OPENDOC_ELECTRON ?? createRequire(path.join(desktop, 'package.json'))('electron');
const cli = path.join(runtime, 'node_modules', 'opendoc', 'bin', 'opendoc.mjs');
const info = JSON.parse(readFileSync(path.join(runtime, 'build-info.json'), 'utf8'));
const version = JSON.parse(readFileSync(path.join(runtime, 'package.json'), 'utf8')).version;

// Never ELECTRON_FORCE_IS_PACKAGED or the Wayland hint: this is a plain Node run.
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
for (const name of ['ELECTRON_FORCE_IS_PACKAGED', 'ELECTRON_OZONE_PLATFORM_HINT']) delete env[name];

let scratch;
let workspace;
const opendoc = (...args) => execFileSync(electron, [cli, ...args], { cwd: workspace, env, encoding: 'utf8', timeout: 120_000 });

// The runtime must not change: paths, sizes and times of every entry.
function listing(directory, base = directory, found = []) {
  for (const name of readdirSync(directory).sort()) {
    const file = path.join(directory, name);
    const stat = lstatSync(file);
    found.push(`${path.relative(base, file)} ${stat.isSymbolicLink() ? 'link' : stat.size} ${stat.mtimeMs}`);
    if (stat.isDirectory()) listing(file, base, found);
  }
  return found;
}

function makeWorkspace(root) {
  // What `opendoc init` makes, with the runtime's node_modules linked in instead of an npm install.
  mkdirSync(path.join(root, '.opendoc'), { recursive: true });
  cpSync(path.join(runtime, 'node_modules', 'opendoc', 'starter'), root, { recursive: true });
  for (const entry of ['assets', 'documents', 'templates', 'themes']) {
    chmodSync(path.join(root, entry), 0o755);
  }
  chmodRecursive(root);
  writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({
    name: 'opendoc-workspace', private: true, type: 'module', dependencies: { opendoc: `npm:@ryanyahya/opendoc@${version}` },
  }, null, 2)}\n`);
  writeFileSync(path.join(root, 'tsconfig.json'), `${JSON.stringify({ extends: 'opendoc/tsconfig.workspace.json', include: ['documents', 'templates', 'themes'] }, null, 2)}\n`);
  writeFileSync(path.join(root, '.opendoc', 'workspace.json'), `${JSON.stringify({ formatVersion: 1, createdWith: version, edition: 'normal', managed: true }, null, 2)}\n`);
  symlinkSync(path.join(runtime, 'node_modules'), path.join(root, 'node_modules'), 'dir');
}

function chmodRecursive(directory) {
  for (const name of readdirSync(directory)) {
    const file = path.join(directory, name);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) continue;
    chmodSync(file, stat.mode | (stat.isDirectory() ? 0o300 : 0o200));
    if (stat.isDirectory()) chmodRecursive(file);
  }
}

describe(`runtime ${path.relative(desktop, runtime)} under ${path.basename(String(electron))} as Node`, () => {
  let before_;
  before(() => {
    scratch = mkdtempSync(path.join(os.tmpdir(), 'opendoc-runtime-smoke-'));
    workspace = path.join(scratch, 'workspace');
    makeWorkspace(workspace);
    before_ = listing(runtime);
  });
  after(() => rmSync(scratch, { recursive: true, force: true }));

  it('has a build-info.json with a build, a commit and a date', () => {
    assert.ok(Number.isInteger(info.build) && info.build >= 1, `build: ${info.build}`);
    assert.match(info.commit, /^[0-9a-f]{40}$/);
    assert.ok(!Number.isNaN(Date.parse(info.builtAt)));
  });

  // Files only: a copy inside an installed app has writable top folders (root owns them there), so a probe file must never be created.
  it('has read-only files', () => {
    assert.throws(() => writeFileSync(path.join(runtime, 'build-info.json'), '{}'), /EACCES|EPERM|EROFS/);
    assert.throws(() => writeFileSync(path.join(runtime, 'node_modules', 'opendoc', 'package.json'), '{}'), /EACCES|EPERM|EROFS/);
  });

  it('keeps esbuild executable', () => {
    const folder = path.join(runtime, 'node_modules', '@esbuild');
    const platform = readdirSync(folder).find((name) => name.startsWith(`${process.platform}-${process.arch}`));
    assert.ok(platform, 'no esbuild package for this platform');
    const output = execFileSync(path.join(folder, platform, 'bin', 'esbuild'), ['--version'], { encoding: 'utf8' }).trim();
    assert.match(output, /^\d+\.\d+\.\d+/);
  });

  it('answers --version with the runtime version', () => {
    assert.equal(opendoc('--version').trim(), version);
  });

  it('checks a workspace linked to it', () => {
    opendoc('check');
  });

  it('creates and exports a document to a PDF', () => {
    opendoc('create', 'smoke-check', '--project', 'getting-started', '--title', 'Smoke Check', '--theme', 'neutral');
    const result = JSON.parse(opendoc('export', 'smoke-check', '--json'));
    const file = [result.file, result.path, result.output].find((value) => typeof value === 'string')
      ?? JSON.stringify(result).match(/"([^"]+\.pdf)"/)?.[1];
    assert.ok(file, `no PDF path in ${JSON.stringify(result)}`);
    const pdf = path.isAbsolute(file) ? file : path.join(workspace, file);
    assert.equal(readFileSync(pdf).subarray(0, 5).toString(), '%PDF-');
  });

  it('wrote nothing into the runtime', () => {
    assert.deepEqual(listing(runtime), before_);
  });
});
