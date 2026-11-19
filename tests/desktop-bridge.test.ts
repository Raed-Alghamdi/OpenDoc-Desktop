import test from 'node:test';
import assert from 'node:assert/strict';
import { connectDesktop, desktopBridge, hostStateMessage, type DesktopBridge, type HostState } from '../src/app/desktopBridge';

function fakeBridge(withState = true) {
  const changes = new Set<() => void>();
  const states = new Set<(event: { state: HostState }) => void>();
  const bridge: DesktopBridge = {
    onChange: listener => { changes.add(listener); return () => { changes.delete(listener); }; },
    ...(withState ? { onHostState: (listener: (event: { state: HostState }) => void) => { states.add(listener); return () => { states.delete(listener); }; } } : {}),
  };
  return { bridge, changes, states, emit: (state: unknown) => { for (const listener of [...states]) listener({ state } as { state: HostState }); } };
}

test('the browser edition has no bridge, so the page keeps its WebSocket', () => {
  assert.equal(desktopBridge({}), undefined);
  assert.equal(desktopBridge({ opendocDesktop: undefined }), undefined);
});

test('the bridge is found on the window object of the app', () => {
  const fake = fakeBridge();
  assert.equal(desktopBridge({ opendocDesktop: fake.bridge }), fake.bridge);
});

test('each host state reaches the page, and change events still refetch', () => {
  const fake = fakeBridge();
  const seen: HostState[] = [];
  let changes = 0;
  connectDesktop(fake.bridge, { change: () => { changes++; }, hostState: state => seen.push(state) });
  for (const listener of fake.changes) listener();
  fake.emit('restarting'); fake.emit('running'); fake.emit('failed');
  assert.deepEqual(seen, ['restarting', 'running', 'failed']);
  assert.equal(changes, 1);
});

test('unknown host states are ignored', () => {
  const fake = fakeBridge();
  const seen: HostState[] = [];
  connectDesktop(fake.bridge, { change() {}, hostState: state => seen.push(state) });
  fake.emit('exploding'); fake.emit(undefined);
  assert.deepEqual(seen, []);
});

test('an older bridge without host states still delivers changes', () => {
  const fake = fakeBridge(false);
  let changes = 0;
  const stop = connectDesktop(fake.bridge, { change: () => { changes++; }, hostState() { throw new Error('no states expected'); } });
  for (const listener of fake.changes) listener();
  assert.equal(changes, 1);
  stop();
});

test('unsubscribing removes both listeners', () => {
  const fake = fakeBridge();
  const stop = connectDesktop(fake.bridge, { change() {}, hostState() {} });
  assert.equal(fake.changes.size + fake.states.size, 2);
  stop();
  assert.equal(fake.changes.size + fake.states.size, 0);
});

test('the notices are short and say what is happening', () => {
  assert.match(hostStateMessage.restarting, /^Reconnecting to OpenDoc/);
  assert.match(hostStateMessage.failed, /stopped/);
  assert.ok(Object.values(hostStateMessage).every(message => message.length < 100));
});
