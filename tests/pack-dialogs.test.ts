import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canInstall, chosenCount, chosenText, createHostRegistry, createStagedHold, createImportEntry, createPackChoice, emptyExportForm, exportFailure, exportProblems, exportRequest,
  fileSize, installedLinks, isPackFileName, packBlockers, packFile, packFileName, packId, type ExportForm,
} from '../src/app/packs';
import type { PackInspection } from '../src/app/api';

const form = (changes: Partial<ExportForm> = {}): ExportForm => ({ ...emptyExportForm, ...changes });
const inspection = (changes: Partial<Pick<PackInspection, 'compatibility' | 'conflicts' | 'added'>> = {}) => ({
  compatibility: { compatible: true, requiredVersion: '0.6.1', currentVersion: '0.6.1' }, conflicts: [] as string[], added: ['themes/acme/index.ts'], ...changes,
});

test('choosing designs: both galleries share one choice, and a catalog change drops what is gone', () => {
  const choice = createPackChoice();
  const seen: number[] = [];
  choice.subscribe(() => seen.push(chosenCount(choice.get())));
  assert.deepEqual(choice.get(), { selecting: false, themes: [], templates: [] });
  choice.start();
  choice.toggle('theme', 'acme');
  choice.toggle('template', 'report');
  choice.toggle('theme', 'brand');
  assert.equal(chosenText(choice.get()), '2 themes and 1 template');
  choice.toggle('theme', 'brand');
  assert.deepEqual(choice.get().themes, ['acme']);
  assert.equal(chosenText(choice.get()), '1 theme and 1 template');
  // A design deleted elsewhere leaves the choice; an unchanged catalog leaves it alone and says nothing.
  const before = choice.get();
  choice.prune('theme', ['acme', 'other']);
  assert.equal(choice.get(), before);
  choice.prune('template', []);
  assert.deepEqual(choice.get().templates, []);
  assert.equal(chosenText(choice.get()), '1 theme');
  choice.stop();
  assert.deepEqual(choice.get(), { selecting: false, themes: [], templates: [] });
  assert.equal(chosenText(choice.get()), 'Nothing');
  const calls = seen.length;
  choice.stop();
  assert.equal(seen.length, calls, 'stopping twice announces nothing');
});

test('a toggle outside choosing mode starts it, so a card never holds a lost tick', () => {
  const choice = createPackChoice();
  choice.toggle('template', 'report');
  assert.equal(choice.get().selecting, true);
});

test('pack names become IDs the server accepts, and the file name is known before export', () => {
  assert.equal(packId('Acme design'), 'acme-design');
  assert.equal(packId('  Café  Déjà-vu!! '), 'cafe-deja-vu');
  assert.equal(packId('تصميم'), '', 'a name with no Latin letters leaves the ID to the server');
  assert.equal(packId('a'.repeat(120)).length, 80);
  assert.match(packId('x'.repeat(79) + ' y'), /^x+$/, 'a cut never leaves a trailing hyphen');
  assert.equal(packFileName(form({ name: 'Acme design' }), 'acme'), 'acme-design-1.0.0.opendoc.zip');
  assert.equal(packFileName(form({ name: '', version: ' 2.1.0 ' }), 'acme'), 'acme-2.1.0.opendoc.zip');
  assert.equal(packFileName(form({ name: 'تصميم' }), 'acme'), 'acme-1.0.0.opendoc.zip');
});

test('the export request sends what the pack export route accepts and leaves empty fields to the server', () => {
  const choice = { themes: ['acme'], templates: ['report'] };
  assert.deepEqual(exportRequest(choice, form()), { themes: ['acme'], templates: ['report'], version: '1.0.0' });
  assert.deepEqual(exportRequest(choice, form({ name: ' Acme design ', author: ' Sam ', license: 'Use freely.', version: '1.2.0' })),
    { themes: ['acme'], templates: ['report'], id: 'acme-design', name: 'Acme design', version: '1.2.0', author: 'Sam', license: 'Use freely.' });
  assert.deepEqual(exportRequest(choice, form({ name: 'تصميم' })), { themes: ['acme'], templates: ['report'], name: 'تصميم', version: '1.0.0' });
  assert.deepEqual(Object.keys(exportRequest(choice, form({ version: '' }))), ['themes', 'templates']);
  // The request is a copy: later changes to the choice do not reach it.
  const body = exportRequest(choice, form());
  choice.themes.push('late');
  assert.deepEqual(body.themes, ['acme']);
});

test('export form problems match what the server would refuse', () => {
  assert.deepEqual(exportProblems(form({ name: 'Acme' })), {});
  assert.deepEqual(exportProblems(form({ version: '' })), {});
  for (const version of ['1.0', 'v1.0.0', '1.0.0-beta', '01.0.0', '1.0.x']) assert.ok(exportProblems(form({ version })).version, version);
  assert.ok(exportProblems(form({ name: 'x'.repeat(201) })).name);
  assert.ok(exportProblems(form({ license: 'x'.repeat(1001) })).license);
  assert.equal(exportProblems(form({ license: 'x'.repeat(1000) })).license, undefined);
});

test('an existing output file is explained as a change of version or name, other errors pass through', () => {
  assert.match(exportFailure({ status: 409, message: 'Pack output already exists (EEXIST): /x/y.zip. Choose a new output path or pack version.' }), /Change the version/);
  assert.doesNotMatch(exportFailure({ status: 409, message: 'Pack output already exists (EEXIST): /x/y.zip.' }), /\/x\/y/);
  assert.equal(exportFailure({ status: 400, message: 'Pack dependencies changed while exporting.' }), 'Pack dependencies changed while exporting.');
  assert.equal(exportFailure({ status: 409, message: 'Another pack is installing.' }), 'Another pack is installing.');
});

test('install is blocked by conflicts and by a version the workspace cannot take, and trust alone never lifts that', () => {
  assert.deepEqual(packBlockers(inspection()), []);
  const conflict = packBlockers(inspection({ conflicts: ['themes/acme/index.ts'] }));
  assert.deepEqual(conflict.map(item => item.kind), ['conflicts']);
  assert.match(conflict[0].message, /never overwrites/);
  assert.doesNotMatch(conflict[0].message, /overwrite (it|them|the)\b/, 'no way to overwrite is offered');
  const old = packBlockers(inspection({ compatibility: { compatible: false, requiredVersion: '0.7.0', currentVersion: '0.6.1' } }));
  assert.deepEqual(old.map(item => item.kind), ['incompatible']);
  assert.match(old[0].message, /0\.7\.0/); assert.match(old[0].message, /0\.6\.1/);
  assert.equal(canInstall(conflict, true, false), false);
  assert.equal(canInstall(old, true, false), false);
});

test('install needs an explicit trust tick and no request in flight', () => {
  assert.equal(canInstall([], false, false), false, 'trust not ticked');
  assert.equal(canInstall([], true, true), false, 'already installing');
  assert.equal(canInstall([], true, false), true);
});

test('a pack with nothing new, a read-only workspace and a lost connection are each said plainly', () => {
  assert.deepEqual(packBlockers(inspection({ added: [] })).map(item => item.kind), ['nothing-new']);
  // Conflicts take the place of "nothing new": a pack with differing files is not "already installed".
  assert.deepEqual(packBlockers(inspection({ added: [], conflicts: ['themes/acme/index.ts'] })).map(item => item.kind), ['conflicts']);
  const readOnly = packBlockers(inspection(), { readOnly: 'This workspace was made by a newer OpenDoc, so it is open read-only.' });
  assert.deepEqual(readOnly.map(item => item.kind), ['read-only']);
  assert.equal(readOnly[0].message, 'This workspace was made by a newer OpenDoc, so it is open read-only.', 'the app writes the message and it is shown as given');
  assert.deepEqual(packBlockers(inspection(), { connected: false }).map(item => item.kind), ['offline']);
  assert.deepEqual(packBlockers(inspection(), { connected: true }), []);
});

test('installed designs link to their gallery pages', () => {
  assert.deepEqual(installedLinks([{ kind: 'theme', id: 'acme' }, { kind: 'template', id: 'report' }]).map(item => item.href), ['#themes/acme', '#templates/report']);
});

test('file sizes and pack file names', () => {
  assert.equal(fileSize(0), '0 B'); assert.equal(fileSize(1023), '1023 B'); assert.equal(fileSize(1536), '1.5 KB'); assert.equal(fileSize(5 * 1048576), '5 MB');
  assert.equal(isPackFileName('acme-1.0.0.opendoc.zip'), true);
  assert.equal(isPackFileName('Acme.ZIP'), true);
  assert.equal(isPackFileName('notes.pdf'), false);
});

test('the entry point: open with a file, or without, and the dialog takes it once', () => {
  const entry = createImportEntry();
  let calls = 0;
  const stop = entry.subscribe(() => calls++);
  assert.equal(entry.get(), null);
  entry.open();
  assert.equal(entry.get()?.file, undefined);
  const first = entry.get()!.id;
  entry.open({ name: 'acme.opendoc.zip', bytes: new Uint8Array([80, 75, 3, 4]) });
  const second = entry.get()!;
  assert.ok(second.id > first, 'each open is a new request, so the dialog restarts with the new file');
  assert.equal(second.file?.name, 'acme.opendoc.zip');
  assert.equal(second.file?.size, 4);
  const real = new File([new Uint8Array(3)], 'chosen.opendoc.zip');
  entry.open(real);
  assert.equal(entry.get()?.file, real, 'a File from the page is used as it is');
  entry.close();
  assert.equal(entry.get(), null);
  const done = calls;
  entry.close();
  assert.equal(calls, done, 'closing twice announces nothing');
  stop();
  entry.open();
  assert.equal(calls, done, 'an unsubscribed listener hears nothing');
});

test('bytes from the shell become a pack File with the same bytes', async () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const file = packFile({ name: 'x.opendoc.zip', bytes });
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes);
  const buffer = bytes.buffer.slice(0) as ArrayBuffer;
  assert.equal((await packFile({ name: 'y.opendoc.zip', bytes: buffer }).arrayBuffer()).byteLength, 5);
});

test('only the first mounted dialog host is active, and the next takes over when it leaves', () => {
  const hosts = createHostRegistry();
  const shell = Symbol('shell'), gallery = Symbol('gallery');
  const changes: (symbol | undefined)[] = [];
  hosts.subscribe(() => changes.push(hosts.active()));
  assert.equal(hosts.active(), undefined);
  const leaveShell = hosts.register(shell);
  const leaveGallery = hosts.register(gallery);
  assert.equal(hosts.active(), shell);
  leaveShell();
  assert.equal(hosts.active(), gallery);
  leaveGallery();
  assert.equal(hosts.active(), undefined);
  assert.deepEqual(changes, [shell, gallery, undefined]);
});

test('an inspected pack that is not installed is given back on Cancel, on Close, and when the dialog restarts with a new file', () => {
  const sent: string[] = [];
  const hold = createStagedHold(id => { sent.push(id); });
  // Cancel or Close after an inspection (the dialog calls `release` for both, and again when it goes away).
  hold.hold('a');
  assert.equal(hold.held(), 'a');
  hold.release();
  hold.release();
  assert.deepEqual(sent, ['a'], 'one discard, however many times the dialog closes');
  assert.equal(hold.held(), undefined);
  // A new file after an inspection that did not install: the first upload goes, the second is held.
  hold.hold('b');
  hold.hold('c');
  assert.deepEqual(sent, ['a', 'b']);
  assert.equal(hold.held(), 'c');
  hold.hold('c');
  assert.deepEqual(sent, ['a', 'b'], 'the same pack held again is not discarded');
  // Installed, or already gone on the server: nothing to give back.
  hold.forget();
  hold.release();
  assert.deepEqual(sent, ['a', 'b']);
  // An inspection that finished after the user had closed the dialog was never shown: it goes at once.
  hold.abandon('d');
  assert.deepEqual(sent, ['a', 'b', 'd']);
  hold.release();
  assert.deepEqual(sent, ['a', 'b', 'd'], 'nothing held, nothing sent');
});

test('giving a pack back never blocks or fails closing', async () => {
  let started = 0;
  const slow = createStagedHold(() => { started++; return new Promise(() => {}); }); // Never answers.
  slow.hold('a');
  slow.release(); // Returns at once.
  assert.equal(started, 1);
  assert.equal(slow.held(), undefined, 'the dialog is free of it straight away');
  const failing = createStagedHold(() => Promise.reject(new Error('offline')));
  failing.hold('a'); failing.release();
  const throwing = createStagedHold(() => { throw new Error('no network'); });
  throwing.hold('a'); throwing.release(); throwing.abandon('b');
  await new Promise(accept => setImmediate(accept));
  assert.equal(throwing.held(), undefined);
});

test('discarding a staged pack sends DELETE with the session token to the staging route', async () => {
  const original = globalThis.fetch;
  const calls: { path: string; method?: string; token: string | null }[] = [];
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    calls.push({ path, method: init?.method, token: new Headers(init?.headers).get('X-OpenDoc-Token') });
    return new Response(JSON.stringify(path === '/api/session' ? { token: 'test-session' } : { removed: true }), { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const { discardStagedPack } = await import(`../src/app/api.ts?test=${Date.now()}-${Math.random()}`) as typeof import('../src/app/api');
    assert.deepEqual(await discardStagedPack('0b6f1a52-8d3c-4f0e-9a41-2c7d5e8f9a10'), { removed: true });
    assert.deepEqual(calls.at(-1), { path: '/api/packs/staged/0b6f1a52-8d3c-4f0e-9a41-2c7d5e8f9a10', method: 'DELETE', token: 'test-session' });
    await discardStagedPack('../x');
    assert.equal(calls.at(-1)!.path, '/api/packs/staged/..%2Fx', 'an id is never a path');
  } finally { globalThis.fetch = original; }
});
