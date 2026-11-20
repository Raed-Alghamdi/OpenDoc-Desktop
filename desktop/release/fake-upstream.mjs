#!/usr/bin/env node
// Makes a stand-in for upstream's `main` that bumps OpenDoc's version, for rehearsing upstream-watch.yml (the tag, the issue and the
// release it makes are marked as a rehearsal). One commit on top of <base>, written with git plumbing: nothing is checked out and no
// working file changes. It makes a local branch only; pushing it is a separate, deliberate step.
//
//   node desktop/release/fake-upstream.mjs --base origin/main --kind patch    --branch test/fake-upstream-patch
//   node desktop/release/fake-upstream.mjs --base origin/main --kind minor    --branch test/fake-upstream-minor
//   node desktop/release/fake-upstream.mjs --base origin/main --kind conflict --branch test/fake-upstream-conflict
//
// patch: the version's last number plus one. minor: the middle number plus one, the last set to 0. conflict: a patch bump that
// also adds desktop/package.json, which the fork has too with other contents, so merging it into a branch cut from `roadmap` conflicts
// (use a <base> without a desktop folder, such as origin/main). Add --repo <folder> to work in another repository.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseVersion } from './decide.mjs';

const AUTHOR = { GIT_AUTHOR_NAME: 'fake upstream', GIT_AUTHOR_EMAIL: 'fake-upstream@users.noreply.github.com' };

export function bumpedVersion(version, kind) {
  const [major, minor, patch] = parseVersion(version);
  return kind === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

export function makeFakeUpstream({ repo = '.', base, kind, branch }) {
  if (!['patch', 'minor', 'conflict'].includes(kind)) throw new Error(`The kind must be patch, minor or conflict, got "${kind}".`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch ?? '') || branch.includes('..')) throw new Error(`"${branch}" is not a branch name this script accepts.`);
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'opendoc-fake-upstream-'));
  const env = { ...process.env, ...AUTHOR, GIT_COMMITTER_NAME: AUTHOR.GIT_AUTHOR_NAME, GIT_COMMITTER_EMAIL: AUTHOR.GIT_AUTHOR_EMAIL, GIT_INDEX_FILE: path.join(scratch, 'index') };
  const git = (args, input) => {
    const result = spawnSync('git', args, { cwd: repo, env, input, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
    return result.stdout.trim();
  };
  try {
    if (spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repo }).status === 0) throw new Error(`The branch ${branch} already exists.`);
    const baseSha = git(['rev-parse', '--verify', `${base}^{commit}`]);
    const manifest = git(['show', `${baseSha}:package.json`]);
    const found = manifest.match(/^ {2}"version": "(\d+\.\d+\.\d+)",$/m);
    if (!found) throw new Error('The base package.json has no top-level version line.');
    const version = bumpedVersion(found[1], kind);
    git(['read-tree', baseSha]);
    const addFile = (file, text) => git(['update-index', '--add', '--cacheinfo', `100644,${git(['hash-object', '-w', '--stdin'], text)},${file}`]);
    addFile('package.json', `${manifest.replace(found[0], `  "version": "${version}",`)}\n`);
    if (kind === 'conflict') addFile('desktop/package.json', '{\n  "name": "fake-upstream-conflict"\n}\n');
    const commit = git(['commit-tree', git(['write-tree']), '-p', baseSha, '-m', `Fake upstream: OpenDoc ${version} (rehearsal only)`]);
    git(['update-ref', `refs/heads/${branch}`, commit]);
    return { branch, sha: commit, version, base: baseSha };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { base: { type: 'string' }, kind: { type: 'string' }, branch: { type: 'string' }, repo: { type: 'string', default: '.' } }, strict: true });
  if (!values.base || !values.kind || !values.branch) {
    console.error('usage: fake-upstream.mjs --base <ref> --kind patch|minor|conflict --branch <new branch> [--repo <folder>]');
    process.exit(2);
  }
  const made = makeFakeUpstream(values);
  console.log(`${made.branch} ${made.sha} (OpenDoc ${made.version}, on ${made.base.slice(0, 12)}); local only, push it yourself`);
}
