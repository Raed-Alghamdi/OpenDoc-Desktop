// "What changed" once after an update: what each kind of launch is, compared with the last run on record.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions, describeRun, launchOutcome, readRun } from '../../../src/main/updater/release-notes.mjs';

const run = (version, build) => ({ version, build });

test('compareVersions orders plain x.y.z versions numerically and refuses anything else', () => {
  assert.equal(compareVersions('0.6.1', '0.6.1'), 0);
  assert.equal(compareVersions('0.6.2', '0.6.1'), 1);
  assert.equal(compareVersions('0.6.9', '0.6.10'), -1);
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
  for (const pair of [['0.6.1-beta', '0.6.1'], ['x', '1.0.0'], [null, '1.0.0'], ['1.0', '1.0.0']]) assert.equal(compareVersions(...pair), null, pair.join(' / '));
});

test('a launch with no build number (a development run) records and shows nothing', () => {
  for (const current of [run('0.6.1', null), run('0.6.1', undefined), run('0.6.1', 'x'), null, undefined]) assert.deepEqual(launchOutcome({ last: run('0.6.1', 1), current }), { kind: 'unknown' });
});

test('the first run on a fresh install is recorded but shows nothing', () => {
  for (const last of [undefined, null, {}, 'x', run('0.6.1', 'x'), { build: 1 }]) assert.equal(launchOutcome({ last, current: run('0.6.1', 1) }).kind, 'first-run', JSON.stringify(last));
});

test('the same version and build is the same run', () => {
  assert.equal(launchOutcome({ last: run('0.6.1', 3), current: run('0.6.1', 3) }).kind, 'same');
});

test('a newer build, or a newer version with any build, is an update: shown once', () => {
  for (const [last, current] of [[run('0.6.1', 1), run('0.6.1', 2)], [run('0.6.1', 5), run('0.6.2', 1)], [run('0.6.9', 1), run('0.7.0', 1)], [run('0.6.1', '2'), run('0.6.1', 3)]]) {
    const outcome = launchOutcome({ last, current });
    assert.equal(outcome.kind, 'updated', `${describeRun(readRun(last))} to ${describeRun(readRun(current))}`);
    assert.deepEqual(outcome.current, readRun(current));
    assert.deepEqual(outcome.previous, readRun(last));
  }
});

test('an older build than the last run (a downgrade by hand) is recorded and shows nothing', () => {
  for (const [last, current] of [[run('0.6.1', 2), run('0.6.1', 1)], [run('0.6.2', 1), run('0.6.1', 9)]]) assert.equal(launchOutcome({ last, current }).kind, 'older');
});

test('two versions that cannot be ordered are recorded and show nothing', () => {
  assert.equal(launchOutcome({ last: run('0.7.0-beta', 1), current: run('0.7.0-rc', 1) }).kind, 'unordered');
  assert.equal(launchOutcome({ last: run('0.7.0-beta', 1), current: run('0.7.0-beta', 2) }).kind, 'updated', 'the same unusual version with a higher build');
});

test('a stored run is read back only when it is complete', () => {
  assert.deepEqual(readRun({ version: '0.6.1', build: 2, extra: true }), { version: '0.6.1', build: 2 });
  assert.equal(readRun({ version: '0.6.1' }), null);
  assert.equal(readRun([]), null);
  assert.equal(describeRun(run('0.6.1', 2)), '0.6.1, build 2');
});
