// Builds what the tests share, once: the OpenDoc package tarball, a runtime folder that holds it the way the
// app's runtime does (`node_modules/opendoc`), and a template workspace made with `opendoc init`.
// Never a real workspace: everything lives under the cache folder (tmp/shell-tests in the repository).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assertVirtualDisplay } from './environment.mjs';
import { cache, cliResources, desktopDir, electronExecutable, goldenWorkspace, npmCache, npmGoldenWorkspace, repo, runtimeDir, unpackedDir, workDir } from './paths.mjs';
import { killElectronProcesses } from './processes.mjs';

const gentle = ['nice', '-n', '19', 'ionice', '-c', '3'];

function run(command, args, options = {}) {
  const result = spawnSync(gentle[0], [...gentle.slice(1), command, ...args], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...options, env: { ...(options.env ?? process.env), ...(['npm', process.execPath].includes(command) ? { npm_config_cache: npmCache } : {}) } });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

async function tarball() {
  if (process.env.OPENDOC_SHELL_TEST_TARBALL) return process.env.OPENDOC_SHELL_TEST_TARBALL;
  const { version } = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
  // Named by the version and the committed source it was built from, so a merge that changes src/ builds a new one.
  const source = run('git', ['rev-parse', '--short=12', 'HEAD:src'], { cwd: repo }).trim();
  const file = join(cache, `ryanyahya-opendoc-${version}-${source}.tgz`);
  if (existsSync(file)) return file;
  console.log('Building the OpenDoc package for the tests (pnpm package:pack --edition normal)...');
  run('pnpm', ['package:pack', '--edition', 'normal', '--output', join(cache, 'packages')], { cwd: repo });
  const built = join(cache, 'packages', `ryanyahya-opendoc-${version}.tgz`);
  run('cp', [built, file]);
  return file;
}

/** The linux-unpacked layout for the agent command tests; the launchers inside it are refreshed on every run. */
async function unpackedApp(runtimeMarker) {
  const source = process.env.OPENDOC_SHELL_TEST_UNPACKED;
  const wanted = `${source ?? `${electronExecutable}\n${runtimeMarker}`}`;
  const marker = join(unpackedDir, '.built-from');
  if (!existsSync(marker) || await readFile(marker, 'utf8') !== wanted) {
    await rm(unpackedDir, { recursive: true, force: true });
    if (source) run('cp', ['-a', '--reflink=auto', source, unpackedDir]);
    else {
      run('cp', ['-a', '--reflink=auto', dirname(electronExecutable), unpackedDir]);
      await rename(join(unpackedDir, 'electron'), join(unpackedDir, 'opendoc-desktop'));
      await rm(join(unpackedDir, 'resources', 'runtime'), { recursive: true, force: true });
      run('cp', ['-a', '--reflink=auto', runtimeDir, join(unpackedDir, 'resources', 'runtime')]);
    }
    await writeFile(marker, wanted);
  }
  // The packaging's runtime folder names the OpenDoc version in its package.json (the AppImage command names its copy by it).
  const runtimePackage = join(unpackedDir, 'resources', 'runtime', 'package.json');
  const packaged = JSON.parse(await readFile(runtimePackage, 'utf8'));
  const { version } = JSON.parse(await readFile(join(unpackedDir, 'resources', 'runtime', 'node_modules', 'opendoc', 'package.json'), 'utf8'));
  if (packaged.version !== version) await writeFile(runtimePackage, JSON.stringify({ ...packaged, version }, null, 2));
  await mkdir(join(unpackedDir, 'resources', 'cli'), { recursive: true });
  for (const name of ['opendoc', 'opendoc-appimage.sh']) {
    await copyFile(join(cliResources, name), join(unpackedDir, 'resources', 'cli', name));
    await chmod(join(unpackedDir, 'resources', 'cli', name), 0o755);
  }
}

/**
 * A workspace as npm leaves one (what a user has who synced a folder from a device that installed with npm): a real
 * node_modules, a package-lock.json, the exact pin, and a marker without `managed`. Made from the template by an npm install
 * of the same tarball, as `init` did before it could work without npm.
 */
async function npmWorkspace(tarballFile) {
  await rm(npmGoldenWorkspace, { recursive: true, force: true });
  run('cp', ['-a', '--reflink=auto', goldenWorkspace, npmGoldenWorkspace]);
  await rm(join(npmGoldenWorkspace, 'node_modules'), { force: true });
  const markerFile = join(npmGoldenWorkspace, '.opendoc', 'workspace.json');
  const { managed, ...marker } = JSON.parse(await readFile(markerFile, 'utf8'));
  await writeFile(markerFile, `${JSON.stringify(marker, null, 2)}\n`);
  const manifestFile = join(npmGoldenWorkspace, 'package.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', `opendoc@file:${tarballFile}`], { cwd: npmGoldenWorkspace });
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  const lockFile = join(npmGoldenWorkspace, 'package-lock.json');
  const lock = JSON.parse(await readFile(lockFile, 'utf8'));
  lock.packages[''].dependencies.opendoc = manifest.dependencies.opendoc;
  await writeFile(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
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
    await rm(npmGoldenWorkspace, { recursive: true, force: true });
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(join(runtimeDir, 'package.json'), JSON.stringify({ name: 'opendoc-desktop-test-runtime', private: true, dependencies: { opendoc: `file:${file}` } }));
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: runtimeDir });
    await writeFile(join(runtimeDir, 'build-info.json'), JSON.stringify({ build: 7, commit: '0123456789abcdef0123456789abcdef01234567', builtAt: '2026-01-01T00:00:00.000Z' }));
    await writeFile(marker, file);
  }
  await unpackedApp(await readFile(marker, 'utf8'));
  if (!existsSync(join(goldenWorkspace, '.opendoc', 'workspace.json'))) {
    await rm(goldenWorkspace, { recursive: true, force: true });
    // From the runtime, as the app's "Create new workspace" does: no npm, node_modules is a link to the runtime, `managed: true`.
    run(process.execPath, [join(runtimeDir, 'node_modules', 'opendoc', 'bin', 'opendoc.mjs'), 'init', goldenWorkspace, '--no-start', '--json']);
  }
  if (!existsSync(join(npmGoldenWorkspace, 'package-lock.json'))) await npmWorkspace(file);
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  process.env.OPENDOC_SHELL_TEST_TARBALL = file;
  void desktopDir;
}
