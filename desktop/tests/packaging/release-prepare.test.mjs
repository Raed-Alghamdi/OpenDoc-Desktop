// The git half of upstream-watch.yml (desktop/release/prepare.mjs, set-version.mjs, fake-upstream.mjs) on scratch repositories:
// an "upstream", the fork's bare "origin" and a working clone on `roadmap`. Nothing here reaches a network or the real repositories.
// The last test chains this with decide.mjs for each row of the release rules.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decideRelease } from '../../release/decide.mjs';
import { makeFakeUpstream } from '../../release/fake-upstream.mjs';
import { prepare, rehearsalMirror } from '../../release/prepare.mjs';
import { setDesktopVersion } from '../../release/set-version.mjs';

const desktop = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test' };
let scratch;
let counter = 0;
before(() => { scratch = mkdtempSync(path.join(os.tmpdir(), 'opendoc-prepare-test-')); });
after(() => rmSync(scratch, { recursive: true, force: true }));

const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...ident } });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};
const manifest = (version, extra = '') => `{\n  "name": "opendoc",\n  "version": "${version}",\n  "private": true${extra}\n}\n`;
const write = (root, file, text) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), text); };
const commit = (root, message) => { git(root, 'add', '-A'); git(root, 'commit', '--quiet', '-m', message); return git(root, 'rev-parse', 'HEAD'); };

// upstream (0.6.1 on main), origin.git (a bare copy of it, as the fork), and work (a clone on roadmap: the desktop folder, the AUR
// files, and a roadmap-only change to README.md).
function world() {
  counter += 1;
  const dir = path.join(scratch, `world-${counter}`);
  const upstream = path.join(dir, 'upstream');
  const origin = path.join(dir, 'origin.git');
  const work = path.join(dir, 'work');
  mkdirSync(upstream, { recursive: true });
  git(upstream, 'init', '--quiet', '-b', 'main');
  write(upstream, 'package.json', manifest('0.6.1'));
  write(upstream, 'README.md', 'line one\nline two\nline three\n');
  write(upstream, 'src/a.txt', 'a\n');
  commit(upstream, 'OpenDoc 0.6.1');
  git(dir, 'clone', '--quiet', '--bare', upstream, origin);
  git(dir, 'clone', '--quiet', origin, work);
  git(work, 'checkout', '--quiet', '-b', 'roadmap');
  write(work, 'desktop/package.json', manifest('0.6.1', ',\n  "type": "module"'));
  cpSync(path.join(desktop, 'aur'), path.join(work, 'desktop', 'aur'), { recursive: true });
  // The copied AUR files carry this checkout's version, which a release or a rehearsal moves on: give them the world's.
  setDesktopVersion(work, '0.6.1', 1);
  write(work, 'README.md', 'line one\nroadmap line two\nline three\n');
  commit(work, 'Desktop app');
  git(work, 'push', '--quiet', 'origin', 'roadmap');
  return { dir, upstream, origin, work, main: git(origin, 'rev-parse', 'refs/heads/main') };
}
const ref = (repo, name) => spawnSync('git', ['rev-parse', '--verify', '--quiet', name], { cwd: repo, encoding: 'utf8' }).stdout.trim();
const upstreamRelease = (w, version, { file = 'src/a.txt', text = 'b\n', readme } = {}) => {
  write(w.upstream, 'package.json', manifest(version));
  write(w.upstream, file, text);
  if (readme) write(w.upstream, 'README.md', readme);
  return commit(w.upstream, `OpenDoc ${version}`);
};
const options = (w, more = {}) => ({ repo: w.work, target: 'roadmap', upstreamUrl: w.upstream, runId: '11', ...more });
const clean = (w) => { assert.equal(git(w.work, 'status', '--porcelain'), ''); assert.equal(git(w.work, 'rev-parse', '--abbrev-ref', 'HEAD'), 'roadmap'); };

test('a clean patch: the mirror follows, the merge sits on a candidate branch with the desktop version bumped, roadmap is untouched', () => {
  const w = world();
  const roadmap = ref(w.origin, 'refs/heads/roadmap');
  const upstreamSha = upstreamRelease(w, '0.6.2');
  const result = prepare(options(w));
  assert.deepEqual([result.action, result.kind, result.version, result.build, result.tag, result.rehearsal], ['check', 'patch', '0.6.2', 1, 'desktop-v0.6.2-1', false]);
  assert.equal(result.upstreamSha, upstreamSha);
  assert.equal(ref(w.origin, 'refs/heads/main'), upstreamSha, 'main mirrors upstream');
  assert.equal(result.mirrorBranch, 'main');
  assert.equal(result.candidateBranch, 'watch/v0.6.2-r11');
  assert.equal(ref(w.origin, 'refs/heads/watch/v0.6.2-r11'), result.candidateSha);
  assert.equal(ref(w.origin, 'refs/heads/roadmap'), roadmap, 'roadmap itself does not move');
  const parents = git(w.origin, 'rev-list', '--parents', '-n', '1', result.candidateSha).split(' ').slice(1);
  assert.equal(parents.length, 1, 'the last commit is the version bump');
  assert.equal(git(w.origin, 'log', '-1', '--format=%s', result.candidateSha), 'Set the desktop app to OpenDoc 0.6.2');
  const merge = git(w.origin, 'rev-list', '--parents', '-n', '1', parents[0]).split(' ');
  assert.equal(merge.length, 3, 'the commit before it is a merge of roadmap and upstream');
  assert.ok(merge.includes(roadmap) && merge.includes(upstreamSha));
  assert.equal(git(w.origin, 'log', '-1', '--format=%s', parents[0]), 'Merge upstream OpenDoc 0.6.2 into roadmap');
  const show = (file) => git(w.origin, 'show', `${result.candidateSha}:${file}`);
  assert.equal(JSON.parse(show('desktop/package.json')).version, '0.6.2');
  assert.equal(JSON.parse(show('package.json')).version, '0.6.2');
  assert.match(show('desktop/aur/PKGBUILD'), /^pkgver=0\.6\.2$/m);
  assert.match(show('desktop/aur/.SRCINFO'), /^\tpkgver = 0\.6\.2$/m);
  assert.equal(show('README.md'), 'line one\nroadmap line two\nline three', 'the roadmap-only change survives the merge');
  assert.equal(git(w.origin, 'log', '-1', '--format=%ae', result.candidateSha), '41898282+github-actions[bot]@users.noreply.github.com');
  clean(w);
});

test('a new minor is prepared the same way; a rehearsal tag of that version does not count as published', () => {
  const w = world();
  upstreamRelease(w, '0.7.0');
  const result = prepare(options(w, { tags: ['desktop-v0.6.1-1', 'dryrun-desktop-v0.7.0-9'] }));
  assert.deepEqual([result.action, result.kind, result.version, result.build, result.tag], ['check', 'minor', '0.7.0', 1, 'desktop-v0.7.0-1']);
  assert.equal(result.minorPublished, false);
  assert.match(git(w.origin, 'show', `${result.candidateSha}:desktop/aur/PKGBUILD`), /^pkgrel=1$/m);
});

test('a patch of a minor that has a published tag says so', () => {
  const w = world();
  upstreamRelease(w, '0.6.2');
  assert.equal(prepare(options(w, { tags: ['desktop-v0.6.1-1'] })).minorPublished, true);
  const w2 = world();
  upstreamRelease(w2, '0.6.2');
  assert.equal(prepare(options(w2, { tags: [] })).minorPublished, false);
  const w3 = world();
  upstreamRelease(w3, '0.6.2');
  assert.equal(prepare(options(w3, { tags: [], assumeMinorPublished: true })).minorPublished, true);
});

test('a conflict stops: the merge is aborted, only the mirror is pushed, and the checkout is clean', () => {
  const w = world();
  const upstreamSha = upstreamRelease(w, '0.6.2', { readme: 'line one\nupstream line two\nline three\n' });
  const before = git(w.origin, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/roadmap');
  const result = prepare(options(w));
  assert.deepEqual([result.action, result.kind, result.stop], ['stopped', 'conflict', 'conflict']);
  assert.match(result.detail, /README\.md/);
  assert.equal(ref(w.origin, 'refs/heads/main'), upstreamSha, 'the mirror is still a plain copy');
  assert.equal(git(w.origin, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/roadmap'), before);
  assert.equal(git(w.origin, 'for-each-ref', 'refs/heads/watch'), '', 'no candidate branch was pushed');
  assert.equal(git(w.work, 'branch', '--list', 'watch/*'), '', 'no local candidate branch is left');
  assert.ok(!existsSync(path.join(w.work, '.git', 'MERGE_HEAD')));
  clean(w);
});

test('no new version: nothing to do, but the mirror is still updated', () => {
  const w = world();
  const sha = upstreamRelease(w, '0.6.1', { text: 'changed without a release\n' });
  const result = prepare(options(w));
  assert.deepEqual([result.action, result.kind], ['none', 'none']);
  assert.match(result.reason, /still at 0\.6\.1/);
  assert.equal(ref(w.origin, 'refs/heads/main'), sha);
  assert.equal(git(w.origin, 'for-each-ref', 'refs/heads/watch'), '');
});

test('an upstream older than the branch stops, and a prerelease version is ignored', () => {
  const w = world();
  write(w.work, 'package.json', manifest('0.6.3'));
  write(w.work, 'desktop/package.json', manifest('0.6.3', ',\n  "type": "module"'));
  commit(w.work, 'ahead');
  const older = prepare(options(w));
  assert.deepEqual([older.action, older.kind, older.stop], ['stopped', 'stopped', 'older']);
  const w2 = world();
  upstreamRelease(w2, '0.7.0-beta.1');
  assert.equal(prepare(options(w2)).action, 'none');
});

test('an open issue for that version holds the run back; a retry goes on', () => {
  const w = world();
  upstreamRelease(w, '0.6.2');
  const issues = [{ number: 5, title: '[upstream-watch] OpenDoc 0.6.2: a check is red, nothing published' }];
  const waiting = prepare(options(w, { issues }));
  assert.deepEqual([waiting.action, waiting.kind], ['waiting', 'patch']);
  assert.match(waiting.reason, /#5/);
  assert.equal(git(w.origin, 'for-each-ref', 'refs/heads/watch'), '');
  assert.equal(prepare(options(w, { issues, retry: true })).action, 'check');
});

test('a mirror that someone committed to is not overwritten: the run stops', () => {
  const w = world();
  write(w.work, 'stray.txt', 'x\n');
  git(w.work, 'checkout', '--quiet', 'main');
  commit(w.work, 'a commit on the mirror');
  git(w.work, 'push', '--quiet', 'origin', 'main');
  git(w.work, 'checkout', '--quiet', 'roadmap');
  const strayMain = ref(w.origin, 'refs/heads/main');
  upstreamRelease(w, '0.6.2');
  const result = prepare(options(w));
  assert.deepEqual([result.action, result.stop], ['stopped', 'mirror']);
  assert.equal(ref(w.origin, 'refs/heads/main'), strayMain);
  assert.equal(git(w.origin, 'for-each-ref', 'refs/heads/watch'), '');
});

test('rebuild and hand-merged build the branch as it stands, one build up, with nothing to merge', () => {
  const w = world();
  const tip = git(w.work, 'rev-parse', 'HEAD');
  const rebuild = prepare(options(w, { mode: 'rebuild', tags: ['desktop-v0.6.1-1', 'desktop-v0.6.1-2'] }));
  assert.deepEqual([rebuild.action, rebuild.kind, rebuild.version, rebuild.build, rebuild.tag, rebuild.candidateSha, rebuild.candidateBranch], ['check', 'rebuild', '0.6.1', 3, 'desktop-v0.6.1-3', tip, '']);
  const by = prepare(options(w, { mode: 'hand-merged', tags: [] }));
  assert.deepEqual([by.action, by.kind, by.build], ['check', 'hand-merged', 1]);
  assert.equal(git(w.origin, 'for-each-ref', 'refs/heads/watch'), '');
});

test('a branch whose desktop version differs from the root version is stopped before any build', () => {
  const w = world();
  write(w.work, 'package.json', manifest('0.6.2'));
  commit(w.work, 'hand merge that forgot the desktop version');
  const result = prepare(options(w, { mode: 'hand-merged' }));
  assert.deepEqual([result.action, result.stop], ['stopped', 'version-mismatch']);
});

test('names that could smuggle options or paths are refused', () => {
  const w = world();
  for (const bad of ['--upload-pack=x', 'a..b', '', 'has space', '/abs', 'trail/']) assert.throws(() => prepare(options(w, { upstreamRef: bad || ' ' })), /not a branch name|upstream ref/, bad);
  assert.throws(() => prepare(options(w, { target: 'other' })), /not on the target/);
});

test('--no-push keeps everything local', () => {
  const w = world();
  upstreamRelease(w, '0.6.2');
  const before = git(w.origin, 'for-each-ref', '--format=%(refname) %(objectname)');
  const result = prepare(options(w, { push: false }));
  assert.equal(result.action, 'check');
  assert.equal(git(w.origin, 'for-each-ref', '--format=%(refname) %(objectname)'), before);
});

test('set-version is idempotent and changes only the desktop version and the AUR files', () => {
  const w = world();
  assert.deepEqual(setDesktopVersion(w.work, '0.6.1', 1), []);
  assert.deepEqual(setDesktopVersion(w.work, '0.6.5', 2).sort(), ['desktop/aur/.SRCINFO', 'desktop/aur/PKGBUILD', 'desktop/package.json']);
  assert.deepEqual(setDesktopVersion(w.work, '0.6.5', 2), []);
  assert.equal(JSON.parse(readFileSync(path.join(w.work, 'desktop/package.json'), 'utf8')).version, '0.6.5');
  assert.equal(git(w.work, 'status', '--porcelain').split('\n').length, 3);
  assert.throws(() => setDesktopVersion(w.work, '0.6', 1), /x\.y\.z/);
});

// The rehearsal a maintainer runs on GitHub: fake upstream branches made by fake-upstream.mjs, a test target branch.
test('a rehearsal never writes main or a real tag: fake upstream patch, minor and conflict on a test branch', () => {
  const w = world();
  git(w.work, 'checkout', '--quiet', '-b', 'test/dryrun');
  git(w.work, 'push', '--quiet', 'origin', 'test/dryrun');
  const realMain = ref(w.origin, 'refs/heads/main');
  const realRoadmap = ref(w.origin, 'refs/heads/roadmap');
  for (const kind of ['patch', 'minor', 'conflict']) {
    const made = makeFakeUpstream({ repo: w.work, base: 'origin/main', kind, branch: `test/fake-upstream-${kind}` });
    git(w.work, 'push', '--quiet', 'origin', `test/fake-upstream-${kind}`);
    assert.equal(made.version, kind === 'minor' ? '0.7.0' : '0.6.2');
  }
  assert.throws(() => makeFakeUpstream({ repo: w.work, base: 'origin/main', kind: 'patch', branch: 'test/fake-upstream-patch' }), /already exists/);
  assert.equal(git(w.work, 'rev-parse', '--abbrev-ref', 'HEAD'), 'test/dryrun', 'making a fake upstream checks nothing out');
  assert.equal(git(w.work, 'status', '--porcelain'), '');

  const run = (kind, more = {}) => prepare({ repo: w.work, target: 'test/dryrun', upstreamRef: `test/fake-upstream-${kind}`, runId: ({ patch: '91', minor: '92', conflict: '93' })[kind], ...more });
  const patch = run('patch');
  assert.deepEqual([patch.action, patch.kind, patch.version, patch.rehearsal, patch.tag, patch.mirrorBranch], ['check', 'patch', '0.6.2', true, 'dryrun-desktop-v0.6.2-1', rehearsalMirror('91')]);
  assert.equal(ref(w.origin, `refs/heads/${rehearsalMirror('91')}`), git(w.origin, 'rev-parse', 'refs/heads/test/fake-upstream-patch'));
  const minor = run('minor');
  assert.deepEqual([minor.action, minor.kind, minor.version], ['check', 'minor', '0.7.0']);
  const conflict = run('conflict');
  assert.deepEqual([conflict.action, conflict.kind], ['stopped', 'conflict']);
  assert.match(conflict.detail, /desktop\/package\.json/);

  assert.equal(ref(w.origin, 'refs/heads/main'), realMain, 'main is untouched');
  assert.equal(ref(w.origin, 'refs/heads/roadmap'), realRoadmap, 'roadmap is untouched');
  assert.equal(git(w.origin, 'tag', '--list'), '');
  assert.equal(git(w.work, 'rev-parse', '--abbrev-ref', 'HEAD'), 'test/dryrun');
});

test('the command line writes the workflow outputs', () => {
  const w = world();
  upstreamRelease(w, '0.6.2');
  const outputs = path.join(w.dir, 'outputs.txt');
  const tags = path.join(w.dir, 'tags.txt');
  writeFileSync(tags, 'desktop-v0.6.1-1\n');
  writeFileSync(path.join(w.dir, 'issues.json'), '[]');
  const cli = path.join(desktop, 'release', 'prepare.mjs');
  const result = spawnSync(process.execPath, [cli, '--repo', w.work, '--target', 'roadmap', '--upstream-url', w.upstream, '--run-id', '77', '--tags', tags, '--issues', path.join(w.dir, 'issues.json')], {
    encoding: 'utf8', env: { ...process.env, ...ident, GITHUB_OUTPUT: outputs },
  });
  assert.equal(result.status, 0, result.stderr);
  const lines = Object.fromEntries(readFileSync(outputs, 'utf8').trim().split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  assert.deepEqual([lines.action, lines.kind, lines.version, lines.build, lines.tag, lines.rehearsal, lines.candidate_branch, lines.minor_published],
    ['check', 'patch', '0.6.2', '1', 'desktop-v0.6.2-1', 'false', 'watch/v0.6.2-r77', 'true']);
  assert.match(lines.candidate_sha, /^[0-9a-f]{40}$/);
});

// The release rules, end to end on the scratch repositories: what prepare finds feeds what decide.mjs does with the check results.
test('the done-when list, row by row, through prepare and decide', () => {
  const outcome = (w, { gate, verify = 'success', desktop: built = 'success', mode = 'auto', tags = ['desktop-v0.6.1-1'] }) => {
    const found = prepare(options(w, { mode, tags }));
    const decision = decideRelease({ kind: found.kind, version: found.version, build: found.build, gate, verify, desktop: built, minorPublished: found.minorPublished, rehearsal: found.rehearsal });
    return { found, decision };
  };
  const patch = () => { const w = world(); upstreamRelease(w, '0.6.2'); return w; };

  const off = outcome(patch(), { gate: 'false' });
  assert.deepEqual([off.decision.outcome, off.decision.publish], ['draft', false], 'a fake patch bump ends in a draft with the gate off');
  const on = outcome(patch(), { gate: 'true' });
  assert.deepEqual([on.decision.outcome, on.decision.publish, on.decision.promote], ['published', true, true], 'and is published with the gate on');

  const w = world();
  upstreamRelease(w, '0.7.0');
  assert.deepEqual([outcome(w, { gate: 'true' }).decision.outcome, outcome(world(), { gate: 'true', mode: 'rebuild', tags: ['desktop-v0.6.1-1'] }).decision.outcome], ['draft', 'draft'], 'a minor and a rebuild stay drafts');
  const red = outcome(patch(), { gate: 'true', verify: 'failure' });
  assert.deepEqual([red.decision.outcome, red.decision.publish, red.decision.promote], ['draft', false, false], 'a red check stays a draft');

  const w2 = world();
  upstreamRelease(w2, '0.6.2', { readme: 'line one\nupstream line two\nline three\n' });
  const conflict = outcome(w2, { gate: 'true' });
  assert.deepEqual([conflict.found.action, conflict.decision.outcome, conflict.decision.release, conflict.decision.publish], ['stopped', 'stopped', 'none', false], 'a conflict stops and publishes nothing');
  assert.equal(git(w2.origin, 'for-each-ref', 'refs/heads/watch'), '');
});
