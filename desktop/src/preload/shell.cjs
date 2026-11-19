// Preload for every app window. It gives the app's own pages (app://shell) a small set of calls to the main
// process, and gives the OpenDoc workspace page (app://opendoc, its top frame only) two ways to hear from the
// shell: the service's changes and the service host's state. It sends nothing back. The main process checks the
// caller's address again on every call, and sends the two events to that frame only while it is at app://opendoc.
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
  contextBridge.exposeInMainWorld('opendocDesktop', {
    onChange: subscribe('opendoc:changed', listener => listener()),
    onHostState: subscribe('opendoc:host-state', (listener, state) => listener({ state: String(state) })),
  });
}
