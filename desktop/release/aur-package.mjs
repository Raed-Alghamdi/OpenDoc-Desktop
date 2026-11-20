#!/usr/bin/env node
// The AUR package opendoc-desktop-bin for one release (plan 3.7, E13): the PKGBUILD and .SRCINFO that follow the release's pacman file,
// and the push to the AUR, which happens only when an AUR key secret exists and the AUR_PUSH variable is on.
//
//   generate  node desktop/release/aur-package.mjs generate --tag <desktop-vX.Y.Z-N> --assets <folder> --template <desktop/aur> --out <folder>
//             The folder holds the release's pacman file and latest-linux.yml. The file is checked against the metadata (size and
//             SHA-512) before its SHA-256 goes into the PKGBUILD, so a damaged upload stops here.
//   gate      node desktop/release/aur-package.mjs gate --key <true|false> --variable <value> [--tag <tag>]
//   push      node desktop/release/aur-package.mjs push --dir <generated folder> --remote <git url> --tag <tag>   (reads AUR_KEY_PRESENT, AUR_PUSH)
//
// There is no `makepkg` on the runner, so both files are made by exact line replacement in the committed ones (desktop/aur), which
// fails if a line is missing or doubled. The tests compare the result with `makepkg --printsrcinfo` where it exists.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { emit, parseTag } from './decide.mjs';

export const PACKAGE_FILES = ['PKGBUILD', '.SRCINFO', 'opendoc-desktop-bin.install'];
const SHA256 = /^([0-9a-f]{64}|SKIP)$/;
const isOn = (value) => String(value ?? '').trim().toLowerCase() === 'true';

export const assetName = (version, build) => `opendoc-desktop-${version}-${build}-x64.pacman`;

function checkInputs({ version, build, sha256 }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`The version must be x.y.z, got "${version}".`);
  if (!/^[1-9]\d*$/.test(String(build))) throw new Error(`The build number must be a positive whole number, got "${build}".`);
  if (!SHA256.test(sha256)) throw new Error('The checksum must be 64 hex digits (or SKIP).');
}

// Replaces the one line a pattern matches; zero or several matches mean the template changed shape, which must not pass silently.
function replaceOne(text, pattern, replacement, label) {
  const count = [...text.matchAll(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`))].length;
  if (count !== 1) throw new Error(`The template needs exactly one ${label} line, found ${count}.`);
  return text.replace(pattern, () => replacement);
}

export function renderPkgbuild(template, { version, build, sha256 = 'SKIP' }) {
  checkInputs({ version, build, sha256 });
  let text = replaceOne(template, /^pkgver=.*$/m, `pkgver=${version}`, 'pkgver');
  text = replaceOne(text, /^pkgrel=.*$/m, `pkgrel=${build}`, 'pkgrel');
  return replaceOne(text, /^sha256sums=\(.*\)$/m, `sha256sums=('${sha256}')`, 'sha256sums');
}

export function renderSrcinfo(template, { version, build, sha256 = 'SKIP' }) {
  checkInputs({ version, build, sha256 });
  const url = template.match(/^\turl = (.+)$/m)?.[1];
  if (!url) throw new Error('The .SRCINFO template has no url line.');
  const asset = assetName(version, build);
  let text = replaceOne(template, /^\tpkgver = .*$/m, `\tpkgver = ${version}`, 'pkgver');
  text = replaceOne(text, /^\tpkgrel = .*$/m, `\tpkgrel = ${build}`, 'pkgrel');
  text = replaceOne(text, /^\tnoextract = .*$/m, `\tnoextract = ${asset}`, 'noextract');
  text = replaceOne(text, /^\tsource = .*$/m, `\tsource = ${asset}::${url}/releases/download/desktop-v${version}-${build}/${asset}`, 'source');
  return replaceOne(text, /^\tsha256sums = .*$/m, `\tsha256sums = ${sha256}`, 'sha256sums');
}

// The three files of the package for a version and build, made from the committed ones in `templateDir`.
export function renderPackage(templateDir, values) {
  const read = (name) => readFileSync(path.join(templateDir, name), 'utf8');
  return {
    PKGBUILD: renderPkgbuild(read('PKGBUILD'), values),
    '.SRCINFO': renderSrcinfo(read('.SRCINFO'), values),
    'opendoc-desktop-bin.install': read('opendoc-desktop-bin.install'),
  };
}

function digest(file, algorithm, encoding) {
  return createHash(algorithm).update(readFileSync(file)).digest(encoding);
}

// The pacman entry in latest-linux.yml: its SHA-512 (base64) and size, with the file's version and build.
export function readMetadata(text, asset) {
  const entry = new RegExp(`^ {2}- url: ${asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n {4}sha512: (\\S+)\\n {4}size: (\\d+)`, 'm').exec(text);
  if (!entry) throw new Error(`latest-linux.yml does not list ${asset}.`);
  return { sha512: entry[1], size: Number(entry[2]), version: text.match(/^version: (.+)$/m)?.[1], build: Number(text.match(/^build: (.+)$/m)?.[1]) };
}

// Everything `generate` checks and makes, from a release's tag, its downloaded files and the committed package files.
export function generate({ tag, assets, template }) {
  const parsed = parseTag(tag);
  if (!parsed) throw new Error(`"${tag}" is not a desktop-v<version>-<build> tag.`);
  const { version, build } = parsed;
  const asset = assetName(version, build);
  const file = path.join(assets, asset);
  if (!existsSync(file)) throw new Error(`The release has no ${asset} (found: ${readdirSync(assets).join(', ') || 'nothing'}).`);
  const metadata = readMetadata(readFileSync(path.join(assets, 'latest-linux.yml'), 'utf8'), asset);
  if (metadata.version !== version || metadata.build !== build) {
    throw new Error(`latest-linux.yml says ${metadata.version}-${metadata.build} but the tag says ${version}-${build}.`);
  }
  if (statSync(file).size !== metadata.size) throw new Error(`${asset} is ${statSync(file).size} bytes but latest-linux.yml says ${metadata.size}.`);
  if (digest(file, 'sha512', 'base64') !== metadata.sha512) throw new Error(`${asset} does not match the SHA-512 in latest-linux.yml.`);
  const sha256 = digest(file, 'sha256', 'hex');
  return { version, build, asset, sha256, rehearsal: parsed.rehearsal, files: renderPackage(template, { version, build, sha256 }) };
}

// Pushing to the AUR needs both an AUR key secret and the AUR_PUSH variable on, and never happens for a rehearsal tag.
export function aurPushDecision({ keyPresent, variable, tag }) {
  const reasons = [];
  if (!isOn(keyPresent)) reasons.push('there is no AUR key secret');
  if (!isOn(variable)) reasons.push('the AUR_PUSH variable is not on');
  if (tag !== undefined) {
    const parsed = parseTag(tag);
    if (!parsed) reasons.push(`"${tag}" is not a release tag`);
    else if (parsed.rehearsal) reasons.push('this is a rehearsal tag');
  }
  return { push: reasons.length === 0, reasons };
}

const IDENTITY = ['-c', 'user.name=opendoc-desktop release bot', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com'];

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout;
}

// Commits the generated files to the AUR repository's master branch. Does nothing, and says why, unless the decision allows it.
export function pushToAur({ dir, remote, tag, keyPresent, variable }) {
  const decision = aurPushDecision({ keyPresent, variable, tag });
  if (!decision.push) return { pushed: false, reason: `not pushing: ${decision.reasons.join('; ')}` };
  const { version, build } = parseTag(tag);
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'opendoc-aur-push-'));
  try {
    const clone = path.join(scratch, 'repo');
    git(['clone', '--quiet', remote, clone], scratch);
    git(['checkout', '--quiet', '-B', 'master'], clone);
    for (const name of PACKAGE_FILES) copyFileSync(path.join(dir, name), path.join(clone, name));
    git(['add', '--', ...PACKAGE_FILES], clone);
    if (git(['status', '--porcelain'], clone).trim() === '') return { pushed: false, reason: 'the AUR repository already has these files' };
    git([...IDENTITY, 'commit', '--quiet', '-m', `Update to ${version}-${build}`], clone);
    git(['push', '--quiet', 'origin', 'HEAD:master'], clone);
    return { pushed: true, reason: `pushed ${version}-${build}` };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    strict: true,
    options: Object.fromEntries(['tag', 'assets', 'template', 'out', 'key', 'variable', 'dir', 'remote'].map((name) => [name, { type: 'string' }])),
  });
  if (command === 'generate') {
    const result = generate({ tag: values.tag, assets: values.assets, template: values.template });
    mkdirSync(values.out, { recursive: true });
    for (const [name, text] of Object.entries(result.files)) writeFileSync(path.join(values.out, name), text);
    emit({ version: result.version, build: result.build, asset: result.asset, sha256: result.sha256 });
  } else if (command === 'gate') {
    const decision = aurPushDecision({ keyPresent: values.key, variable: values.variable, tag: values.tag });
    console.log(decision.push ? 'The AUR push is on.' : `The AUR push stays off: ${decision.reasons.join('; ')}.`);
    emit({ push: decision.push });
  } else if (command === 'push') {
    const result = pushToAur({ dir: values.dir, remote: values.remote, tag: values.tag, keyPresent: process.env.AUR_KEY_PRESENT, variable: process.env.AUR_PUSH });
    console.log(result.reason);
    emit({ pushed: result.pushed });
  } else {
    console.error('usage: aur-package.mjs generate|gate|push [options] (see the header of this file)');
    process.exit(2);
  }
}
