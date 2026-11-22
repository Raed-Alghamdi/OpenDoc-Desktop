// Windows: their security settings, the rules every page in them obeys, the guard for unsaved text edits and the
// remembered size and position of the workspace window.
import { BrowserWindow, app, dialog, screen } from 'electron';
import { fileURLToPath } from 'node:url';
import { displayName } from './identity.mjs';
import { classifyNavigation, classifyWindowOpen, originOf } from './policy.mjs';
import { openExternal } from './session-policy.mjs';
import { defaultSize, loadWindowState, minimumSize, restoreBounds, saveWindowState } from './window-state.mjs';

const preload = fileURLToPath(new URL('../preload/shell.cjs', import.meta.url));

export function secureWebPreferences(extra = {}) {
  return {
    preload,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    safeDialogs: true,
    ...extra,
  };
}

/**
 * Rules for every web contents the app creates, windows opened by pages included.
 * `allowedOrigins()` returns the origins the app's pages may navigate to.
 */
export function guardAllContents(allowedOrigins) {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', event => event.preventDefault());

    const navigation = (event, url) => {
      const verdict = classifyNavigation(url, allowedOrigins(), contents.getURL());
      if (verdict === 'allow') return;
      event.preventDefault();
      if (verdict === 'external') openExternal(url);
    };
    // will-frame-navigate covers every frame, the main one included (will-navigate would repeat it for the main frame).
    contents.on('will-frame-navigate', event => navigation(event, event.url));
    contents.on('will-redirect', navigation);

    contents.setWindowOpenHandler(({ url }) => {
      const verdict = classifyWindowOpen(url, originOf(contents.getURL()));
      if (verdict === 'external') openExternal(url);
      if (verdict !== 'file-window') return { action: 'deny' };
      // A file the service serves (an exported PDF, a specimen) opens in a small window with Chromium's viewer.
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { width: 1000, height: 900, parent: BrowserWindow.fromWebContents(contents) ?? undefined, autoHideMenuBar: true, webPreferences: secureWebPreferences({ preload: undefined }) },
      };
    });
  });
}

const leaveOptions = { type: 'question', buttons: ['Leave', 'Stay'], defaultId: 1, cancelId: 1, title: 'Leave OpenDoc?', message: 'You have text edits that are not saved.', detail: 'If you leave now, they are lost.', noLink: true };

/** The Leave/Stay question for unsaved text edits. Resolves true to leave. */
export async function confirmLeave(window) {
  const choice = window && !window.isDestroyed() ? await dialog.showMessageBox(window, leaveOptions) : await dialog.showMessageBox(leaveOptions);
  return choice.response === 0;
}

// The page's own beforeunload prompt needs its answer at once, so this one blocks until the user chooses.
function confirmLeaveNow(window) {
  return dialog.showMessageBoxSync(window, leaveOptions) === 0;
}

const draftsScript = "(() => { try { return Object.keys(sessionStorage).some(key => key.startsWith('opendoc:text-draft:')); } catch { return false; } })()";

/**
 * The window that shows one workspace (and, in the same window, the crash screen).
 * It asks before closing when the page holds unsaved text edits, and it remembers its place.
 */
export class WorkspaceWindow {
  constructor({ session, stateFile }) {
    this.stateFile = stateFile;
    this.approved = false; // The user chose Leave, so the page's own prompt is not asked again.
    this.checked = false; // The next close event has been through the draft check.
    this.asking = null;
    this.closed = new Promise(accept => { this.onClosed = accept; });
    this.ready = this.#create(session);
  }

  async #create(session) {
    const saved = restoreBounds(await loadWindowState(this.stateFile), screen.getAllDisplays().map(display => display.workArea));
    const { maximized, ...bounds } = saved;
    const window = new BrowserWindow({ ...defaultSize, ...bounds, minWidth: minimumSize.width, minHeight: minimumSize.height, show: false, title: displayName, backgroundColor: '#ffffff', webPreferences: secureWebPreferences({ session }) });
    this.window = window;
    if (maximized) window.maximize();
    window.once('ready-to-show', () => window.show());
    window.webContents.on('page-title-updated', (event, title) => { event.preventDefault(); window.setTitle(title && title !== displayName ? `${title} - ${displayName}` : displayName); });
    // Answer the page's own beforeunload prompt (the page registers one only when it could not store a draft):
    // without an answer, Electron ignores close and quit while the page holds one. preventDefault means leave.
    window.webContents.on('will-prevent-unload', event => {
      if (this.approved || confirmLeaveNow(window)) event.preventDefault();
    });
    window.on('close', event => {
      this.#remember();
      if (this.checked) { this.checked = false; return; }
      event.preventDefault();
      void this.requestClose();
    });
    let timer;
    const later = () => { clearTimeout(timer); timer = setTimeout(() => this.#remember(), 400); };
    window.on('resize', later);
    window.on('move', later);
    window.on('closed', () => { clearTimeout(timer); this.onClosed(); });
    return window;
  }

  #remember() {
    const window = this.window;
    if (!window || window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return;
    const { x, y, width, height } = window.getNormalBounds();
    void saveWindowState(this.stateFile, { x, y, width, height, maximized: window.isMaximized() }).catch(() => {});
  }

  async hasUnsavedDrafts() {
    const window = this.window;
    if (!window || window.isDestroyed()) return false;
    try { return await window.webContents.executeJavaScript(draftsScript) === true; } catch { return false; }
  }

  /** Ask if needed, then close the window. Resolves true when the window closed, false when the user stayed. */
  requestClose() {
    if (this.asking) return this.asking;
    const pending = (async () => {
      if (await this.hasUnsavedDrafts()) {
        if (!(await confirmLeave(this.window))) return false;
        this.approved = true;
      }
      if (this.window.isDestroyed()) return true;
      this.checked = true;
      // From here a new close request is a new attempt (the page's own prompt may have been answered with Stay).
      this.asking = null;
      this.window.close();
      // The page's own prompt may still keep the window open.
      return await Promise.race([this.closed.then(() => true), new Promise(accept => setTimeout(accept, 1500, false))]);
    })();
    this.asking = pending;
    // Only the question itself blocks a second request; a refusal clears it too.
    void pending.finally(() => { if (this.asking === pending) this.asking = null; }).catch(() => {});
    return pending;
  }
}

/** The small window for choosing a workspace (also shown when nothing is open). */
export function createPickerWindow(session) {
  const window = new BrowserWindow({ width: 760, height: 660, minWidth: 480, minHeight: 420, show: false, title: displayName, backgroundColor: '#ffffff', webPreferences: secureWebPreferences({ session }) });
  window.once('ready-to-show', () => window.show());
  return window;
}

/**
 * A small window for one of the app's own pages that is not the picker: the upgrade's progress and result, the backups list.
 * It belongs to `parent` when there is one, so it stays in front of it.
 */
export function createShellWindow(session, { width = 640, height = 560, title = displayName, parent } = {}) {
  const window = new BrowserWindow({ width, height, minWidth: 420, minHeight: 300, show: false, title, backgroundColor: '#ffffff', parent: parent && !parent.isDestroyed() ? parent : undefined, webPreferences: secureWebPreferences({ session }) });
  window.setMenuBarVisibility(false);
  window.once('ready-to-show', () => window.show());
  return window;
}
