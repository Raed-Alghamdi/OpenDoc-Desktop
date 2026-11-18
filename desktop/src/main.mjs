// Spike S4 minimal shell: one window, plus --selftest for the packaging checks.
import { app, BrowserWindow } from 'electron';
import { execFile } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const runtimeDir = app.isPackaged
  ? path.join(process.resourcesPath, 'runtime')
  : path.join(app.getAppPath(), 'build', 'runtime', `${process.platform}-${process.arch}`);
const cli = path.join(runtimeDir, 'node_modules', 'opendoc', 'bin', 'opendoc.mjs');

function runCli(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout: stdout.trim(), stderr: stderr.trim().slice(0, 400) });
    });
  });
}

// Spike for E3/E4: what the AppImage does at launch (runtime copy, then the shim with the AppImage's location).
function appImageSetup() {
  const data = path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'opendoc-desktop');
  const version = JSON.parse(readFileSync(path.join(runtimeDir, 'package.json'), 'utf8')).version;
  const build = JSON.parse(readFileSync(path.join(runtimeDir, 'build-info.json'), 'utf8')).build;
  const target = path.join(data, 'runtime', `${version}-${build}`);
  const started = Date.now();
  if (!existsSync(path.join(target, 'node_modules', 'opendoc', 'bin', 'opendoc.mjs'))) cpSync(runtimeDir, target, { recursive: true, force: true, verbatimSymlinks: true });
  const bin = path.join(os.homedir(), '.local', 'bin');
  mkdirSync(bin, { recursive: true });
  const shim = readFileSync(path.join(process.resourcesPath, 'cli', 'opendoc-appimage.sh'), 'utf8').replace('@APPIMAGE@', process.env.APPIMAGE);
  writeFileSync(path.join(bin, 'opendoc'), shim);
  chmodSync(path.join(bin, 'opendoc'), 0o755);
  return { appimage: process.env.APPIMAGE, runtimeCopy: target, copyMs: Date.now() - started, shim: path.join(bin, 'opendoc') };
}

// Fuse probes: what a file:// page may do, and whether cookies can be stored.
async function fuseProbe() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'od-fuse-'));
  writeFileSync(path.join(dir, 'data.txt'), 'probe-data');
  writeFileSync(path.join(dir, 'probe.html'), '<!doctype html><script>(async()=>{const r={};'
    + 'try{r.fetchFile=await (await fetch("data.txt")).text()}catch(e){r.fetchFile="blocked: "+e.message}'
    + 'try{localStorage.setItem("k","v");r.localStorage=localStorage.getItem("k")}catch(e){r.localStorage="blocked"}'
    + 'document.title=JSON.stringify(r)})()</script>');
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  await win.loadFile(path.join(dir, 'probe.html'));
  await new Promise((r) => setTimeout(r, 800));
  const file = win.webContents.getTitle();
  let cookie;
  try {
    await win.webContents.session.cookies.set({ url: 'https://example.invalid', name: 'k', value: 'v', expirationDate: Date.now() / 1000 + 3600 });
    cookie = (await win.webContents.session.cookies.get({ url: 'https://example.invalid' })).map((c) => c.value);
  } catch (e) { cookie = `error: ${e.message}`; }
  return { fileProtocol: file, cookie };
}

app.whenReady().then(async () => {
  if (process.argv.includes('--fuse-probe')) {
    console.log(JSON.stringify(await fuseProbe()));
    return app.quit();
  }
  if (process.argv.includes('--install-agent-command')) {
    console.log(JSON.stringify(process.env.APPIMAGE ? appImageSetup() : { error: 'not running from an AppImage' }));
    return app.quit();
  }
  const selftest = process.argv.includes('--selftest');
  const win = new BrowserWindow({ width: 900, height: 600, show: !selftest, webPreferences: { contextIsolation: true, sandbox: true } });
  const version = await runCli(['--version']);
  await win.loadURL(`data:text/html,<h1>opendoc-desktop spike S4</h1><p>runtime ${encodeURIComponent(runtimeDir)}</p><p>opendoc ${encodeURIComponent(version.stdout)}</p>`);
  if (!selftest) return;
  const page = await win.webContents.executeJavaScript('document.body.innerText');
  // Linux sandbox evidence: Seccomp mode 2 on the renderer and GPU helper processes means the sandbox is active.
  const sandbox = app.getAppMetrics().map((m) => {
    let seccomp = '?';
    try { seccomp = /Seccomp:\s+(\d)/.exec(readFileSync(`/proc/${m.pid}/status`, 'utf8'))?.[1] ?? '?'; } catch {}
    return `${m.type}:seccomp=${seccomp}`;
  });
  console.log(JSON.stringify({
    selftest: true, isPackaged: app.isPackaged, electron: process.versions.electron, node: process.versions.node,
    runtimeDir, runtimeExists: existsSync(cli), cli: version, page: page.slice(0, 80),
    argv: process.argv.slice(1), sandbox,
  }));
  app.quit();
});
app.on('window-all-closed', () => app.quit());
