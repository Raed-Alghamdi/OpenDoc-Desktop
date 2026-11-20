import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, readFile, readdir, readlink, stat, symlink, writeFile } from 'node:fs/promises';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { adoptWorkspace, markManaged, readMarker } from '../../../src/main/workspace/marker.mjs';
import { PinError, pinnedText, readManifest, writePin } from '../../../src/main/workspace/pin.mjs';
import { compareVersions, decideVersion, parseVersion, readPin } from '../../../src/main/workspace/versions.mjs';
import { lockBytes, makeWorkspace, pinText, scratch } from '../support/workspace-fixtures.mjs';

const runtime = '0.6.1';

test('the version table: the same minor, an older or equal patch, opens and moves the pin up only when it is behind', () => {
  assert.deepEqual(decideVersion('0.6.1', runtime), { kind: 'open', movePin: false });
  assert.deepEqual(decideVersion('0.6.0', runtime), { kind: 'open', movePin: true });
});

test('the version table: the same minor, a newer patch, is read-only with "update the app"', () => {
  const decision = decideVersion('0.6.9', runtime);
  assert.equal(decision.kind, 'readonly');
  assert.equal(decision.reason, 'newer-patch');
  assert.match(decision.message, /Update the app to edit it/);
  assert.match(decision.message, /0\.6\.9/);
});

test('the version table: an older minor asks (upgrade), whatever the patch', () => {
  assert.deepEqual(decideVersion('0.5.0', runtime), { kind: 'upgrade', from: '0.5.0', to: runtime });
  assert.deepEqual(decideVersion('0.5.9', runtime), { kind: 'upgrade', from: '0.5.9', to: runtime });
});

test('the version table: a newer minor is read-only with the message that names its minor', () => {
  const decision = decideVersion('0.7.0', runtime);
  assert.equal(decision.kind, 'readonly');
  assert.equal(decision.reason, 'newer-minor');
  assert.equal(decision.message, 'This workspace was upgraded by OpenDoc 0.7. Update the app to edit it.');
});

test('the version table: a different major counts like a minor', () => {
  assert.equal(decideVersion('0.9.9', '1.0.0').kind, 'upgrade');
  assert.equal(decideVersion('1.0.0', '1.0.0').kind, 'open');
  const newer = decideVersion('2.0.0', '1.4.2');
  assert.equal(newer.kind, 'readonly');
  assert.equal(newer.reason, 'newer-minor');
  assert.equal(newer.message, 'This workspace was upgraded by OpenDoc 2.0. Update the app to edit it.');
  assert.equal(decideVersion('1.9.0', '2.0.0').kind, 'upgrade');
});

test('the version table never asks for a pin to go down', () => {
  for (const pin of ['0.6.2', '0.6.9', '0.7.0', '1.0.0']) {
    const decision = decideVersion(pin, runtime);
    assert.ok(decision.kind === 'readonly', `${pin} must not be opened writable or upgraded`);
  }
});

test('versions: only exact stable versions parse; they compare numerically', () => {
  assert.deepEqual(parseVersion('0.6.1'), { major: 0, minor: 6, patch: 1 });
  for (const bad of ['0.6', '0.6.1-beta.1', 'v0.6.1', '^0.6.1', '01.2.3', '0.6.1.2', '', null, 7]) assert.equal(parseVersion(bad), null, String(bad));
  assert.ok(compareVersions('0.10.0', '0.9.0') > 0);
  assert.ok(compareVersions('0.6.1', '0.6.1') === 0);
});

test('pins: the normal edition is read; a malformed pin and the headless edition are refused with their own codes', () => {
  assert.deepEqual(readPin(JSON.parse(pinText('0.6.0'))), { ok: true, edition: 'normal', version: '0.6.0' });
  for (const dependencies of [undefined, {}, { opendoc: '^0.6.1' }, { opendoc: '0.6.1' }, { opendoc: 'npm:@ryanyahya/opendoc@^0.6.1' }, { opendoc: 'npm:@ryanyahya/opendoc@0.6' }, { opendoc: 'npm:@ryanyahya/opendoc@0.6.1-rc.1' }, { opendoc: 'npm:other@0.6.1' }, { opendoc: 7 }]) {
    const pin = readPin({ dependencies });
    assert.equal(pin.ok, false);
    assert.equal(pin.code, 'malformed-pin');
    assert.match(pin.message, /Nothing was changed/);
  }
  const headless = readPin(JSON.parse(pinText('0.6.1', { edition: 'headless' })));
  assert.equal(headless.ok, false);
  assert.equal(headless.code, 'headless');
  assert.match(headless.message, /headless/);
  assert.match(headless.message, /nothing was changed/);
  assert.equal(readPin(null).ok, false);
});

test('pin rewriting changes only the version: indentation, key order, line endings and the final newline stay', () => {
  for (const options of [{}, { indent: '    ' }, { indent: '\t' }, { eol: '\r\n' }, { final: false }, { indent: '\t', eol: '\r\n', final: false }]) {
    const before = pinText('0.5.0', options);
    const after = pinnedText(before, '0.6.1');
    assert.equal(after, before.replace('opendoc@0.5.0', 'opendoc@0.6.1'), JSON.stringify(options));
    assert.deepEqual(Object.keys(JSON.parse(after)), Object.keys(JSON.parse(before)));
  }
});

test('pin rewriting keeps the headless edition name, and falls back to a JSON rewrite that keeps the format', () => {
  assert.equal(pinnedText(pinText('0.5.0', { edition: 'headless' }), '0.6.1', 'headless'), pinText('0.6.1', { edition: 'headless' }));
  // Two spellings the text edit refuses (the pin twice): the JSON route keeps indent, key order, line ending and final newline.
  const odd = '{\r\n    "name": "w",\r\n    "dependencies": {\r\n        "opendoc": "npm:@ryanyahya/opendoc@0.5.0"\r\n    },\r\n    "devDependencies": {\r\n        "opendoc": "npm:@ryanyahya/opendoc@0.5.0"\r\n    }\r\n}\r\n';
  const next = pinnedText(odd, '0.6.1');
  assert.equal(JSON.parse(next).dependencies.opendoc, 'npm:@ryanyahya/opendoc@0.6.1');
  assert.ok(next.endsWith('}\r\n'));
  assert.ok(next.includes('\r\n    "name"'));
  assert.deepEqual(Object.keys(JSON.parse(next)), ['name', 'dependencies', 'devDependencies']);
});

test('pin rewriting refuses a file with no pin to move', () => {
  assert.throws(() => pinnedText('{"name":"w"}\n', '0.6.1'), /no OpenDoc pin/);
});

test('writePin replaces the file atomically (no temporary left), keeps its mode, and never touches package-lock.json', async () => {
  const root = await makeWorkspace(await scratch('pin'), { pin: '0.5.0', marker: false });
  await chmod(join(root, 'package.json'), 0o640);
  const lock = await lockBytes(root);
  const lockTime = (await stat(join(root, 'package-lock.json'))).mtimeMs;
  await writePin(root, '0.6.1');
  assert.equal(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).dependencies.opendoc, 'npm:@ryanyahya/opendoc@0.6.1');
  assert.equal((await stat(join(root, 'package.json'))).mode & 0o777, 0o640);
  assert.deepEqual((await readdir(root)).filter(name => name.endsWith('.part')), []);
  assert.deepEqual(await lockBytes(root), lock);
  assert.equal((await stat(join(root, 'package-lock.json'))).mtimeMs, lockTime);
});

test('writePin on a pin that is already right writes nothing', async () => {
  const root = await makeWorkspace(await scratch('pin-same'), { pin: '0.6.1', marker: false });
  const before = (await stat(join(root, 'package.json'))).mtimeMs;
  await writePin(root, '0.6.1');
  assert.equal((await stat(join(root, 'package.json'))).mtimeMs, before);
});

test('readManifest: a missing package.json is null, an invalid one is a readable error', async () => {
  const root = await scratch('manifest');
  assert.equal(await readManifest(root), null);
  await writeFile(join(root, 'package.json'), '{ nope');
  await assert.rejects(readManifest(root), /not valid JSON/);
});

test('adoption writes the marker from what the runtime knows, with managed: true', async () => {
  const root = await scratch('adopt');
  assert.deepEqual(await readMarker(root), { state: 'none' });
  await adoptWorkspace(root, { formatVersion: 1, edition: 'normal' });
  const marker = JSON.parse(await readFile(join(root, '.opendoc', 'workspace.json'), 'utf8'));
  assert.deepEqual(marker, { formatVersion: 1, edition: 'normal', managed: true });
  assert.deepEqual((await readdir(join(root, '.opendoc'))), ['workspace.json']);
});

test('an existing marker gets managed: true once, and nothing else in it changes (indent and ending kept)', async () => {
  const root = await scratch('managed');
  await makeWorkspace(root, { pin: false, marker: { formatVersion: 1, createdWith: '0.5.0', edition: 'normal', note: 'keep me' }, documents: [], lock: false });
  assert.equal(await markManaged(root), true);
  const text = await readFile(join(root, '.opendoc', 'workspace.json'), 'utf8');
  assert.deepEqual(JSON.parse(text), { formatVersion: 1, createdWith: '0.5.0', edition: 'normal', note: 'keep me', managed: true });
  assert.ok(text.startsWith('{\n  "formatVersion"') && text.endsWith('}\n'));
  assert.equal(await markManaged(root), false);
  assert.equal(await readFile(join(root, '.opendoc', 'workspace.json'), 'utf8'), text);
});

test('a damaged marker is reported, not repaired', async () => {
  const root = await scratch('bad-marker');
  await makeWorkspace(root, { pin: false, marker: false, documents: [], lock: false });
  await adoptWorkspace(root, { formatVersion: 1 });
  await writeFile(join(root, '.opendoc', 'workspace.json'), '[1]');
  assert.equal((await readMarker(root)).state, 'invalid');
  await writeFile(join(root, '.opendoc', 'workspace.json'), '{ nope');
  assert.equal((await readMarker(root)).state, 'invalid');
  await assert.rejects(markManaged(root), /missing or damaged/);
});

test('writePin never lowers a pin: one that was moved up meanwhile (another device) is left alone with a "newer-pin" error', async () => {
  const root = await makeWorkspace(await scratch('pin-newer'), { pin: '0.7.0', marker: false });
  const before = await readFile(join(root, 'package.json'), 'utf8');
  await assert.rejects(writePin(root, '0.6.1'), error => error instanceof PinError && error.code === 'newer-pin' && /0\.7\.0/.test(error.message));
  assert.equal(await readFile(join(root, 'package.json'), 'utf8'), before);
  await writePin(root, '0.7.0');
  await writePin(root, '0.7.1');
  assert.match(await readFile(join(root, 'package.json'), 'utf8'), /@0\.7\.1"/);
});

test('writePin on a symlinked package.json writes through to the real file inside the workspace, and the link stays a link', async () => {
  const root = await makeWorkspace(await scratch('pin-link'), { pin: '0.5.0', marker: false });
  await mkdir(join(root, 'config'));
  await writeFile(join(root, 'config', 'package.real.json'), await readFile(join(root, 'package.json')));
  await rm(join(root, 'package.json'));
  await symlink(join('config', 'package.real.json'), join(root, 'package.json'));
  await writePin(root, '0.6.1');
  assert.equal((await lstat(join(root, 'package.json'))).isSymbolicLink(), true);
  assert.equal(await readlink(join(root, 'package.json')), join('config', 'package.real.json'));
  assert.match(await readFile(join(root, 'config', 'package.real.json'), 'utf8'), /@0\.6\.1"/);
  assert.deepEqual((await readdir(join(root, 'config'))), ['package.real.json']);
});

test('writePin on a package.json that links outside the workspace is refused and nothing changes', async () => {
  const root = await makeWorkspace(await scratch('pin-out'), { pin: '0.5.0', marker: false });
  const outside = join(await scratch('pin-outside'), 'package.json');
  await writeFile(outside, await readFile(join(root, 'package.json')));
  await rm(join(root, 'package.json'));
  await symlink(outside, join(root, 'package.json'));
  const before = await readFile(outside, 'utf8');
  await assert.rejects(writePin(root, '0.6.1'), error => error.code === 'outside-package' && error.message.includes(outside));
  assert.equal(await readFile(outside, 'utf8'), before);
  assert.equal((await lstat(join(root, 'package.json'))).isSymbolicLink(), true);
});

test('a package.json with a UTF-8 byte order mark is read, and the mark is kept when the pin moves (text edit and JSON fallback)', async () => {
  const root = await makeWorkspace(await scratch('pin-bom'), { pin: '0.5.0', marker: false });
  const text = '\uFEFF' + await readFile(join(root, 'package.json'), 'utf8');
  await writeFile(join(root, 'package.json'), text);
  assert.equal((await readManifest(root)).manifest.dependencies.opendoc, 'npm:@ryanyahya/opendoc@0.5.0');
  await writePin(root, '0.6.1');
  const after = await readFile(join(root, 'package.json'), 'utf8');
  assert.equal(after.charCodeAt(0), 0xFEFF);
  assert.equal(after, text.replace('@0.5.0', '@0.6.1'));
  const odd = '\uFEFF{\n  "dependencies": { "opendoc": "npm:@ryanyahya/opendoc@^0.5.0" }\n}\n';
  const rewritten = pinnedText(odd, '0.6.1');
  assert.equal(rewritten.charCodeAt(0), 0xFEFF);
  assert.equal(JSON.parse(rewritten.slice(1)).dependencies.opendoc, 'npm:@ryanyahya/opendoc@0.6.1');
});
