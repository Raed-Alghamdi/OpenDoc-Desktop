// The schedule: a check at launch, then once a day while the app is open, and nothing after it is stopped.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSchedule, dayMilliseconds } from '../../../src/main/updater/schedule.mjs';

const settle = () => new Promise(accept => setImmediate(accept));

test('one check at launch, then one a day', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let checks = 0;
  const schedule = createSchedule({ run: () => { checks++; } });
  schedule.start();
  await settle();
  assert.equal(checks, 1, 'the launch check');
  t.mock.timers.tick(dayMilliseconds - 1);
  await settle();
  assert.equal(checks, 1, 'nothing before a day has passed');
  t.mock.timers.tick(1);
  await settle();
  assert.equal(checks, 2, 'the first daily check');
  t.mock.timers.tick(dayMilliseconds);
  await settle();
  assert.equal(checks, 3, 'the next day');
  schedule.stop();
});

test('stopping mid-run cancels the timer at once: no later check, and no timer left', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let checks = 0;
  const schedule = createSchedule({ run: () => { checks++; } });
  schedule.start();
  await settle();
  t.mock.timers.tick(dayMilliseconds);
  await settle();
  assert.equal(checks, 2);
  schedule.stop();
  assert.equal(schedule.running, false);
  t.mock.timers.tick(dayMilliseconds * 5);
  await settle();
  assert.equal(checks, 2);
});

test('starting again after a stop checks at once and restarts the day', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let checks = 0;
  const schedule = createSchedule({ run: () => { checks++; } });
  schedule.start();
  await settle();
  t.mock.timers.tick(dayMilliseconds / 2);
  schedule.stop();
  schedule.start();
  await settle();
  assert.equal(checks, 2, 'the switch on again checks right away');
  t.mock.timers.tick(dayMilliseconds - 1);
  await settle();
  assert.equal(checks, 2, 'a full day counts from the new start');
  t.mock.timers.tick(1);
  await settle();
  assert.equal(checks, 3);
  schedule.stop();
});

test('start twice is one schedule', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let checks = 0;
  const schedule = createSchedule({ run: () => { checks++; } });
  schedule.start();
  schedule.start();
  await settle();
  t.mock.timers.tick(dayMilliseconds);
  await settle();
  assert.equal(checks, 2);
  schedule.stop();
});

test('a failing check is logged and the schedule goes on', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const lines = [];
  let checks = 0;
  const schedule = createSchedule({ run: async () => { checks++; throw new Error('offline'); }, log: line => lines.push(line) });
  schedule.start();
  await settle();
  t.mock.timers.tick(dayMilliseconds);
  await settle();
  assert.equal(checks, 2);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /offline/);
  schedule.stop();
});

test('a stopped schedule makes no timer and no call', () => {
  const schedule = createSchedule({ run: () => assert.fail('must not run') });
  schedule.stop();
  assert.equal(schedule.running, false);
});
