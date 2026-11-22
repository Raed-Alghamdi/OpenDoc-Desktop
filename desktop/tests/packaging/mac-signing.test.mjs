// The macOS signing hooks (runtime/mac-signing.mjs) and the environment dist.mjs gives electron-builder: codesign writes into the
// files it signs, so the read-only runtime inside the .app is opened just before signing and closed right after.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { builderEnvironment } from '../../runtime/builder-environment.mjs';
import * as hooks from '../../runtime/mac-signing.mjs';
import { setWritable, writableEntries } from '../../runtime/permissions.mjs';
import { builderConfig } from './builder-support.mjs';

/** A packed app as electron-builder hands it to the hooks: appOutDir/<productFilename>.app with a read-only runtime inside. */
function packed(platform = 'darwin') {
  const out = mkdtempSync(path.join(os.tmpdir(), 'opendoc-mac-signing-'));
  const runtime = path.join(out, 'opendoc-desktop.app', 'Contents', 'Resources', 'runtime');
  mkdirSync(path.join(runtime, 'node_modules', 'opendoc', 'starter'), { recursive: true });
  mkdirSync(path.join(runtime, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(path.join(runtime, 'node_modules', 'opendoc', 'starter', 'font.ttf'), 'a font');
  writeFileSync(path.join(runtime, 'node_modules', 'opendoc', 'canvas.node'), 'a native piece');
  symlinkSync('../opendoc/canvas.node', path.join(runtime, 'node_modules', '.bin', 'link'));
  setWritable(runtime, false);
  const context = { appOutDir: out, electronPlatformName: platform, packager: { appInfo: { productFilename: 'opendoc-desktop' } } };
  return { out, runtime, context, cleanup: () => { if (existsSync(runtime)) setWritable(runtime, true); rmSync(out, { recursive: true, force: true }); } };
}

test('on macOS the runtime is writable between packing and signing, and read-only again after signing', async () => {
  const app = packed();
  try {
    assert.deepEqual(writableEntries(app.runtime), []);
    await hooks.afterPack(app.context);
    assert.deepEqual(writableEntries(app.runtime).sort(), ['.', 'node_modules', 'node_modules/.bin', 'node_modules/opendoc', 'node_modules/opendoc/canvas.node', 'node_modules/opendoc/starter', 'node_modules/opendoc/starter/font.ttf']);
    await hooks.afterSign(app.context);
    assert.deepEqual(writableEntries(app.runtime), []);
  } finally { app.cleanup(); }
});

test('the hooks leave a Linux build alone', async () => {
  const app = packed('linux');
  try {
    assert.equal(hooks.macRuntime(app.context), null);
    await hooks.afterPack(app.context);
    assert.deepEqual(writableEntries(app.runtime), []);
  } finally { app.cleanup(); }
});

test('a Mac app without its runtime stops the build, naming where the runtime should be', async () => {
  const app = packed();
  try {
    app.context.packager.appInfo.productFilename = 'other';
    await assert.rejects(hooks.afterPack(app.context), /No runtime in .*other\.app: .*Contents\/Resources\/runtime/);
  } finally { app.cleanup(); }
});

test('electron-builder.yml names the module for both hooks, and the module exports them by those names', () => {
  const config = builderConfig();
  assert.equal(config.afterPack, './runtime/mac-signing.mjs');
  assert.equal(config.afterSign, './runtime/mac-signing.mjs');
  // electron-builder takes the export named after the hook before the default one.
  assert.equal(typeof hooks.afterPack, 'function');
  assert.equal(typeof hooks.afterSign, 'function');
});

test('dist.mjs signs a Mac pull request build too, and never searches the keychain for an identity', () => {
  assert.equal(builderEnvironment({}, 'darwin').CSC_FOR_PULL_REQUEST, 'true');
  assert.equal(builderEnvironment({}, 'linux').CSC_FOR_PULL_REQUEST, undefined);
  assert.equal(builderEnvironment({}, 'darwin').CSC_IDENTITY_AUTO_DISCOVERY, 'false');
  assert.equal(builderEnvironment({ CSC_IDENTITY_AUTO_DISCOVERY: 'true', PATH: '/bin' }, 'linux').CSC_IDENTITY_AUTO_DISCOVERY, 'true');
  assert.equal(builderEnvironment({ PATH: '/bin' }, 'darwin').PATH, '/bin');
});
