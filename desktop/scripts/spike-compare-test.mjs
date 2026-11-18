// Table test of the build-aware version check, using the real electron-updater AppImageUpdater class and a fake app adapter.
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const desktop = new URL('../', import.meta.url).pathname;
const require = createRequire(path.join(desktop, 'package.json'));
const { AppImageUpdater } = require('electron-updater');
const { withBuildCompare } = await import(path.join(desktop, 'src/build-compare.mjs'));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'cmp-'));
const mk = (version, build, Cls) => new Cls(null, { version, name: 'x', isPackaged: true, appUpdateConfigPath: '', userDataPath: tmp, baseCachePath: tmp, whenReady: async () => {}, quit() {}, relaunch() {}, onQuit() {} });
const Stock = AppImageUpdater;
const rows = [
  // [current version, current build, feed info, expected]
  ['0.6.1', 1, { version: '0.6.1', build: 2 }, true, 'same version, higher build'],
  ['0.6.1', 1, { version: '0.6.1', build: 1 }, false, 'same version, same build'],
  ['0.6.1', 2, { version: '0.6.1', build: 1 }, false, 'same version, lower build (no downgrade)'],
  ['0.6.1', 1, { version: '0.6.1' }, false, 'same version, feed has no build field'],
  ['0.6.1', 0, { version: '0.6.1', build: 1 }, true, 'running build unknown (0), feed build 1'],
  ['0.6.1', 5, { version: '0.6.2', build: 1 }, true, 'higher version beats any build'],
  ['0.6.1', 5, { version: '0.7.0' }, true, 'higher minor, feed has no build field'],
  ['0.6.2', 1, { version: '0.6.1', build: 9 }, false, 'lower version never offered, even with a high build'],
  ['0.6.1', 1, { version: '0.6.1', build: '2' }, true, 'build written as text "2"'],
  ['0.6.1', 1, { version: '0.6.1', build: 2.5 }, false, 'build not a whole number'],
  ['0.6.1', 1, { version: '0.6.1', build: -3 }, false, 'negative build'],
  ['0.6.1', 1, { version: '0.6.1', build: 'abc' }, false, 'build is text'],
  ['0.6.1', 1, { version: '0.6.1', build: 2, minimumSystemVersion: '99.0.0' }, false, 'same version, OS too old (stock rule still applies)'],
  ['0.6.1', 1, { version: '0.6.1', build: 2, stagingPercentage: 0 }, false, 'same version, rollout 0 percent (stock rule still applies)'],
  ['0.6.1', 1, { version: '0.6.1', build: 2, stagingPercentage: 100 }, true, 'same version, rollout 100 percent'],
];
let bad = 0;
for (const [cv, cb, info, want, label] of rows) {
  const Cls = withBuildCompare(Stock, () => cb);
  const got = await mk(cv, cb, Cls).isUpdateAvailable(info);
  const stock = await mk(cv, cb, Stock).isUpdateAvailable(info);
  const ok = got === want; if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  current ${cv} b${cb} vs feed ${JSON.stringify(info)}  -> ${got} (stock check: ${stock})  ${label}`);
}
try { await mk('0.6.1', 1, withBuildCompare(Stock, () => 1)).isUpdateAvailable({ version: 'banana', build: 2 }); console.log('FAIL invalid version accepted'); bad++; }
catch (e) { console.log(`PASS  invalid feed version rejected by the stock check: ${e.code}`); }
console.log(bad === 0 ? 'ALL PASS' : `${bad} FAILED`);
process.exit(bad ? 1 : 0);
