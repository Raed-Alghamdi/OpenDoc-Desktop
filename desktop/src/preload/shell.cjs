// Preload for every app window. It gives the app's own pages (app://shell) a small set of calls to the main
// process, and gives the OpenDoc workspace pages nothing at all. The main process checks the caller's address
// again on every call.
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
  });
}
