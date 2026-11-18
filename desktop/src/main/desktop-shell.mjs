// The shell: which workspace is open, its service, its window and the picker. One workspace at a time.
import { app, clipboard, dialog, ipcMain, session, shell } from 'electron';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { realpath, rm, rmdir, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { showAbout } from './about.mjs';
import { CommandLineTool } from './command-line-tool.mjs';
import { createConfig, forgetWorkspace, rememberWorkspace, setUpgradeWithoutAsking, upgradesWithoutAsking } from './config.mjs';
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
import { prepareAppImageRuntime } from './workspace/appimage-runtime.mjs';
import { cleanPartials, deleteBackup, humanBytes, journalName, listBackups, recoverRestore } from './workspace/backup.mjs';
import { prepareWorkspace } from './workspace/prepare.mjs';
import { readOnlySupported, readRuntimeInfo } from './workspace/runtime-info.mjs';
import { WorkspaceWindow, createPickerWindow, createShellWindow, guardAllContents } from './windows.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
// Electron's dialogs take the parent window first, or no window at all.
const ask = (name, parent, options) => parent && !parent.isDestroyed() ? dialog[name](parent, options) : dialog[name](options);
const lastLine = text => String(text).split('\n').map(line => line.trim()).filter(Boolean).at(-1) ?? '';

export class DesktopShell {
  /**
   * @param options.runtime the runtime folder the app carries (resources/runtime)
   * @param options.dataDir where backups and the AppImage's runtime copy go (workspace/paths.mjs)
   * @param options.appImage true when running from an AppImage: the runtime is copied to the data folder at launch
   */
  constructor({ runtime, templatePath, fallbackRoot, dataDir, appImage = false }) {
    const userData = app.getPath('userData');
    this.runtime = runtime;
    this.dataDir = dataDir ?? join(userData, 'data');
    this.appImage = appImage;
    this.modules = join(runtime, 'node_modules'); // what a workspace's node_modules link names
    this.runtimeProblem = null;
    this.shellWindows = new Set(); // the status, result and backups windows
    this.statusState = { title: '', text: '' };
    this.result = null;
    this.fallbackRoot = fallbackRoot; // Development: the repository, when the runtime folder has no service
    this.config = createConfig(join(userData, 'config.json'));
    this.commandLine = new CommandLineTool({ config: this.config, runtime, templatePath, home: app.getPath('home'), parent: () => this.#parent() });
    this.windowStateFile = join(userData, 'window-state.json');
    this.logsDir = join(userData, 'logs');
    this.sessions = new Map();
    this.current = null;
    this.picker = null;
    this.opening = null; // while a workspace is being opened: { abort, lock }, so that quitting can undo it
    this.openTask = null;
    this.stopped = false;
    this.healthInterval = Number(process.env[environment.healthInterval]) || 5000;
  }

  /** True while the app moves between windows, so closing one does not end the app. */
  get keepAlive() { return this.opening || this.switching; }

  // ---------- start and stop ----------

  async start() {
    await this.#prepareRuntime();
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

  /** The AppImage keeps its runtime in a mount that goes away with the app: use a copy in the data folder (workspace/appimage-runtime.mjs). */
  async #prepareRuntime() {
    if (!this.appImage) return;
    try {
      const prepared = await prepareAppImageRuntime({ source: this.runtime, dataDir: this.dataDir });
      this.runtime = prepared.runtime;
      this.modules = prepared.modules;
      if (prepared.copied) console.log(`[runtime] copied to ${prepared.runtime}`);
    } catch (error) {
      this.runtimeProblem = error.message; // Shown when a workspace is opened; the copy is never half-used.
      console.error(`[runtime] ${error.message}`);
    }
  }

  /**
   * Stop the service, remove desktop.json and release the lock. Called from will-quit, once. A workspace that is still
   * opening is cancelled (its host is killed, its lock released) and waited for, for a few seconds at most.
   */
  async shutdown() {
    if (this.stopped) return;
    this.stopped = true;
    const opening = this.opening;
    if (opening) {
      opening.abort.abort();
      await Promise.race([this.openTask?.catch(() => {}), new Promise(accept => setTimeout(accept, 8000))]);
      await opening.lock?.release().catch(() => {}); // Still held when the open was stuck on a question for the user
    }
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

  async #hasPackage(path) {
    try { return (await stat(join(path, 'package.json'))).isFile(); } catch { return false; }
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

  /**
   * Open a workspace. Resolves { ok: true }, { ok: false, canceled: true } or { ok: false, code, message, path }.
   * `created` says this app made the folder moments ago (`opendoc init`), so the node_modules it installed is replaced silently.
   */
  openWorkspace(input, { created = false } = {}) {
    if (this.opening) return Promise.resolve({ ok: false, message: 'Another workspace is opening. Wait a moment.' });
    if (this.stopped) return Promise.resolve({ ok: false, canceled: true });
    const opening = { abort: new AbortController(), lock: null };
    this.opening = opening;
    const task = this.#open(input, opening, created).finally(() => { if (this.opening === opening) this.opening = null; });
    this.openTask = task;
    return task;
  }

  async #open(input, opening, created) {
    const { signal } = opening.abort;
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
      if (!(await this.#isWorkspace(root)) && !(await this.#hasPackage(root))) return { ok: false, code: 'not-a-workspace', message: `${root} is not an OpenDoc workspace. A workspace has a package.json that pins OpenDoc and, on this device, a .opendoc/workspace.json file; create a new one instead.`, path: root };
      if (this.current?.root === root) { this.#focus(); return { ok: true }; }
      if (this.runtimeProblem) return { ok: false, code: 'runtime-unavailable', message: this.runtimeProblem, path: root };
      const runtime = await readRuntimeInfo(this.runtime);
      if (!runtime.ok) return { ok: false, code: 'no-runtime', message: runtime.message, path: root };

      // Check the workspace before letting go of the one that is open.
      const owner = await inspectDesktopRecord(root);
      if (owner.state === 'live') return { ok: false, code: 'open-elsewhere', message: `This workspace is already open in another opendoc-desktop (process ${owner.record.pid}). Close it there first.`, path: root };
      const service = await inspectService(root);
      if (service.state === 'running') return { ok: false, code: 'service-running', message: `OpenDoc is already running for this workspace in a browser (process ${service.pid}, ${service.origin}). Stop it before opening the workspace here.`, path: root };
      if (service.state !== 'none') return { ok: false, code: 'service-unclear', message: service.state === 'finishing' ? 'OpenDoc is still finishing its previous session for this workspace. Wait a moment, then try again.' : service.message, path: root };
      const hadOpendoc = existsSync(join(root, '.opendoc'));
      try { lock = await acquireWorkspaceLock(root); }
      catch (error) {
        if (error instanceof WorkspaceLockError) return { ok: false, code: error.code, message: error.message, path: root };
        throw error;
      }
      opening.lock = lock;
      if (signal.aborted) return { ok: false, canceled: true };

      // Everything that can change the workspace or refuse it, before the open workspace is let go of and before the host starts.
      const prepared = await prepareWorkspace({
        root, runtime, wanted: { path: this.modules }, exact: this.appImage, created,
        readOnlySupport: await readOnlySupported(this.runtime),
        upgradeWithoutAsking: await upgradesWithoutAsking(this.config),
        replaceReal: path => this.#replaceModules(path, created),
        runCli: (args, options) => runCli(this.runtime, args, options),
        ui: this.#workspaceUi(root, opening), dataDir: this.dataDir, signal, log: line => console.log(`[workspace] ${line}`),
      });
      if (!prepared.ok) {
        await lock.release().catch(() => {});
        lock = null;
        if (!hadOpendoc) await rmdir(join(root, '.opendoc')).catch(() => {}); // the lock made it; a folder that was refused keeps none
        return prepared.canceled ? { ok: false, canceled: true } : { ok: false, code: prepared.code, message: prepared.message, path: root };
      }
      if (this.current) {
        left = true;
        if (!(await this.#leaveCurrent())) return { ok: false, canceled: true };
      }
      await clearStaleDesktopRecord(root);

      const log = join(this.logsDir, `workspace-${hash(root).slice(0, 8)}.log`);
      const location = serviceLocation({ runtime: this.runtime, fallbackRoot: this.fallbackRoot });
      // A read-only workspace is passed on to the service; the supervisor starts every replacement host the same way.
      const start = abort => startTransport({ root, location, logFile: log, signal: abort, readOnly: prepared.readOnly ?? undefined });
      let transport;
      try { transport = await start(signal); }
      catch (error) {
        if (signal.aborted) return { ok: false, canceled: true };
        if (error instanceof TransportError && error.code === 'read-only-unsupported') return await fail({ ok: false, code: 'read-only-unsupported', message: `${prepared.readOnly?.message ?? 'This workspace can only be opened read-only.'} The OpenDoc service in this app cannot open a workspace read-only yet, so it was not opened.`, path: root });
        const detail = error instanceof TransportError && error.tail.length ? ` ${lastLine(error.tail.join('\n'))}` : '';
        return await fail({ ok: false, code: 'start-failed', message: `${error.message}${detail} The log has details.`, path: root });
      }
      if (signal.aborted) { await transport.stop(); return { ok: false, canceled: true }; } // The app is quitting
      const { partition, session: ses } = this.#sessionFor(root);
      const current = { root, partition, session: ses, log, crashed: null, readOnly: prepared.readOnly ?? null };
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
      for (const note of prepared.notes) void ask('showMessageBox', this.#parent(), { type: 'info', title: note.title, message: note.message, detail: note.detail, buttons: ['OK'], noLink: true });
      return { ok: true };
    } catch (error) {
      console.error('Could not open the workspace:', error);
      return await fail({ ok: false, code: 'failed', message: `The workspace could not be opened: ${error.message}` });
    } finally {
      await lock?.release().catch(() => {});
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
    if (this.runtimeProblem) return { ok: false, code: 'runtime-unavailable', message: this.runtimeProblem };
    if (!existsSync(cliPath(this.runtime))) return { ok: false, code: 'no-runtime', message: 'The OpenDoc runtime that comes with the app was not found, so a new workspace cannot be created.' };
    let result;
    try { result = await runCli(this.runtime, ['init', target, '--no-start', '--json'], { cwd: dirname(target) }); }
    catch (error) { return { ok: false, code: 'init-failed', message: `Creating the workspace failed: ${error.message}` }; }
    if (result.code !== 0) return { ok: false, code: 'init-failed', message: lastLine(result.stderr) || lastLine(result.stdout) || 'Creating the workspace failed.' };
    return this.openWorkspace(target, { created: true });
  }

  /** A real node_modules goes to the trash, never to oblivion. The one `opendoc init` just made (`created`) is ours and is removed. */
  async #replaceModules(path, created) {
    if (created) { await rm(path, { recursive: true, force: true }); return; }
    try { await shell.trashItem(path); }
    catch (error) { throw new Error(`The node_modules folder could not be moved to the trash (${error.message}), so it was left as it is.`); }
  }

  // ---------- questions and screens while a workspace is prepared ----------

  /** What prepareWorkspace asks and shows: native questions, the progress window and the result screen. */
  #workspaceUi(root, opening) {
    const name = basename(root);
    const parent = () => this.#parent();
    return {
      askAdopt: async () => (await ask('showMessageBox', parent(), {
        type: 'question', title: 'Use this workspace on this device?', message: `Use "${name}" on this device?`,
        detail: `${root}\n\nThis folder is an OpenDoc workspace (its package.json pins OpenDoc) that has not been used with this app on this device. The app will add a small file, .opendoc/workspace.json, and link node_modules to the app's own OpenDoc. Your documents are not changed.`,
        buttons: ['Use this workspace on this device', 'Cancel'], defaultId: 0, cancelId: 1, noLink: true,
      })).response === 0,
      askRealModules: async (_root, kind) => (await ask('showMessageBox', parent(), {
        type: 'warning', title: 'Replace node_modules?', message: `This workspace has its own ${kind === 'file' ? 'file' : 'folder'} named node_modules.`,
        detail: `${join(root, 'node_modules')}\n\nopendoc-desktop runs the workspace with the OpenDoc that comes with the app. To do that it replaces node_modules with a link to it. The ${kind === 'file' ? 'file' : 'folder'} you have now is moved to the trash, not deleted.`,
        buttons: ["Use the app's OpenDoc", 'Leave it as it is'], defaultId: 1, cancelId: 1, noLink: true,
      })).response === 0,
      askRecoveryFailed: async ({ message }) => (await ask('showMessageBox', parent(), {
        type: 'warning', title: 'An interrupted restore could not be undone', message: `"${name}" has a restore that was interrupted, and the app could not undo it.`,
        detail: `${message}\n\nNo file was deleted: the files as they were before that restore are in the safety copy named above. "Open anyway" opens the workspace as it is now (some files may be from the backup) and does not try to undo the restore again. "Cancel" leaves everything as it is so you can try again.`,
        buttons: ['Open anyway', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
      })).response === 0,
      askUpgrade: async ({ from, to, formatFrom, formatTo }) => {
        const formatOnly = from === to && Number.isInteger(formatFrom);
        const answer = await ask('showMessageBox', parent(), {
          type: 'question', title: 'Upgrade this workspace?', message: formatOnly ? `"${name}" uses an older workspace format (${formatFrom}) than this app writes (${formatTo}).` : `"${name}" is on OpenDoc ${from}. This app has OpenDoc ${to}.`,
          detail: 'Upgrading copies the workspace to a backup first, then moves it to the new version and checks every document. Or open it read-only, which changes nothing.',
          buttons: ['Upgrade', 'Open read-only', 'Cancel'], defaultId: 0, cancelId: 2, noLink: true,
          checkboxLabel: 'Upgrade my workspaces without asking from now on', checkboxChecked: false,
        });
        return { choice: ['upgrade', 'readonly', 'cancel'][answer.response] ?? 'cancel', remember: answer.checkboxChecked === true };
      },
      remember: () => setUpgradeWithoutAsking(this.config, true),
      progress: text => this.#progress(text, `Upgrading ${name}`),
      showResult: info => this.#showResult(info, opening.abort.signal),
    };
  }

  /** The progress window of an upgrade: `text` is what is happening; null closes the window. */
  #progress(text, title) {
    if (text === null) {
      const window = this.status;
      this.status = null;
      this.statusDismissed = false;
      if (window && !window.isDestroyed()) window.close();
      return;
    }
    this.statusState = { title, text };
    if (this.status || this.statusDismissed) return;
    const window = createShellWindow(this.#shellSession(), { width: 520, height: 300, title: 'Upgrading the workspace', parent: this.#parent() });
    this.status = window;
    this.#trackShellWindow(window);
    window.on('closed', () => { if (this.status === window) { this.status = null; this.statusDismissed = true; } });
    void window.loadURL(shellPageUrl('status.html')).catch(() => {});
  }

  #trackShellWindow(window) {
    this.shellWindows.add(window);
    window.once('closed', () => this.shellWindows.delete(window));
  }

  /** The result screen of an upgrade that did not pass everywhere. Resolves { action: 'restore' | 'open' | 'close' }. */
  #showResult(info, signal) {
    return new Promise(accept => {
      const window = createShellWindow(this.#shellSession(), { width: 720, height: 700, title: 'Upgrade result', parent: this.#parent() });
      const result = { info, window, accept };
      this.result = result;
      this.#trackShellWindow(window);
      const finish = answer => {
        if (this.result === result) this.result = null;
        signal.removeEventListener('abort', closeNow);
        accept(answer);
      };
      const closeNow = () => { if (!window.isDestroyed()) window.close(); };
      result.finish = finish;
      signal.addEventListener('abort', closeNow, { once: true });
      window.on('closed', () => finish({ action: 'close' }));
      void window.loadURL(shellPageUrl('result.html')).catch(() => {});
    });
  }

  async #showBackups() {
    if (this.backupsWindow && !this.backupsWindow.isDestroyed()) { this.backupsWindow.focus(); return; }
    const window = createShellWindow(this.#shellSession(), { width: 960, height: 560, title: 'Workspace backups', parent: this.#parent() });
    this.backupsWindow = window;
    this.#trackShellWindow(window);
    window.on('closed', () => { if (this.backupsWindow === window) this.backupsWindow = null; });
    await window.loadURL(shellPageUrl('backups.html')).catch(() => {});
  }

  /**
   * A restore that was interrupted leaves a journal in its workspace; undo it for every workspace that is not in use (its
   * lock can be taken), and say what was done. Also removes the unfinished copies a crashed backup left (they are only copies).
   */
  async #recoverLeftovers() {
    const notices = [];
    await cleanPartials(this.dataDir).catch(() => {});
    const seen = new Set();
    for (const { manifest } of await listBackups(this.dataDir)) {
      const source = manifest.source;
      if (manifest.kind !== 'before-restore' || seen.has(source) || !existsSync(join(source, '.opendoc', journalName))) continue;
      seen.add(source);
      let lock;
      try { lock = await acquireWorkspaceLock(source); } catch { continue; } // open somewhere, or being used by a command
      try { const done = await recoverRestore({ root: source }); if (done) notices.push(`${basename(source)}: ${done.message}`); }
      catch (error) { notices.push(`${basename(source)}: ${error.message}`); }
      finally { await lock.release().catch(() => {}); }
    }
    return notices;
  }

  async #backupRows() {
    const notices = await this.#recoverLeftovers();
    const found = await listBackups(this.dataDir);
    const rows = found.map(({ name, directory, manifest }) => ({ name, directory, source: manifest.source, time: manifest.time, from: manifest.from, to: manifest.to, kind: manifest.kind, sizeText: `${humanBytes(manifest.bytes)}, ${manifest.files} files` }));
    return { rows, notices };
  }

  async #deleteBackup(name) {
    const choice = await ask('showMessageBox', this.backupsWindow, {
      type: 'warning', title: 'Delete this backup?', message: `Move the backup ${name} to the trash?`,
      detail: 'It is the copy the app made before an upgrade. Once the trash is emptied it cannot be brought back.',
      buttons: ['Move to trash', 'Cancel'], defaultId: 1, cancelId: 1, noLink: true,
    });
    if (choice.response !== 0) return { ok: true };
    try { await deleteBackup({ dataDir: this.dataDir, name: String(name), trash: path => shell.trashItem(path) }); return { ok: true }; }
    catch (error) { return { ok: false, message: error.message }; }
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
        backups: () => void this.#showBackups(),
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
    const remedy = { 'stale-lock': 'Clear stale lock', 'service-running': 'Stop it', 'read-only-unsupported': 'Back to workspaces' }[result.code];
    const choice = await ask('showMessageBox', this.#parent(), { type: 'error', title: 'Could not open the workspace', message: result.message, buttons: remedy ? [remedy, 'Close'] : ['Close'], defaultId: 0, cancelId: remedy ? 1 : 0, noLink: true });
    if (remedy && choice.response === 0 && result.code === 'read-only-unsupported') { await this.showPicker(); return; }
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
      // The page must also be in one of the app's own windows (the picker, or the workspace window showing the crash screen).
      const windows = [this.picker, this.current?.window?.window, ...this.shellWindows].filter(window => window && !window.isDestroyed());
      if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame || !isShellUrl(event.senderFrame.url) || !windows.some(window => window.webContents === event.sender)) throw new Error('Not allowed.');
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
    handle('status-info', () => this.statusState);
    handle('result-info', () => this.result ? { ...this.result.info, prompt: undefined } : { failures: [], to: '', backup: null, canOpen: false });
    handle('result-action', action => {
      if (!this.result || !['restore', 'open', 'close'].includes(action)) return { ok: false, message: 'There is nothing to answer.' };
      const { finish, window } = this.result;
      finish({ action });
      if (!window.isDestroyed()) window.close();
      return { ok: true, quiet: true };
    });
    handle('copy-prompt', () => {
      if (!this.result?.info.prompt) return { ok: false, message: 'There is nothing to copy.' };
      clipboard.writeText(this.result.info.prompt);
      return { ok: true };
    });
    handle('backups', () => this.#backupRows());
    handle('backup-reveal', async name => {
      const found = (await listBackups(this.dataDir)).find(item => item.name === String(name));
      if (!found) return { ok: false, message: 'That backup is not there any more.' };
      shell.showItemInFolder(found.directory);
      return { ok: true };
    });
    handle('backup-delete', name => this.#deleteBackup(name));
  }

  /** A second launch of the app: show the window that is already open. */
  secondInstance() { this.#focus(); }
}
