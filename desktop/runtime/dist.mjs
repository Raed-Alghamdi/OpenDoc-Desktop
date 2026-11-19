#!/usr/bin/env node
// Runs electron-builder with the build number the runtime was built with, then adds `build:` and `commit:` to the update metadata.
//
// Usage: node desktop/runtime/dist.mjs [--stub] [electron-builder arguments...]
//   Everything after the options goes to electron-builder (for example `--linux pacman deb --publish never`). `--publish` defaults to never.
//   --stub   builds with tests/smoke/fixtures/electron-builder.stub.yml, a throwaway main process, for checking the packaging
//            before the shell lands (it extends electron-builder.yml and changes only the entry file).
// Run it after `node runtime/build.mjs`: the runtime folder for this machine must exist.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addBuildFields } from './release-metadata.mjs';

const desktop = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const runtime = path.join(desktop, 'build', 'runtime', `${process.platform}-${process.arch}`);
let info;
try {
  info = JSON.parse(readFileSync(path.join(runtime, 'build-info.json'), 'utf8'));
} catch {
  throw new Error(`No runtime for this machine at ${path.relative(desktop, runtime)}. Run node runtime/build.mjs first.`);
}

const args = process.argv.slice(2);
const stub = args.includes('--stub');
const forwarded = args.filter((arg) => arg !== '--stub');
if (!forwarded.some((arg) => arg === '--publish' || arg === '-p' || arg.startsWith('--publish='))) forwarded.push('--publish', 'never');
if (stub) forwarded.push('--config', 'tests/smoke/fixtures/electron-builder.stub.yml');

// The build number goes in as text: electron-builder's fpm step splits it as a string.
const build = String(info.build);
const result = spawnSync('pnpm', [
  'exec', 'electron-builder', ...forwarded,
  `-c.buildNumber=${build}`, `-c.mac.bundleVersion=${build}`,
], { cwd: desktop, stdio: 'inherit', env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: process.env.CSC_IDENTITY_AUTO_DISCOVERY ?? 'false' } });
if (result.status !== 0) process.exit(result.status ?? 1);

const dist = path.join(desktop, 'dist');
for (const name of readdirSync(dist).filter((file) => /^latest.*\.yml$/.test(file))) {
  const file = path.join(dist, name);
  writeFileSync(file, addBuildFields(readFileSync(file, 'utf8'), build, info.commit));
  console.log(`${name}: build ${build}, commit ${info.commit.slice(0, 12)}`);
}
