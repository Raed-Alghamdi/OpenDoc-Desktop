#!/usr/bin/env node
// For desktop.yml: works out the build number and whether the shell exists yet, and writes them to $GITHUB_OUTPUT.
//   build  a desktop-v<version>-<build> tag gives its number; otherwise $INPUT_BUILD, then 1
//          The tag is the pushed tag, or $RELEASE_TAG when upstream-watch.yml calls the workflow for a release it names (a rehearsal's
//          name carries a `dryrun-` prefix). With $RELEASE_TAG, $INPUT_BUILD must say the same number.
//   stub   "--stub" while desktop/package.json has no `main` (the shell has not merged), otherwise empty
// A tag must match both package versions and must not be a stub build. Failing here keeps a mislabelled release from being built.
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const read = (file) => JSON.parse(readFileSync(path.join(repo, file), 'utf8'));
const { version } = read('package.json');
const desktop = read('desktop/package.json');
if (desktop.version !== version) throw new Error(`desktop/package.json is ${desktop.version} but the core is ${version}.`);

const stub = desktop.main ? '' : '--stub';
let build = process.env.INPUT_BUILD || '1';
const ref = process.env.GITHUB_REF ?? '';
const named = process.env.RELEASE_TAG ?? '';
const tagName = named || (ref.startsWith('refs/tags/') ? ref.slice('refs/tags/'.length) : '');
if (tagName) {
  const tag = tagName.match(/^(?:dryrun-)?desktop-v(\d+\.\d+\.\d+)-([1-9]\d*)$/);
  if (!tag) throw new Error(`The tag ${tagName} is not desktop-v<version>-<build>.`);
  if (tag[1] !== version) throw new Error(`The tag says ${tag[1]} but the app is ${version}.`);
  if (stub) throw new Error('A release cannot be built from the stub entry: desktop/package.json has no main.');
  if (named && process.env.INPUT_BUILD && process.env.INPUT_BUILD !== tag[2]) throw new Error(`The release ${named} says build ${tag[2]} but the build input is ${process.env.INPUT_BUILD}.`);
  build = tag[2];
}
if (!/^[1-9]\d*$/.test(build)) throw new Error(`The build number must be a positive whole number, got "${build}".`);

console.log(`version ${version}, build ${build}${stub ? ', stub entry' : ''}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `build=${build}\nstub=${stub}\n`);
