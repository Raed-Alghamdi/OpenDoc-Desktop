// The update items in the application menu: where they sit, when they show, and what they call.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { menuTemplate } from '../../../src/main/menu-template.mjs';

const base = { workspaceOpen: false, recent: [] };
const shown = { show: true, automatic: true, checkEnabled: true, restartReady: false, installing: false };
const items = (platform, updates, actions = {}) => {
  const template = menuTemplate({ platform, actions, state: { ...base, updates } });
  const menu = platform === 'darwin' ? template[0] : template.find(entry => entry.role === 'help');
  return menu.submenu;
};
const labels = submenu => submenu.map(item => item.label ?? `[${item.role ?? item.type}]`);

test('on Linux the update items are in Help, after About', () => {
  assert.deepEqual(labels(items('linux', shown)), ['OpenDoc on GitHub', '[separator]', 'About opendoc-desktop', '[separator]', 'Check for Updates…', 'Check for Updates Automatically', '[separator]', 'Connect AI Apps…']);
});

test('on macOS they are in the app menu, after About and before the command-line tool', () => {
  assert.deepEqual(labels(items('darwin', shown)).slice(0, 6), ['About opendoc-desktop', '[separator]', 'Check for Updates…', 'Check for Updates Automatically', '[separator]', 'Install Command-Line Tool…']);
});

test('Restart to Update is there only while an update is ready', () => {
  assert.ok(!labels(items('linux', shown)).includes('Restart to Update'));
  assert.equal(labels(items('linux', { ...shown, restartReady: true })).at(-3), 'Restart to Update');
  assert.equal(labels(items('darwin', { ...shown, restartReady: true })).at(3 + 1), 'Restart to Update');
});

test('an install that is not updated by the app (managed, inactive, no state at all) shows no update items', () => {
  const plain = ['OpenDoc on GitHub', '[separator]', 'About opendoc-desktop', '[separator]', 'Connect AI Apps…'];
  for (const updates of [{ ...shown, show: false }, undefined]) assert.deepEqual(labels(items('linux', updates)), plain);
  assert.deepEqual(labels(items('darwin', undefined)).slice(0, 5), ['About opendoc-desktop', '[separator]', 'Install Command-Line Tool…', 'Connect AI Apps…', '[separator]']);
});

test('the check item can be disabled (the switch is off) and the switch is a checkbox that reports its new state', () => {
  const calls = [];
  const actions = { checkForUpdates: () => calls.push('check'), setAutomaticUpdates: checked => calls.push(['automatic', checked]), restartToUpdate: () => calls.push('restart') };
  const off = items('linux', { ...shown, automatic: false, checkEnabled: false, restartReady: true }, actions);
  const [check, automatic, restart] = off.slice(-5, -2);
  assert.equal(check.enabled, false);
  assert.deepEqual([automatic.type, automatic.checked], ['checkbox', false]);
  check.click();
  automatic.click({ checked: true });
  restart.click();
  assert.deepEqual(calls, ['check', ['automatic', true], 'restart']);
  const on = items('linux', shown, actions);
  assert.equal(on.at(-4).enabled, true);
  assert.equal(on.at(-3).checked, true);
});

test('the other menus are unchanged', () => {
  const withUpdates = menuTemplate({ platform: 'linux', actions: {}, state: { ...base, updates: shown } });
  const without = menuTemplate({ platform: 'linux', actions: {}, state: base });
  assert.deepEqual(withUpdates.slice(0, -1).map(menu => menu.label), without.slice(0, -1).map(menu => menu.label));
  assert.deepEqual(labels(withUpdates[0].submenu), labels(without[0].submenu));
});
