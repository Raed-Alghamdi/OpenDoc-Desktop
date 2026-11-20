// Preload for every app window. It gives the app's own pages (app://shell) a small set of calls to the main
// process, and gives the OpenDoc workspace page (app://opendoc, its top frame only) three ways to hear from the
// shell: the service's changes, the service host's state and a design pack the user opened outside the page; plus one
// call, showInFolder, for a pack the page saved. The main process checks the caller's address again on every call, and
// sends the events to that frame only while it is at app://opendoc.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'app:' && location.host === 'shell') {
  const call = channel => (...args) => ipcRenderer.invoke(`shell:${channel}`, ...args);
  contextBridge.exposeInMainWorld('opendocShell', {
    recent: call('recent'),
    openDialog: call('open-dialog'),
    createDialog: call('create-dialog'),
    open: call('open'),
    create: call('create'),
    forget: call('forget'),
    clearLock: call('clear-lock'),
    stopService: call('stop-service'),
    showLog: call('show-log'),
    retry: call('retry'),
    picker: call('picker'),
    crashInfo: call('crash-info'),
    statusInfo: call('status-info'),
    resultInfo: call('result-info'),
    resultAction: call('result-action'),
    copyPrompt: call('copy-prompt'),
    backups: call('backups'),
    revealBackup: call('backup-reveal'),
    deleteBackup: call('backup-delete'),
    pendingPack: call('pending-pack'),
    aiAppsInfo: call('ai-apps-info'),
    aiAppsConnect: call('ai-apps-connect'),
    aiAppsDisconnect: call('ai-apps-disconnect'),
    aiAppsClose: call('ai-apps-close'),
  });
}

if (location.protocol === 'app:' && location.host === 'opendoc' && window.top === window) {
  // Each returns the function that stops listening. The listener is called with no arguments (change) or { state }.
  const subscribe = (channel, deliver) => listener => {
    if (typeof listener !== 'function') throw new TypeError('A listener must be a function.');
    const handler = (_event, value) => deliver(listener, value);
    ipcRenderer.on(channel, handler);
    return () => { ipcRenderer.removeListener(channel, handler); };
  };

  // A pack can arrive before the page has a listener (the page subscribes once it has started): the newest one waits here, and goes
  // to the first listener that subscribes. A pack that arrives while someone listens goes to every listener.
  const packListeners = new Set();
  let waitingPack = null;
  const validPack = file => file && typeof file.name === 'string' && file.bytes instanceof Uint8Array;
  ipcRenderer.on('opendoc:import-pack', (_event, file) => {
    if (!validPack(file)) return;
    if (packListeners.size === 0) { waitingPack = file; return; }
    for (const listener of [...packListeners]) listener({ name: file.name, bytes: file.bytes });
  });
  const onImportPack = listener => {
    if (typeof listener !== 'function') throw new TypeError('A listener must be a function.');
    packListeners.add(listener);
    if (waitingPack) {
      const file = waitingPack;
      waitingPack = null;
      queueMicrotask(() => { if (packListeners.has(listener)) listener({ name: file.name, bytes: file.bytes }); else waitingPack = file; });
    }
    return () => { packListeners.delete(listener); };
  };
  // The main process refuses any path that is not a file inside the open workspace's output/packs. A refusal is not an error for the page.
  const showInFolder = path => ipcRenderer.invoke('opendoc:show-in-folder', String(path)).then(() => undefined, () => undefined);

  contextBridge.exposeInMainWorld('opendocDesktop', {
    onChange: subscribe('opendoc:changed', listener => listener()),
    onHostState: subscribe('opendoc:host-state', (listener, state) => listener({ state: String(state) })),
    onImportPack,
    showInFolder,
  });
}
