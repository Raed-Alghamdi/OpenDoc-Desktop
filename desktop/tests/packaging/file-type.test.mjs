// The installer config's entries for the agent integrations and the design pack file type: the extraResources entry, the
// shared-mime type and the .desktop MimeType line on Linux, and the document type on macOS. Reads the config and the files it names;
// the real packages are checked by check-artifacts.mjs and check-packaged.mjs after a build.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { builderConfig, desktop, documentTypeProblems, PACK_EXTENSION, PACK_MIME_TYPE } from './builder-support.mjs';

const config = builderConfig();
const mimePath = path.join(desktop, 'resources', 'mime', 'opendoc-desktop.xml');
const mimeXml = readFileSync(mimePath, 'utf8');
const mimeDestination = '/usr/share/mime/packages/opendoc-desktop.xml';

test('the integrations folder goes to resources/integrations with every file, dot folders included', () => {
  const entry = config.extraResources.find((item) => item.from === 'integrations');
  assert.deepEqual(entry, { from: 'integrations', to: 'integrations', filter: ['**/*'] });
  // The files the module refuses to run without (it reports copy-failed and the missing name); they live in dot folders.
  for (const file of ['claude/.claude-plugin/marketplace.json', 'codex/.agents/plugins/marketplace.json', 'check.mjs']) {
    assert.ok(existsSync(path.join(desktop, 'integrations', file)), file);
  }
  // The runtime entries stay as they were.
  assert.ok(config.extraResources.some((item) => item.to === 'runtime'));
  assert.ok(config.extraResources.some((item) => item.to === 'runtime/node_modules'));
});

test('the shared-mime entry defines one type for *.opendoc.zip and no other glob', () => {
  assert.match(mimeXml, new RegExp(`<mime-type type="${PACK_MIME_TYPE}">`));
  assert.equal(mimeXml.match(/<mime-type /g).length, 1);
  assert.deepEqual([...mimeXml.matchAll(/<glob pattern="([^"]*)"/g)].map((match) => match[1]), [`*.${PACK_EXTENSION}`]);
  // A pack is still a ZIP file: archive managers keep offering it, and plain ZIP files are not matched by this entry.
  assert.match(mimeXml, /<sub-class-of type="application\/zip"\/>/);
  const xmllint = spawnSync('xmllint', ['--noout', mimePath], { encoding: 'utf8' });
  if (!xmllint.error) assert.equal(xmllint.status, 0, xmllint.stderr);
});

test('deb, rpm and pacman install that file, and every Linux target names the type in the .desktop file', () => {
  assert.deepEqual(config.linux.mimeTypes, [PACK_MIME_TYPE]);
  for (const target of ['deb', 'pacman', 'rpm']) {
    const mapped = config[target].fpm.filter((item) => item.endsWith(`=${mimeDestination}`));
    assert.deepEqual(mapped, [`resources/mime/opendoc-desktop.xml=${mimeDestination}`], target);
    assert.ok(existsSync(path.join(desktop, mapped[0].split('=')[0])), `${target}: the mapped file exists`);
  }
  // The config must not claim plain ZIP files anywhere: no zip type in the Linux or macOS entries.
  assert.ok(!/application\/zip/.test(JSON.stringify(config.linux.mimeTypes)));
  assert.equal(config.fileAssociations, undefined, 'a top-level fileAssociations entry would reach every platform');
  assert.equal(config.linux.fileAssociations, undefined);
  assert.equal(config.mac.fileAssociations, undefined, 'fileAssociations would list the extension as a CFBundleTypeExtensions entry');
});

test('the macOS document type is ours alone and never claims plain ZIP files', () => {
  const info = config.mac.extendInfo;
  assert.deepEqual(documentTypeProblems(info, config.appId), []);
  const [documentType] = info.CFBundleDocumentTypes;
  assert.deepEqual(documentType.LSItemContentTypes, [`${config.appId}.pack`]);
  assert.equal(documentType.CFBundleTypeExtensions, undefined);
  assert.notEqual(documentType.LSHandlerRank, 'Default', 'no system type is listed, so the rank only applies to our own type');
});

test('the document type rule rejects every way of claiming ZIP files', () => {
  const good = structuredClone(config.mac.extendInfo);
  const change = (edit) => { const info = structuredClone(good); edit(info); return documentTypeProblems(info, config.appId); };
  assert.match(change((info) => info.CFBundleDocumentTypes[0].LSItemContentTypes.push('public.zip-archive')).join('\n'), /public\.zip-archive/);
  assert.match(change((info) => info.CFBundleDocumentTypes[0].LSItemContentTypes.push('public.data')).join('\n'), /public\.data/);
  assert.match(change((info) => { info.CFBundleDocumentTypes[0].CFBundleTypeExtensions = ['zip']; }).join('\n'), /extension zip/);
  assert.match(change((info) => { info.CFBundleDocumentTypes[0].CFBundleTypeMIMETypes = ['application/zip']; }).join('\n'), /application\/zip/);
  assert.match(change((info) => info.CFBundleDocumentTypes.push({ CFBundleTypeName: 'ZIP', LSItemContentTypes: ['com.pkware.zip-archive'] })).join('\n'), /com\.pkware\.zip-archive/);
  assert.match(change((info) => info.UTExportedTypeDeclarations[0].UTTypeTagSpecification['public.filename-extension'].push('zip')).join('\n'), /plain extension zip/);
  assert.match(change((info) => { info.UTExportedTypeDeclarations[0].UTTypeTagSpecification['public.filename-extension'] = ['zip']; }).join('\n'), /does not carry the extension/);
  assert.match(change((info) => { info.CFBundleDocumentTypes = []; }).join('\n'), /no document type lists/);
  assert.match(change((info) => { info.UTExportedTypeDeclarations = []; }).join('\n'), /is not exported/);
  assert.deepEqual(documentTypeProblems({}, config.appId).length > 0, true);
});

// The real check of the type's behaviour: a private shared-mime database built from the entry, searched together with the system's.
// Everything stays inside a scratch folder; the system database is only read.
test('a scratch shared-mime database types *.opendoc.zip as the pack and plain .zip files still as application/zip', (t) => {
  const tools = ['update-mime-database', 'gio'].map((name) => spawnSync(name, ['--version'], { encoding: 'utf8' }));
  if (tools.some((result) => result.error) || !existsSync('/usr/share/mime/mime.cache')) { t.skip('update-mime-database, gio and the system database are needed'); return; }
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'opendoc-mime-'));
  try {
    mkdirSync(path.join(scratch, 'data', 'mime', 'packages'), { recursive: true });
    mkdirSync(path.join(scratch, 'files'));
    writeFileSync(path.join(scratch, 'data', 'mime', 'packages', 'opendoc-desktop.xml'), mimeXml);
    const build = spawnSync('update-mime-database', [path.join(scratch, 'data', 'mime')], { encoding: 'utf8' });
    assert.equal(build.status, 0, build.stderr);
    const env = { PATH: process.env.PATH, HOME: path.join(scratch, 'home'), XDG_DATA_HOME: path.join(scratch, 'data'), XDG_DATA_DIRS: '/usr/share', XDG_CONFIG_HOME: path.join(scratch, 'config'), XDG_CACHE_HOME: path.join(scratch, 'cache') };
    const typeOf = (name) => {
      writeFileSync(path.join(scratch, 'files', name), 'PK\u0005\u0006' + '\0'.repeat(18));
      const result = spawnSync('gio', ['info', '-a', 'standard::content-type', path.join(scratch, 'files', name)], { encoding: 'utf8', env });
      return result.stdout.match(/standard::content-type: (\S+)/)?.[1];
    };
    assert.equal(typeOf('civic-pack-0.6.1.opendoc.zip'), PACK_MIME_TYPE);
    assert.equal(typeOf('photos.zip'), 'application/zip');
    assert.equal(typeOf('opendoc.zip.txt'), 'text/plain');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('check-packaged.mjs accepts the unpacked apps it should and names what is wrong otherwise', () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'opendoc-packaged-'));
  const script = path.join(desktop, 'tests', 'packaging', 'check-packaged.mjs');
  const run = (...args) => spawnSync(process.execPath, [script, '--dist', path.join(scratch, 'dist'), ...args], { encoding: 'utf8' });
  const plist = (types) => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${types}</dict></plist>\n`;
  const goodTypes = `<key>CFBundleDocumentTypes</key><array><dict><key>CFBundleTypeName</key><string>OpenDoc design pack</string><key>LSItemContentTypes</key><array><string>${config.appId}.pack</string></array></dict></array>`
    + `<key>UTExportedTypeDeclarations</key><array><dict><key>UTTypeIdentifier</key><string>${config.appId}.pack</string><key>UTTypeConformsTo</key><array><string>public.zip-archive</string></array><key>UTTypeTagSpecification</key><dict><key>public.filename-extension</key><array><string>${PACK_EXTENSION}</string></array><key>public.mime-type</key><array><string>${PACK_MIME_TYPE}</string></array></dict></dict></array>`;
  try {
    for (const resources of [path.join(scratch, 'dist', 'linux-unpacked', 'resources'), path.join(scratch, 'dist', 'mac-arm64', 'opendoc-desktop.app', 'Contents', 'Resources')]) {
      mkdirSync(resources, { recursive: true });
      cpSync(path.join(desktop, 'integrations'), path.join(resources, 'integrations'), { recursive: true });
    }
    cpSync(path.join(desktop, 'resources', 'updater'), path.join(scratch, 'dist', 'linux-unpacked', 'resources', 'updater'), { recursive: true });
    writeFileSync(path.join(scratch, 'dist', 'mac-arm64', 'opendoc-desktop.app', 'Contents', 'Info.plist'), plist(goodTypes));
    const good = run('--require', 'linux', '--require', 'mac');
    assert.equal(good.status, 0, good.stdout + good.stderr);
    assert.equal(good.stdout.match(/^ok /gm).length, 5);

    // A file filter that drops dot folders.
    rmSync(path.join(scratch, 'dist', 'linux-unpacked', 'resources', 'integrations', 'codex', '.agents'), { recursive: true });
    const dropped = run();
    assert.notEqual(dropped.status, 0);
    assert.match(dropped.stdout, /FAIL {2}linux-unpacked integrations: missing .*\.agents/);

    // An app that claims plain ZIP files.
    writeFileSync(path.join(scratch, 'dist', 'mac-arm64', 'opendoc-desktop.app', 'Contents', 'Info.plist'), plist(goodTypes.replace(`<string>${config.appId}.pack</string></array></dict></array><key>UT`, `<string>${config.appId}.pack</string><string>public.zip-archive</string></array></dict></array><key>UT`)));
    const claimed = run('--require', 'mac');
    assert.notEqual(claimed.status, 0);
    assert.match(claimed.stdout, /public\.zip-archive/);

    // Nothing to check is a failure too, and a required platform must be present.
    assert.notEqual(spawnSync(process.execPath, [script, '--dist', path.join(scratch, 'empty')], { encoding: 'utf8' }).status, 0);
    rmSync(path.join(scratch, 'dist', 'mac-arm64'), { recursive: true });
    assert.match(run('--require', 'mac').stdout, /FAIL {2}mac: no unpacked app/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
