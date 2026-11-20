// Stand-in main process for packaging checks: starts, reports its versions and quits. It opens no window.
import { app } from 'electron';

console.log(JSON.stringify({ stub: true, electron: process.versions.electron, packaged: app.isPackaged }));
app.quit();
