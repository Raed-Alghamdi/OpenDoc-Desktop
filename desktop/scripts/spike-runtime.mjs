#!/usr/bin/env node
// Spike S4: build the app's runtime folder (plan 3.3 steps 1 and 2) for the machine it runs on.
// Usage: node desktop/scripts/spike-runtime.mjs [--build <integer>]
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const argv = process.argv.slice(2);
const build = Number(argv[argv.indexOf('--build') + 1] || 1);
const version = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
const platform = `${process.platform}-${process.arch}`;
const target = path.join(repo, 'desktop', 'build', 'runtime', platform);
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });

run('pnpm', ['package:pack', '--edition', 'normal'], repo);
const tarball = path.join(repo, 'output', 'packages', `ryanyahya-opendoc-${version}.tgz`);
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(tarball, path.join(target, path.basename(tarball)));
writeFileSync(path.join(target, 'package.json'), JSON.stringify({
  name: 'opendoc-runtime', version, private: true,
  dependencies: { opendoc: `file:./${path.basename(tarball)}` },
}, null, 2));
run('npm', ['install', '--no-audit', '--no-fund'], target);
rmSync(path.join(target, path.basename(tarball)));
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
writeFileSync(path.join(target, 'build-info.json'), JSON.stringify({ build, commit, builtAt: new Date().toISOString() }));

// The three platform pieces must exist (plan 3.3).
const nm = path.join(target, 'node_modules');
for (const scope of ['@napi-rs', '@resvg', '@esbuild']) {
  const found = readdirSync(path.join(nm, scope)).filter((n) => n.includes(process.platform === 'darwin' ? 'darwin' : 'linux'));
  if (found.length === 0) throw new Error(`No ${platform} package under node_modules/${scope}`);
  console.log(`${scope}: ${found.join(', ')}`);
}
if (!existsSync(path.join(nm, 'opendoc', 'bin', 'opendoc.mjs'))) throw new Error('opendoc CLI missing');
console.log(`runtime ready: ${target}`);
