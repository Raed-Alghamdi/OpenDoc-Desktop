#!/usr/bin/env node
// The first half of upstream-watch.yml: fetch upstream, mirror it, and prepare the merge on a candidate branch. It decides nothing
// about publishing (decide.mjs does) and never touches the target branch: the candidate is checked first, and only then moved into
// the target by a fast-forward (never a force). A conflict is detected here, aborted, and reported; nothing is pushed for it except
// the mirror, which is a plain copy of upstream's main.
//
// Run from a checkout of the target branch with its tags, with `origin` pointing at the fork:
//   node desktop/release/prepare.mjs --target roadmap --upstream-url <url> [--upstream-branch main] [--upstream-ref <fork branch>]
//        [--mode auto|rebuild|hand-merged] [--run-id <n>] [--tags <file>] [--issues <file>] [--retry true] [--assume-minor-published true]
//        [--no-push]
// --tags is a text file with one release or git tag per line (published ones; drafts are replaced, not counted), --issues the JSON of
// `gh issue list --json number,title`. A run is a rehearsal when the target is not `roadmap` or an --upstream-ref stands in for
// upstream: its mirror goes to its own rehearsal branch (never `main`, and a new name each run, so no push is ever forced), and its
// release tag gets a `dryrun-` prefix.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { emit, minorPublished, nextBuild, planWatch, tagName } from './decide.mjs';
import { setDesktopVersion } from './set-version.mjs';

export const DEFAULT_TARGET = 'roadmap';
export const rehearsalMirror = (runId) => `watch-rehearsal/mirror-r${runId}`;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const IDENTITY = ['-c', 'user.name=opendoc-desktop release bot', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com'];

function checkBranch(name, label) {
  if (!BRANCH.test(name ?? '') || name.includes('..') || name.endsWith('/') || name.endsWith('.lock')) throw new Error(`The ${label} "${name}" is not a branch name this script accepts.`);
  return name;
}

export function prepare({
  repo, target = DEFAULT_TARGET, mode = 'auto', upstreamUrl, upstreamBranch = 'main', upstreamRef = '', runId = '0',
  tags = [], issues = [], retry = false, assumeMinorPublished = false, push = true,
}) {
  const git = (args, { allowFail = false } = {}) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    if (result.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`);
    return { status: result.status, out: result.stdout.trim(), err: result.stderr.trim() };
  };
  const versionAt = (ref) => JSON.parse(git(['show', `${ref}:package.json`]).out).version;
  const rehearsal = target !== DEFAULT_TARGET || Boolean(upstreamRef);
  checkBranch(target, 'target branch');
  if (upstreamRef) checkBranch(upstreamRef, 'upstream ref');
  const here = git(['rev-parse', '--abbrev-ref', 'HEAD']).out;
  if (here !== target) throw new Error(`The checkout is on ${here}, not on the target ${target}.`);

  const targetSha = git(['rev-parse', 'HEAD']).out;
  const targetVersion = versionAt('HEAD');
  const result = { action: 'none', kind: 'none', rehearsal, targetVersion, targetSha, mirrorBranch: '', upstreamSha: '', upstreamVersion: '', candidateBranch: '', candidateSha: '', version: '', build: 0, tag: '', minorPublished: false, stop: '', detail: '', reason: '' };
  const finish = (fields) => Object.assign(result, fields);
  const ready = (kind, version, candidateSha, candidateBranch = '') => {
    const build = nextBuild(version, tags);
    return finish({ action: 'check', kind, version, build, tag: tagName(version, build, rehearsal), candidateSha, candidateBranch, minorPublished: assumeMinorPublished || minorPublished(version, tags) });
  };
  const desktopVersion = () => JSON.parse(git(['show', 'HEAD:desktop/package.json']).out).version;

  if (mode === 'rebuild' || mode === 'hand-merged') {
    const plan = planWatch({ mode, targetVersion, rehearsal });
    if (desktopVersion() !== targetVersion) {
      return finish({ action: 'stopped', kind: 'stopped', stop: 'version-mismatch', reason: `desktop/package.json is ${desktopVersion()} but package.json is ${targetVersion}`, version: targetVersion });
    }
    return ready(plan.kind, targetVersion, targetSha);
  }

  // Fetch upstream: the real one by address, or (a rehearsal) a branch of the fork that stands in for it.
  if (upstreamRef) git(['fetch', '--quiet', '--no-tags', 'origin', `refs/heads/${upstreamRef}`]);
  else git(['fetch', '--quiet', '--no-tags', upstreamUrl, `refs/heads/${upstreamBranch}`]);
  const upstreamSha = git(['rev-parse', 'FETCH_HEAD']).out;
  const upstreamVersion = versionAt(upstreamSha);
  finish({ upstreamSha, upstreamVersion, mirrorBranch: rehearsal ? checkBranch(rehearsalMirror(runId), 'mirror branch') : upstreamBranch });

  // The mirror is a plain copy: a fast-forward push, never a force. A diverged mirror means someone committed to it.
  if (push) {
    const pushed = git(['push', '--quiet', 'origin', `${upstreamSha}:refs/heads/${result.mirrorBranch}`], { allowFail: true });
    if (pushed.status !== 0) return finish({ action: 'stopped', kind: 'stopped', version: upstreamVersion, stop: 'mirror', reason: `the mirror branch ${result.mirrorBranch} could not be updated`, detail: pushed.err });
  }

  const plan = planWatch({ mode, targetVersion, upstreamVersion, issues, retry, rehearsal });
  if (plan.action === 'stopped') return finish({ action: 'stopped', kind: 'stopped', version: upstreamVersion, stop: plan.stop, reason: plan.reason });
  if (plan.action !== 'merge') return finish({ action: plan.action, kind: plan.kind, reason: plan.reason, version: plan.version ?? '' });

  const candidateBranch = checkBranch(`watch/v${plan.version}-r${runId}`, 'candidate branch');
  const back = () => { git(['checkout', '--quiet', target]); git(['branch', '-D', candidateBranch], { allowFail: true }); };
  git(['checkout', '--quiet', '-b', candidateBranch]);
  const merged = git([...IDENTITY, 'merge', '--no-ff', '--no-edit', '-m', `Merge upstream OpenDoc ${plan.version} into ${target}`, upstreamSha], { allowFail: true });
  if (merged.status !== 0) {
    const files = git(['diff', '--name-only', '--diff-filter=U'], { allowFail: true }).out.split('\n').filter(Boolean);
    git(['merge', '--abort'], { allowFail: true });
    back();
    if (files.length === 0) throw new Error(`The merge failed without a conflict: ${merged.err || merged.out}`);
    return finish({ action: 'stopped', kind: 'conflict', version: plan.version, stop: 'conflict', reason: `merging upstream ${plan.version} into ${target} conflicts`, detail: `Conflicting files: ${files.join(', ')}` });
  }
  if (versionAt('HEAD') !== plan.version) {
    back();
    throw new Error(`After the merge package.json says ${versionAt('HEAD')}, not ${plan.version}.`);
  }
  // upstream moves only the root version; the desktop app follows it.
  const build = nextBuild(plan.version, tags);
  const changed = setDesktopVersion(repo, plan.version, build);
  if (changed.length) {
    git(['add', '--', ...changed]);
    git([...IDENTITY, 'commit', '--quiet', '-m', `Set the desktop app to OpenDoc ${plan.version}`]);
  }
  const candidateSha = git(['rev-parse', 'HEAD']).out;
  if (push) {
    const pushed = git(['push', '--quiet', 'origin', `refs/heads/${candidateBranch}:refs/heads/${candidateBranch}`], { allowFail: true });
    if (pushed.status !== 0) {
      git(['checkout', '--quiet', target]);
      return finish({ action: 'stopped', kind: 'stopped', version: plan.version, stop: 'push', reason: `the candidate branch ${candidateBranch} could not be pushed`, detail: pushed.err });
    }
  }
  git(['checkout', '--quiet', target]);
  return ready(plan.kind, plan.version, candidateSha, candidateBranch);
}

const lines = (file) => (file && existsSync(file) ? readFileSync(file, 'utf8').split('\n').map((line) => line.trim()).filter(Boolean) : []);

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      target: { type: 'string', default: DEFAULT_TARGET }, 'upstream-url': { type: 'string' }, 'upstream-branch': { type: 'string', default: 'main' },
      'upstream-ref': { type: 'string', default: '' }, mode: { type: 'string', default: 'auto' }, 'run-id': { type: 'string', default: '0' },
      tags: { type: 'string' }, issues: { type: 'string' }, retry: { type: 'string', default: 'false' }, 'assume-minor-published': { type: 'string', default: 'false' },
      'no-push': { type: 'boolean', default: false }, repo: { type: 'string', default: '.' },
    },
    strict: true,
  });
  if (!values['upstream-url'] && !values['upstream-ref'] && values.mode === 'auto') {
    console.error('usage: prepare.mjs --target <branch> --upstream-url <url> [options] (see the header of this file)');
    process.exit(2);
  }
  const result = prepare({
    repo: path.resolve(values.repo), target: values.target, mode: values.mode, upstreamUrl: values['upstream-url'], upstreamBranch: values['upstream-branch'],
    upstreamRef: values['upstream-ref'], runId: values['run-id'], tags: lines(values.tags),
    issues: values.issues && existsSync(values.issues) ? JSON.parse(readFileSync(values.issues, 'utf8') || '[]') : [],
    retry: values.retry === 'true', assumeMinorPublished: values['assume-minor-published'] === 'true', push: !values['no-push'],
  });
  emit({
    action: result.action, kind: result.kind, version: result.version, build: result.build, tag: result.tag, rehearsal: result.rehearsal,
    candidate_sha: result.candidateSha, candidate_branch: result.candidateBranch, upstream_sha: result.upstreamSha, mirror_branch: result.mirrorBranch,
    minor_published: result.minorPublished, stop: result.stop, reason: result.reason, detail: result.detail,
  });
}
