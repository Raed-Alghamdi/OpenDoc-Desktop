#!/usr/bin/env node
// Builds the runtime folder the desktop app carries: this fork's OpenDoc core installed with npm into
// desktop/build/runtime/<platform>-<arch>, on the machine (or CI runner) that packages for that platform.
//
// Usage: node desktop/runtime/build.mjs [--build <integer>] [--skip-pack]
//   --build       the build number (default: $OPENDOC_DESKTOP_BUILD, then 1)
//   --skip-pack   reuse output/packages/ryanyahya-opendoc-<version>.tgz instead of running `pnpm package:pack`
//
// Layout: <runtime>/{package.json, package-lock.json, build-info.json, node_modules/}. `opendoc` is installed as a `file:`
// tarball alias, so the folder looks like a workspace that pins the core (runtime paths in src/runtime/paths.ts key on it).
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const repo = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const { values: options } = parseArgs({
  options: { build: { type: 'string' }, 'skip-pack': { type: 'boolean', default: false } },
  strict: true,
});

const buildText = options.build ?? process.env.OPENDOC_DESKTOP_BUILD ?? '1';
if (!/^[1-9]\d*$/.test(buildText)) throw new Error(`The build number must be a positive whole number, got "${buildText}".`);
const build = Number(buildText);

const version = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
const platform = `${process.platform}-${process.arch}`;
const target = path.join(repo, 'desktop', 'build', 'runtime', platform);
const nodeModules = path.join(target, 'node_modules');

// Only what nothing loads at run time: npm's hidden lock file and source maps (Node ignores them without --enable-source-maps,
// and nothing here sets it). TypeScript (the `check` command) and pdf.js (the preview) are needed and stay whole; so do licences.
const prunedFiles = ['node_modules/.package-lock.json'];
const prunedExtensions = ['.map'];

function run(command, args, cwd, env = {}) {
  execFileSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
}

function walk(directory, visit) {
  for (const name of readdirSync(directory)) {
    const file = path.join(directory, name);
    const stat = lstatSync(file);
    visit(file, stat);
    if (stat.isDirectory()) walk(file, visit);
  }
}

// Symlinks are skipped on purpose: chmod would follow them. The runtime's only links are relative ones under node_modules/.bin.
function setWritable(directory, writable) {
  const mode = (stat) => (writable ? stat.mode | 0o200 : stat.mode & ~0o222) & 0o7777;
  const root = lstatSync(directory);
  chmodSync(directory, mode(root));
  walk(directory, (file, stat) => {
    if (!stat.isSymbolicLink()) chmodSync(file, mode(stat));
  });
}

function nativePieces() {
  const [os, arch] = [process.platform, process.arch];
  const found = [];
  for (const [scope, prefix] of [['@napi-rs', 'canvas-'], ['@resvg', 'resvg-js-'], ['@esbuild', '']]) {
    const folder = path.join(nodeModules, scope);
    const names = existsSync(folder) ? readdirSync(folder).filter((name) => name.startsWith(`${prefix}${os}-${arch}`)) : [];
    if (names.length !== 1) throw new Error(`Expected one ${os}-${arch} package under node_modules/${scope}, found ${names.length ? names.join(', ') : 'none'}.`);
    found.push(`${scope}/${names[0]}`);
  }
  return found;
}

function checkNativePieces() {
  const found = nativePieces();
  // esbuild's install script is skipped (--ignore-scripts); its JS API starts this executable itself, so it must keep its bit.
  const esbuild = path.join(nodeModules, found[2], 'bin', 'esbuild');
  if (!existsSync(esbuild)) throw new Error(`The esbuild executable is missing: ${esbuild}`);
  if ((statSync(esbuild).mode & 0o111) === 0) chmodSync(esbuild, 0o755);
  // Load all three here, on the host that built them (the shim and the app load them again under Electron as Node).
  const require = createRequire(path.join(target, 'package.json'));
  require('@napi-rs/canvas').createCanvas(1, 1);
  new (require('@resvg/resvg-js').Resvg)('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>').render();
  const esbuildVersion = execFileSync(esbuild, ['--version']).toString().trim();
  console.log(`native pieces ok: ${found.join(', ')} (esbuild ${esbuildVersion})`);
}

function prune() {
  for (const entry of prunedFiles) rmSync(path.join(target, entry), { force: true });
  const doomed = [];
  walk(nodeModules, (file, stat) => {
    if (stat.isFile() && prunedExtensions.some((extension) => file.endsWith(extension))) doomed.push(file);
  });
  for (const file of doomed) rmSync(file);
  console.log(`pruned ${doomed.length} source maps`);
}

if (!options['skip-pack']) run('pnpm', ['package:pack', '--edition', 'normal'], repo);
const tarballName = `ryanyahya-opendoc-${version}.tgz`;
const tarball = path.join(repo, 'output', 'packages', tarballName);
if (!existsSync(tarball)) throw new Error(`Missing ${path.relative(repo, tarball)}. Run without --skip-pack.`);

if (existsSync(target)) setWritable(target, true);
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
copyFileSync(tarball, path.join(target, tarballName));
writeFileSync(path.join(target, 'package.json'), `${JSON.stringify({
  name: 'opendoc-runtime',
  version,
  private: true,
  type: 'module',
  dependencies: { opendoc: `file:${tarballName}` },
}, null, 2)}\n`);

// A lock first, then `npm ci`: the install is exactly what the lock names. No install scripts run.
const npmFlags = ['--ignore-scripts', '--no-audit', '--no-fund'];
run('npm', ['install', '--package-lock-only', ...npmFlags], target);
run('npm', ['ci', ...npmFlags], target);
rmSync(path.join(target, tarballName));

checkNativePieces();
prune();

const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
writeFileSync(path.join(target, 'build-info.json'), `${JSON.stringify({ build, commit, builtAt: new Date().toISOString() })}\n`);
if (!existsSync(path.join(nodeModules, 'opendoc', 'bin', 'opendoc.mjs'))) throw new Error('The opendoc command is missing from the runtime.');

setWritable(target, false);
console.log(`runtime ready: ${path.relative(repo, target)} (version ${version}, build ${build}, commit ${commit.slice(0, 12)})`);
