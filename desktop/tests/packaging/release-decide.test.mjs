// The release decisions of upstream-watch.yml (desktop/release/decide.mjs): version compare, patch or minor, build numbers, the gate,
// and the report text. One test per row of the release rules, plus the edges around them.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  classifyBump, compareVersions, decideRelease, findWaitingIssue, finalReport, minorPublished, nextBuild, parseTag, planWatch, releaseNotes, tagName,
} from '../../release/decide.mjs';

test('versions compare numerically and classify as same, older, patch or minor', () => {
  assert.equal(compareVersions('0.6.10', '0.6.9'), 1);
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
  assert.equal(compareVersions('0.6.1', '0.6.1'), 0);
  assert.equal(classifyBump('0.6.1', '0.6.1'), 'same');
  assert.equal(classifyBump('0.6.1', '0.6.0'), 'older');
  assert.equal(classifyBump('0.6.1', '0.6.2'), 'patch');
  assert.equal(classifyBump('0.6.1', '0.6.9'), 'patch');
  assert.equal(classifyBump('0.6.1', '0.7.0'), 'minor');
  assert.equal(classifyBump('0.6.1', '1.0.0'), 'minor');
  assert.throws(() => compareVersions('0.6', '0.6.1'), /x\.y\.z/);
  assert.throws(() => compareVersions('0.7.0-beta.1', '0.6.1'), /x\.y\.z/);
});

test('tags parse, rehearsal tags are marked, and build numbers count up per version', () => {
  assert.deepEqual(parseTag('desktop-v0.6.1-2'), { version: '0.6.1', build: 2, rehearsal: false });
  assert.deepEqual(parseTag('dryrun-desktop-v0.6.2-1'), { version: '0.6.2', build: 1, rehearsal: true });
  for (const tag of ['v0.6.1', 'desktop-v0.6.1', 'desktop-v0.6.1-0', 'desktop-v0.6-1', 'xdesktop-v0.6.1-1']) assert.equal(parseTag(tag), null, tag);
  assert.equal(tagName('0.6.2', 1), 'desktop-v0.6.2-1');
  assert.equal(tagName('0.6.2', 1, true), 'dryrun-desktop-v0.6.2-1');
  assert.equal(nextBuild('0.6.2', []), 1);
  assert.equal(nextBuild('0.6.1', ['desktop-v0.6.1-1', 'desktop-v0.6.1-3', 'v0.6.1', 'desktop-v0.6.0-9']), 4);
  assert.equal(nextBuild('0.6.2', ['dryrun-desktop-v0.6.2-5', 'desktop-v0.6.1-2']), 1);
});

test('a minor line counts as published only through a real tag of that x.y', () => {
  assert.equal(minorPublished('0.6.2', ['desktop-v0.6.1-1']), true);
  assert.equal(minorPublished('0.7.1', ['desktop-v0.6.1-1', 'dryrun-desktop-v0.7.0-1']), false);
  assert.equal(minorPublished('0.7.1', []), false);
});

test('planWatch: no change, a patch, a minor, an older upstream and a prerelease', () => {
  assert.equal(planWatch({ targetVersion: '0.6.1', upstreamVersion: '0.6.1' }).action, 'none');
  assert.deepEqual(planWatch({ targetVersion: '0.6.1', upstreamVersion: '0.6.2' }), { action: 'merge', kind: 'patch', version: '0.6.2' });
  assert.deepEqual(planWatch({ targetVersion: '0.6.1', upstreamVersion: '0.7.0' }), { action: 'merge', kind: 'minor', version: '0.7.0' });
  assert.equal(planWatch({ targetVersion: '0.6.1', upstreamVersion: '0.6.0' }).action, 'stopped');
  assert.equal(planWatch({ targetVersion: '0.6.1', upstreamVersion: '0.7.0-beta.1' }).action, 'none');
});

test('planWatch: rebuild and hand-merged build the target as it is, whatever upstream says', () => {
  assert.deepEqual(planWatch({ mode: 'rebuild', targetVersion: '0.6.1', upstreamVersion: '0.9.9' }), { action: 'build', kind: 'rebuild', version: '0.6.1' });
  assert.deepEqual(planWatch({ mode: 'hand-merged', targetVersion: '0.6.2' }), { action: 'build', kind: 'hand-merged', version: '0.6.2' });
  assert.throws(() => planWatch({ mode: 'sideways', targetVersion: '0.6.1' }), /mode/);
});

test('planWatch: an open issue for that version holds the run back, unless it is a retry or a rehearsal', () => {
  const issues = [{ number: 7, title: '[upstream-watch] OpenDoc 0.6.2: draft waiting for you' }, { number: 8, title: '[upstream-watch] OpenDoc 0.6.1 published' }];
  assert.equal(findWaitingIssue(issues, '0.6.2'), 7);
  assert.equal(findWaitingIssue(issues, '0.6.1'), null, 'the "published" notice is not a waiting issue');
  assert.equal(findWaitingIssue(issues, '0.6.2', true), null, 'a rehearsal looks only at rehearsal issues');
  assert.equal(planWatch({ targetVersion: '0.6.1', upstreamVersion: '0.6.2', issues }).action, 'waiting');
  assert.equal(planWatch({ targetVersion: '0.6.1', upstreamVersion: '0.6.2', issues, retry: true }).action, 'merge');
  assert.equal(planWatch({ targetVersion: '0.6.1', upstreamVersion: '0.6.2', issues, rehearsal: true }).action, 'merge');
});

const green = { verify: 'success', desktop: 'success', minorPublished: true };
const row = (input) => decideRelease({ version: '0.6.2', build: 1, ...green, ...input });
const shape = (decision) => ({ outcome: decision.outcome, release: decision.release, publish: decision.publish, promote: decision.promote, fail: decision.fail });

test('a fake patch bump ends in a draft with the gate off', () => {
  for (const gate of [undefined, '', 'false', 'FALSE', '0', 'no']) {
    assert.deepEqual(shape(row({ kind: 'patch', gate })), { outcome: 'draft', release: 'draft', publish: false, promote: true, fail: false }, `gate ${gate}`);
  }
  assert.deepEqual(row({ kind: 'patch', gate: 'false' }).reasons, ['gate-off']);
});

test('a fake patch bump is published with the gate on', () => {
  for (const gate of ['true', 'True', ' true ', true]) {
    const decision = row({ kind: 'patch', gate });
    assert.deepEqual(shape(decision), { outcome: 'published', release: 'published', publish: true, promote: true, fail: false }, `gate ${gate}`);
    assert.deepEqual(decision.reasons, []);
  }
});

test('with the gate on, a fake minor bump stays a draft', () => {
  const decision = row({ kind: 'minor', gate: 'true', version: '0.7.0' });
  assert.deepEqual(shape(decision), { outcome: 'draft', release: 'draft', publish: false, promote: true, fail: false });
  assert.deepEqual(decision.reasons, ['new-minor']);
});

test('with the gate on, a rebuild stays a draft and has nothing to move into the branch', () => {
  const decision = row({ kind: 'rebuild', gate: 'true', build: 2, version: '0.6.1' });
  assert.deepEqual(shape(decision), { outcome: 'draft', release: 'draft', publish: false, promote: false, fail: false });
  assert.deepEqual(decision.reasons, ['rebuild']);
  assert.equal(decision.tag, 'desktop-v0.6.1-2');
});

test('with the gate on, a merge resolved by hand stays a draft', () => {
  const decision = row({ kind: 'hand-merged', gate: 'true' });
  assert.deepEqual(shape(decision), { outcome: 'draft', release: 'draft', publish: false, promote: false, fail: false });
  assert.deepEqual(decision.reasons, ['hand-merged']);
});

test('with the gate on, a red check stays a draft (installers built) or stops the run (nothing built)', () => {
  for (const verify of ['failure', 'cancelled', 'skipped', undefined]) {
    const decision = row({ kind: 'patch', gate: 'true', verify });
    assert.deepEqual(shape(decision), { outcome: 'draft', release: 'draft', publish: false, promote: false, fail: true }, `verify ${verify}`);
    assert.deepEqual(decision.reasons, ['verify-red']);
  }
  for (const desktop of ['failure', 'cancelled', 'skipped']) {
    const decision = row({ kind: 'patch', gate: 'true', desktop });
    assert.deepEqual(shape(decision), { outcome: 'stopped', release: 'none', publish: false, promote: false, fail: true }, `desktop ${desktop}`);
    assert.deepEqual(decision.reasons, ['desktop-red']);
  }
  assert.deepEqual(row({ kind: 'patch', gate: 'true', desktop: 'failure', verify: 'failure' }).reasons, ['desktop-red', 'verify-red']);
});

test('a conflict stops and publishes nothing, whatever the gate and the results say', () => {
  for (const gate of ['true', 'false']) {
    const decision = row({ kind: 'conflict', gate, verify: 'success', desktop: 'success' });
    assert.deepEqual(shape(decision), { outcome: 'stopped', release: 'none', publish: false, promote: false, fail: true });
    assert.deepEqual(decision.reasons, ['conflict']);
  }
  assert.deepEqual(shape(row({ kind: 'conflict', gate: 'true', verify: 'skipped', desktop: 'skipped' })), { outcome: 'stopped', release: 'none', publish: false, promote: false, fail: true });
});

test('a run that could not go on (older upstream, refused push) stops and publishes nothing', () => {
  const decision = row({ kind: 'stopped', gate: 'true', build: 0 });
  assert.deepEqual(shape(decision), { outcome: 'stopped', release: 'none', publish: false, promote: false, fail: true });
  const report = finalReport(decision, { detail: 'upstream is older' });
  assert.equal(report.title, '[upstream-watch] OpenDoc 0.6.2: stopped, nothing published');
  assert.ok(!report.body.includes('build 0'));
});

test('a patch of a minor nobody has published by hand waits, even with the gate on', () => {
  const decision = row({ kind: 'patch', gate: 'true', version: '0.7.1', minorPublished: false });
  assert.deepEqual(shape(decision), { outcome: 'draft', release: 'draft', publish: false, promote: true, fail: false });
  assert.deepEqual(decision.reasons, ['minor-unpublished']);
});

test('nothing but a patch with a green run and the gate on ever publishes (every combination)', () => {
  const kinds = ['patch', 'minor', 'rebuild', 'hand-merged', 'conflict'];
  const results = ['success', 'failure', 'cancelled', 'skipped'];
  for (const kind of kinds) for (const gate of ['true', 'false', '']) for (const verify of results) for (const desktop of results) for (const minorOut of [true, false]) {
    const decision = row({ kind, gate, verify, desktop, minorPublished: minorOut });
    const expected = kind === 'patch' && gate === 'true' && verify === 'success' && desktop === 'success' && minorOut;
    assert.equal(decision.publish, expected, JSON.stringify({ kind, gate, verify, desktop, minorOut }));
    if (decision.publish) assert.equal(decision.promote, true);
    if (decision.outcome === 'stopped') assert.equal(decision.release, 'none');
  }
});

test('a rehearsal gets a dryrun tag and its own issue titles', () => {
  const decision = row({ kind: 'patch', gate: 'true', rehearsal: true });
  assert.equal(decision.tag, 'dryrun-desktop-v0.6.2-1');
  const report = finalReport(decision, { promotion: 'success', publication: 'success' });
  assert.equal(report.title, '[upstream-watch][rehearsal] OpenDoc 0.6.2 published');
  assert.match(report.body, /rehearsal/);
  assert.match(report.body, /pre-release/);
});

test('the report says what happened and what to do next', () => {
  const published = finalReport(row({ kind: 'patch', gate: 'true' }), { promotion: 'success', publication: 'success', owner: 'someone', runUrl: 'https://example.test/run/1' });
  assert.equal(published.title, '[upstream-watch] OpenDoc 0.6.2 published');
  assert.equal(published.published, true);
  assert.equal(published.fail, false);
  assert.ok(published.body.startsWith('@someone\n'));
  assert.match(published.body, /Run: https:\/\/example\.test\/run\/1/);

  const draft = finalReport(row({ kind: 'minor', gate: 'true', version: '0.7.0' }), { promotion: 'success' });
  assert.equal(draft.title, '[upstream-watch] OpenDoc 0.7.0: draft waiting for you');
  assert.equal(draft.published, false);
  assert.equal(draft.fail, false);
  assert.match(draft.body, /new minor is never published automatically/);
  assert.match(draft.body, /desktop-v0\.7\.0-1/);

  const red = finalReport(row({ kind: 'patch', gate: 'true', verify: 'failure' }), { promotion: 'skipped', candidateBranch: 'watch/v0.6.2-r5', target: 'roadmap' });
  assert.equal(red.title, '[upstream-watch] OpenDoc 0.6.2: a check is red, nothing published');
  assert.equal(red.fail, true);
  assert.match(red.body, /watch\/v0\.6\.2-r5/);

  const conflict = finalReport(row({ kind: 'conflict', gate: 'true', verify: 'skipped', desktop: 'skipped' }), { detail: 'Conflicting files: src/a.ts' });
  assert.equal(conflict.title, '[upstream-watch] OpenDoc 0.6.2: merge conflict, nothing published');
  assert.equal(conflict.fail, true);
  assert.match(conflict.body, /Conflicting files: src\/a\.ts/);
  assert.match(conflict.body, /hand-merged/);

  const stopped = finalReport(row({ kind: 'patch', gate: 'true', desktop: 'failure' }), {});
  assert.match(stopped.title, /a check is red/);
  assert.match(stopped.body, /no release to draft/);
});

test('a publication whose merge could not move into the branch, or that failed, is held back as a draft, and the run fails', () => {
  const decision = row({ kind: 'patch', gate: 'true' });
  assert.equal(decision.publish, true);
  const unmoved = finalReport(decision, { promotion: 'failure', publication: 'skipped', target: 'roadmap' });
  assert.deepEqual([unmoved.published, unmoved.outcome, unmoved.fail], [false, 'draft', true]);
  assert.match(unmoved.body, /Moving the merge into roadmap failed/);
  const unpublished = finalReport(decision, { promotion: 'success', publication: 'failure' });
  assert.deepEqual([unpublished.published, unpublished.outcome, unpublished.fail], [false, 'draft', true]);
  assert.match(unpublished.body, /Publishing the draft failed/);
  assert.equal(finalReport(decision, { promotion: 'success', publication: 'success' }).published, true);
});

test('release notes credit the original OpenDoc and name the build', () => {
  const notes = releaseNotes({ version: '0.6.2', build: 1, kind: 'patch', upstreamSha: 'abcdef0123456789', commit: '0123456789abcdef' });
  assert.match(notes, /opendoc-desktop 0\.6\.2, build 1/);
  assert.match(notes, /https:\/\/github\.com\/RyanYahya\/OpenDoc/);
  assert.match(notes, /abcdef012345/);
  assert.ok(!notes.includes('\n\n\n'));
  assert.match(releaseNotes({ version: '0.6.1', build: 2, kind: 'rebuild' }), /changes the app only/);
});

test('the command line: decide, notes and report write the files and outputs the workflow reads', () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'opendoc-decide-cli-'));
  try {
    const cli = fileURLToPath(new URL('../../release/decide.mjs', import.meta.url));
    const outputs = path.join(scratch, 'outputs.txt');
    const run = (...args) => {
      const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: outputs } });
      assert.equal(result.status, 0, result.stderr);
      return Object.fromEntries(readFileSync(outputs, 'utf8').trim().split('\n').slice(-6).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    };
    const decision = path.join(scratch, 'decision.json');
    const decided = run('decide', '--kind', 'patch', '--version', '0.6.2', '--build', '1', '--gate', 'true', '--verify', 'success', '--desktop', 'success', '--minor-published', 'true', '--rehearsal', 'false', '--out', decision);
    assert.deepEqual([decided.outcome, decided.publish, decided.promote, decided.fail], ['published', 'true', 'true', 'false']);
    assert.equal(JSON.parse(readFileSync(decision, 'utf8')).tag, 'desktop-v0.6.2-1');
    const notes = path.join(scratch, 'notes.md');
    assert.equal(spawnSync(process.execPath, [cli, 'notes', '--decision', decision, '--out', notes, '--commit', 'abcdef0123456789'], { encoding: 'utf8' }).status, 0);
    assert.match(readFileSync(notes, 'utf8'), /build 1/);
    const reported = run('report', '--decision', decision, '--promotion', 'success', '--publication', 'success', '--out-dir', path.join(scratch, 'report'), '--owner', 'someone');
    assert.deepEqual([reported.title, reported.published, reported.fail], ['[upstream-watch] OpenDoc 0.6.2 published', 'true', 'false']);
    assert.ok(readFileSync(path.join(scratch, 'report', 'issue.md'), 'utf8').startsWith('@someone\n'));
    const red = run('decide', '--kind', 'patch', '--version', '0.6.2', '--build', '1', '--gate', 'true', '--verify', 'failure', '--desktop', 'success', '--minor-published', 'true', '--rehearsal', 'false', '--out', decision);
    assert.deepEqual([red.outcome, red.publish, red.fail], ['draft', 'false', 'true']);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
