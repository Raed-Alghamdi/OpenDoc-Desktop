// Builds what the tests share, once: the OpenDoc package tarball, a runtime folder that holds it the way the
// app's runtime does (`node_modules/opendoc`), and a template workspace made with `opendoc init`.
// Never a real workspace: everything lives under the cache folder (tmp/shell-tests in the repository).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertVirtualDisplay } from './environment.mjs';
import { cache, desktopDir, goldenWorkspace, repo, runtimeDir, workDir } from './paths.mjs';
import { killElectronProcesses } from './processes.mjs';

const gentle = ['nice', '-n', '19', 'ionice', '-c', '3'];

function run(command, args, options = {}) {
  const result = spawnSync(gentle[0], [...gentle.slice(1), command, ...args], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

async function tarball() {
  if (process.env.OPENDOC_SHELL_TEST_TARBALL) return process.env.OPENDOC_SHELL_TEST_TARBALL;
  const { version } = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
  const file = join(cache, `ryanyahya-opendoc-${version}.tgz`);
  if (existsSync(file)) return file;
  console.log('Building the OpenDoc package for the tests (pnpm package:pack --edition normal)...');
  run('pnpm', ['package:pack', '--edition', 'normal', '--output', join(cache, 'packages')], { cwd: repo });
  const built = join(cache, 'packages', `ryanyahya-opendoc-${version}.tgz`);
  run('cp', [built, file]);
  return file;
}

export default async function globalSetup() {
  assertVirtualDisplay();
  killElectronProcesses(); // Leftovers of an interrupted run.
  await mkdir(cache, { recursive: true });
  const file = await tarball();
  const marker = join(runtimeDir, '.built-from');
  if (!existsSync(marker) || await readFile(marker, 'utf8') !== file) {
    await rm(runtimeDir, { recursive: true, force: true });
    await rm(goldenWorkspace, { recursive: true, force: true });
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(join(runtimeDir, 'package.json'), JSON.stringify({ name: 'opendoc-desktop-test-runtime', private: true, dependencies: { opendoc: `file:${file}` } }));
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: runtimeDir });
    await writeFile(join(runtimeDir, 'build-info.json'), JSON.stringify({ build: 7, commit: '0123456789abcdef0123456789abcdef01234567', builtAt: '2026-01-01T00:00:00.000Z' }));
    await writeFile(marker, file);
  }
  if (!existsSync(join(goldenWorkspace, '.opendoc', 'workspace.json'))) {
    await rm(goldenWorkspace, { recursive: true, force: true });
    run(process.execPath, [join(runtimeDir, 'node_modules', 'opendoc', 'bin', 'opendoc.mjs'), 'init', goldenWorkspace, '--no-start', '--json'], { env: { ...process.env, OPENDOC_PACKAGE_TARBALL: file } });
  }
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  process.env.OPENDOC_SHELL_TEST_TARBALL = file;
  void desktopDir;
}
