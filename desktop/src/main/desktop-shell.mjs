// The shell: which workspace is open, its service, its window and the picker. One workspace at a time.
import { app, dialog, ipcMain, session, shell } from 'electron';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { showAbout } from './about.mjs';
import { CommandLineTool } from './command-line-tool.mjs';
import { createConfig, forgetWorkspace, rememberWorkspace } from './config.mjs';
import { clearStaleDesktopRecord, inspectDesktopRecord, removeDesktopRecord, writeDesktopRecord } from './desktop-record.mjs';
import { appVersion, environment, serviceOrigin } from './identity.mjs';
import { acquireWorkspaceLock, clearStaleWorkspaceLock, WorkspaceLockError } from './lock.mjs';
import { installMenu } from './menu.mjs';
import { isShellUrl, originOf } from './policy.mjs';
import { cliPath, readBuildInfo, runCli } from './runtime.mjs';
import { inspectService } from './service-session.mjs';
import { applySessionPolicy, openExternal } from './session-policy.mjs';
import { shellPageUrl } from './shell-pages.mjs';
import { superviseTransport } from './supervisor.mjs';
import { serviceLocation, startTransport, TransportError } from './transport.mjs';
import { WorkspaceWindow, createPickerWindow, guardAllContents } from './windows.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
// Electron's dialogs take the parent window first, or no window at all.
const ask = (name, parent, options) => parent && !parent.isDestroyed() ? dialog[name](parent, options) : dialog[name](options);
const lastLine = text => String(text).split('\n').map(line => line.trim()).filter(Boolean).at(-1) ?? '';

export class DesktopShell {
  constructor({ runtime, templatePath, fallbackRoot }) {
    const userData = app.getPath('userData');
    this.runtime = runtime;
    this.fallbackRoot = fallbackRoot; // Development: the repository, when the runtime folder has no service
    this.config = createConfig(join(userData, 'config.json'));
    this.commandLine = new CommandLineTool({ config: this.config, runtime, templatePath, home: app.getPath('home'), parent: () => this.#parent() });
    this.windowStateFile = join(userData, 'window-state.json');
    this.logsDir = join(userData, 'logs');
    this.sessions = new Map();
    this.current = null;
    this.picker = null;
    this.opening = false;
    this.stopped = false;
    this.healthInterval = Number(process.env[environment.healthInterval]) || 5000;
  }

  /** True while the app moves between windows, so closing one does not end the app. */
  get keepAlive() { return this.opening || this.switching; }

  // ---------- start and stop ----------

  async start() {
    this.build = await readBuildInfo(this.runtime);
    this.version = await appVersion();
    guardAllContents(() => this.#origins());
    this.#registerIpc();
    await this.#refreshMenu();
    const { defaultWorkspace } = await this.config.read();
    if (typeof defaultWorkspace === 'string' && await this.#isWorkspace(defaultWorkspace)) {
      const result = await this.openWorkspace(defaultWorkspace);
      if (!result.ok) await this.showPicker(result);
    } else await this.showPicker();
    // The agent command (AppImage launcher, macOS refresh) is set up once a window is up, and never holds the app back.
    void this.commandLine.launch();
  }

  /** Stop the service, remove desktop.json and release the lock. Called from will-quit, once. */
  async shutdown() {
    if (this.stopped) return;
    this.stopped = true;
    await this.#teardown(this.current).catch(error => console.error('Shutdown problem:', error.message));
    this.current = null;
  }

  async #teardown(current) {
    if (!current) return;
    current.unfollow?.();
    await current.supervisor?.stop();
    await removeDesktopRecord(current.root);
    await current.lock?.release();
  }

  // ---------- workspaces ----------

  async #isWorkspace(path) {
    try { return (await stat(join(path, '.opendoc', 'workspace.json'))).isFile(); } catch { return false; }
  }

  #origins() {
    const origin = this.current?.supervisor?.transport.origin;
    return origin ? [origin] : [];
  }

  #sessionFor(root) {
    const partition = `persist:ws-${hash(root).slice(0, 16)}`;
    if (!this.sessions.has(partition)) {
      const ses = session.fromPartition(partition);
      applySessionPolicy(ses, {
        origins: () => this.current?.session === ses ? this.#origins() : [],
        transport: () => this.current?.session === ses ? this.current.supervisor?.transport ?? null : null,
      });
      this.sessions.set(partition, ses);
    }
    return { partition, session: this.sessions.get(partition) };
  }

  #shellSession() {
    if (!this.sessions.has('shell')) {
      const ses = session.fromPartition('shell');
      applySessionPolicy(ses, { origins: () => [], transport: () => null });
      this.sessions.set('shell', ses);
    }
    return this.sessions.get('shell');
  }

  /** Open a workspace. Resolves { ok: true }, { ok: false, canceled: true } or { ok: false, code, message, path }. */
  async openWorkspace(input) {
    if (this.opening) return { ok: false, message: 'Another workspace is opening. Wait a moment.' };
    this.opening = true;
    let lock = null;
    let left = false;
    const fail = async result => {
      // Having let go of the previous workspace, leave the user somewhere they can act: the picker, with the reason.
      if (left && !this.current && !this.picker) await this.showPicker(result);
      return result;
    };
    try {
      let root;
      try { root = await realpath(resolve(input)); } catch { return { ok: false, code: 'missing', message: `The folder ${input} was not found.`, path: input }; }
      if (!(await this.#isWorkspace(root))) return { ok: false, code: 'not-a-workspace', message: `${root} is not an OpenDoc workspace. A workspace has a .opendoc/workspace.json file; create a new one instead.`, path: root };
      if (this.current?.root === root) { this.#focus(); return { ok: true }; }

      // Check the workspace before letting go of the one that is open.
      const owner = await inspectDesktopRecord(root);
      if (owner.state === 'live') return { ok: false, code: 'open-elsewhere', message: `This workspace is already open in another opendoc-desktop (process ${owner.record.pid}). Close it there first.`, path: root };
      const service = await inspectService(root);
      if (service.state === 'running') return { ok: false, code: 'service-running', message: `OpenDoc is already running for this workspace in a browser (process ${service.pid}, ${service.origin}). Stop it before opening the workspace here.`, path: root };
      if (service.state !== 'none') return { ok: false, code: 'service-unclear', message: service.state === 'finishing' ? 'OpenDoc is still finishing its previous session for this workspace. Wait a moment, then try again.' : service.message, path: root };
      try { lock = await acquireWorkspaceLock(root); }
      catch (error) {
        if (error instanceof WorkspaceLockError) return { ok: false, code: error.code, message: error.message, path: root };
        throw error;
      }
      if (this.current) {
        left = true;
        if (!(await this.#leaveCurrent())) return { ok: false, canceled: true };
      }
      await clearStaleDesktopRecord(root);

      const log = join(this.logsDir, `workspace-${hash(root).slice(0, 8)}.log`);
      const location = serviceLocation({ runtime: this.runtime, fallbackRoot: this.fallbackRoot });
      const start = () => startTransport({ root, location, logFile: log });
      let transport;
      try { transport = await start(); }
      catch (error) {
        const detail = error instanceof TransportError && error.tail.length ? ` ${lastLine(error.tail.join('\n'))}` : '';
        return await fail({ ok: false, code: 'start-failed', message: `${error.message}${detail} The log has details.`, path: root });
      }
      const { partition, session: ses } = this.#sessionFor(root);
      const current = { root, partition, session: ses, log, crashed: null };
      this.current = current;
      current.supervisor = superviseTransport({
        start,
        transport,
        healthInterval: this.healthInterval,
        log: line => console.log(`[service] ${line}`),
        onState: state => this.#hostState(current, state),
        // The address does not change, so the page keeps working; only the crash screen needs the workspace loaded again.
        onReplaced: next => { this.#follow(current, next); const shown = current.crashed; current.crashed = null; if (shown) void this.#load(current); },
        onFailed: reason => void this.#showCrash(current, reason),
      });
      this.#follow(current, transport);
      await writeDesktopRecord(root, { version: this.version, build: this.build?.build ?? null });
      await rememberWorkspace(this.config, root);
      current.window = new WorkspaceWindow({ session: ses, stateFile: this.windowStateFile });
      await current.window.ready;
      current.window.closed.then(() => this.#windowClosed(current));
      await this.#load(current);
      await lock.release();
      lock = null;
      this.#closePicker();
      await this.#refreshMenu();
      return { ok: true };
    } catch (error) {
      console.error('Could not open the workspace:', error);
      return await fail({ ok: false, code: 'failed', message: `The workspace could not be opened: ${error.message}` });
    } finally {
      await lock?.release().catch(() => {});
      this.opening = false;
      this.switching = false;
    }
  }

  async #load(current) {
    const window = current.window?.window;
    if (!window || window.isDestroyed()) return;
    try { await window.loadURL(`${serviceOrigin}/`); } catch (error) { console.error('Could not load the workspace window:', error.message); }
  }

  /** Send the workspace page (its main frame, and only while it is at app://opendoc) one of the bridge's events. */
  #toPage(current, channel, ...args) {
    const window = current.window?.window;
    if (!window || window.isDestroyed()) return;
    const frame = window.webContents.mainFrame;
    if (originOf(frame.url) !== serviceOrigin) return;
    try { frame.send(channel, ...args); } catch { /* the frame is going away */ }
  }

  /** Forward the service's changes to the page. Called for each host the workspace has, the first and every restart. */
  #follow(current, transport) {
    current.unfollow?.();
    current.unfollow = transport.onChange(() => this.#toPage(current, 'opendoc:changed'));
  }

  /** 'restarting', 'running' or 'failed': the host's state, for the page's short message. */
  #hostState(current, state) {
    if (this.current === current) this.#toPage(current, 'opendoc:host-state', state);
  }

  async #showCrash(current, reason) {
    if (this.current !== current) return;
    current.crashed = reason;
    const window = current.window?.window;
    if (window && !window.isDestroyed()) await window.loadURL(shellPageUrl('crash.html')).catch(() => {});
  }

  /** The user closed the workspace window. The app has one window, so it quits (will-quit stops the service). */
  #windowClosed(current) {
    if (this.current === current && !this.switching) app.quit();
  }

  /** Let go of the open workspace: ask about unsaved edits, close its window, stop its service. False if the user stays. */
  async #leaveCurrent() {
    const current = this.current;
    if (!current) return true;
    this.switching = true;
    if (!(await current.window.requestClose())) { this.switching = false; return false; }
    this.current = null;
    await this.#teardown(current);
    return true;
  }

  async createWorkspace(path) {
    const target = resolve(path);
    if (!existsSync(cliPath(this.runtime))) return { ok: false, code: 'no-runtime', message: 'The OpenDoc runtime that comes with the app was not found, so a new workspace cannot be created.' };
    let result;
    try { result = await runCli(this.runtime, ['init', target, '--no-start', '--json'], { cwd: dirname(target) }); }
    catch (error) { return { ok: false, code: 'init-failed', message: `Creating the workspace failed: ${error.message}` }; }
    if (result.code !== 0) return { ok: false, code: 'init-failed', message: lastLine(result.stderr) || lastLine(result.stdout) || 'Creating the workspace failed.' };
    return this.openWorkspace(target);
  }

  // ---------- windows ----------

  #focus() {
    const window = this.current?.window?.window ?? this.picker;
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  /** Show the workspace picker, optionally with the reason the last open failed. */
  async showPicker(failure) {
    try {
      if (!(await this.#leaveCurrent())) return;
      if (this.picker && !this.picker.isDestroyed()) { this.picker.focus(); return; }
      const window = createPickerWindow(this.#shellSession());
      this.picker = window;
      window.on('closed', () => { this.picker = null; if (!this.current && !this.keepAlive) app.quit(); });
      const query = failure && !failure.ok && !failure.canceled ? { error: failure.message, code: failure.code ?? '', path: failure.path ?? '' } : {};
      await window.loadURL(shellPageUrl('picker.html', query));
      await this.#refreshMenu();
    } finally { this.switching = false; }
  }

  #closePicker() {
    const window = this.picker;
    this.picker = null;
    if (window && !window.isDestroyed()) { window.removeAllListeners('closed'); window.close(); }
  }

  /** The window that dialogs belong to. */
  #parent() { return this.current?.window?.window ?? this.picker ?? undefined; }

  // ---------- menu and its actions ----------

  async #refreshMenu() {
    const { recentWorkspaces } = await this.config.read();
    installMenu({
      actions: {
        open: () => void this.#openFromDialog(),
        create: () => void this.#createFromDialog(),
        openRecent: path => void this.#report(this.openWorkspace(path)),
        reveal: () => { if (this.current) shell.showItemInFolder(this.current.root); },
        showLog: () => this.#showLog(),
        about: () => void showAbout(this.#parent(), this.build),
        installCommand: () => void this.commandLine.installFromMenu(),
        openExternal,
      },
      state: { workspaceOpen: Boolean(this.current), recent: Array.isArray(recentWorkspaces) ? recentWorkspaces.filter(item => typeof item === 'string') : [] },
    });
  }

  #showLog() {
    const log = this.current?.log;
    if (log && existsSync(log)) shell.showItemInFolder(log);
    else void shell.openPath(this.logsDir);
  }

  async #chooseExisting() {
    const choice = await ask('showOpenDialog', this.#parent(), { title: 'Open a workspace', buttonLabel: 'Open', properties: ['openDirectory'] });
    return choice.canceled || !choice.filePaths[0] ? { canceled: true } : { path: choice.filePaths[0] };
  }

  async #chooseNew() {
    const choice = await ask('showOpenDialog', this.#parent(), { title: 'Create a new workspace', message: 'Choose a new or empty folder.', buttonLabel: 'Create here', properties: ['openDirectory', 'createDirectory'] });
    return choice.canceled || !choice.filePaths[0] ? { canceled: true } : { path: choice.filePaths[0] };
  }

  async #openFromDialog() {
    const choice = await this.#chooseExisting();
    if (choice.path) await this.#report(this.openWorkspace(choice.path));
  }

  async #createFromDialog() {
    const choice = await this.#chooseNew();
    if (choice.path) await this.#report(this.createWorkspace(choice.path));
  }

  /** Menu actions have no page to show an error on: say it in a dialog, with the same remedies as the picker. */
  async #report(pending) {
    const result = await pending;
    if (result.ok || result.canceled) return;
    const remedy = { 'stale-lock': 'Clear stale lock', 'service-running': 'Stop it' }[result.code];
    const choice = await ask('showMessageBox', this.#parent(), { type: 'error', title: 'Could not open the workspace', message: result.message, buttons: remedy ? [remedy, 'Close'] : ['Close'], defaultId: 0, cancelId: remedy ? 1 : 0, noLink: true });
    if (remedy && choice.response === 0) {
      const fixed = result.code === 'stale-lock' ? await this.#clearLock(result.path) : await this.#stopService(result.path);
      if (fixed.ok) await this.#report(this.openWorkspace(result.path));
      else await ask('showMessageBox', this.#parent(), { type: 'error', title: 'Could not open the workspace', message: fixed.message, buttons: ['Close'], noLink: true });
    }
  }

  async #clearLock(path) {
    try { await clearStaleWorkspaceLock(path); return { ok: true }; }
    catch (error) { return { ok: false, message: error.message }; }
  }

  async #stopService(path) {
    try {
      const result = await runCli(this.runtime, ['stop'], { cwd: path, timeout: 30_000 });
      if (result.code === 0) return { ok: true };
      return { ok: false, message: lastLine(result.stderr) || lastLine(result.stdout) || 'opendoc stop did not stop it. Close the terminal where it runs.' };
    } catch (error) { return { ok: false, message: error.message }; }
  }

  // ---------- the pages' calls ----------

  #registerIpc() {
    const handle = (channel, run) => ipcMain.handle(`shell:${channel}`, (event, ...args) => {
      // Only the app's own pages, in their top frame, may call the main process.
      if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame || !isShellUrl(event.senderFrame.url)) throw new Error('Not allowed.');
      return run(...args);
    });
    handle('recent', async () => {
      const { recentWorkspaces } = await this.config.read();
      const list = Array.isArray(recentWorkspaces) ? recentWorkspaces.filter(item => typeof item === 'string') : [];
      return Promise.all(list.map(async path => ({ path, name: basename(path), exists: await this.#isWorkspace(path) })));
    });
    handle('open-dialog', () => this.#chooseExisting());
    handle('create-dialog', () => this.#chooseNew());
    handle('open', path => this.openWorkspace(String(path)));
    handle('create', path => this.createWorkspace(String(path)));
    handle('forget', async path => { await forgetWorkspace(this.config, String(path)); await this.#refreshMenu(); return { ok: true, quiet: true }; });
    handle('clear-lock', async path => { const result = await this.#clearLock(String(path)); return result.ok ? this.openWorkspace(String(path)) : result; });
    handle('stop-service', async path => { const result = await this.#stopService(String(path)); return result.ok ? this.openWorkspace(String(path)) : result; });
    handle('show-log', () => { this.#showLog(); return { ok: true }; });
    handle('crash-info', () => ({ workspace: this.current?.root ?? '', reason: this.current?.crashed ?? '' }));
    handle('retry', async () => {
      const current = this.current;
      if (!current) return { ok: false, message: 'No workspace is open.' };
      try {
        await current.supervisor.restart(); // Its replacement loads the workspace again (onReplaced above).
        return { ok: true };
      } catch (error) { return { ok: false, message: `The service did not start again: ${error.message}` }; }
    });
    handle('picker', async () => { await this.showPicker(); return { ok: true }; });
  }

  /** A second launch of the app: show the window that is already open. */
  secondInstance() { this.#focus(); }
}
