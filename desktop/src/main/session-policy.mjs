// Hardening applied to every Electron session the app's windows use (the shell's own, and one per workspace).
import { BrowserWindow, app, dialog, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { copyFile, rename, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { contentSecurityPolicy, crossOriginMutation, isWebLink, permissionAllowed, requestAllowed, revealRequest } from './policy.mjs';
import { serveShell } from './shell-pages.mjs';
import { shellHost, shellScheme } from './identity.mjs';

export function openExternal(url) {
  if (!isWebLink(url)) return;
  shell.openExternal(url).catch(error => console.error('Could not open a link:', error.message));
}

/** A file name from the server is a name, never a path. */
export function safeFileName(name) {
  const cleaned = basename(String(name || 'download')).replace(/[\u0000-\u001f<>:"|?*\\/]/g, '_').trim();
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'download';
}

/**
 * Downloads end in a save dialog. The file arrives in a temporary place first, then the dialog asks where it goes,
 * and a cancelled dialog throws it away. (Electron's own dialog cannot be answered by a test; this one can.)
 */
export function handleDownload(item, contents) {
  const name = safeFileName(item.getFilename());
  const temporary = join(app.getPath('temp'), `opendoc-download-${randomUUID()}`);
  item.setSavePath(temporary);
  // A link that opens a file in a new window (target="_blank") becomes a download for a type the viewer cannot show,
  // such as a PowerPoint file: that window has nothing to show, so it closes once the download is dealt with.
  const opened = contents && !contents.isDestroyed() ? BrowserWindow.fromWebContents(contents) : null;
  const blank = opened?.getParentWindow() && ['', 'about:blank'].includes(contents.getURL()) ? opened : null;
  item.once('done', async (_event, state) => {
    try {
      if (state !== 'completed') return;
      const parent = blank?.getParentWindow() ?? opened;
      const options = { title: 'Save a copy', defaultPath: join(app.getPath('downloads'), name) };
      const choice = parent && !parent.isDestroyed() ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options);
      if (choice.canceled || !choice.filePath) return;
      await rename(temporary, choice.filePath).catch(() => copyFile(temporary, choice.filePath));
    } catch (error) {
      console.error('Could not save the download:', error.message);
    } finally {
      await rm(temporary, { force: true });
      if (blank && !blank.isDestroyed()) blank.close();
    }
  });
}

/**
 * Call once for each session. `ses` is an Electron Session.
 * @param workspace what the session serves, read each time so a restarted service can move to a new address:
 *   { origins(): string[], transport(): the current transport or null, revealPath(id): Promise<string | null> }
 */
export function applySessionPolicy(ses, workspace) {
  ses.setSpellCheckerEnabled(false); // The spell checker downloads dictionaries from the network.
  ses.setPermissionRequestHandler((_contents, permission, callback, details) => callback(permissionAllowed(permission) && workspace.origins().some(origin => details.requestingUrl.startsWith(origin))));
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin) => permissionAllowed(permission) && workspace.origins().includes(requestingOrigin));
  ses.setDevicePermissionHandler(() => false);
  // Cancelled: other addresses, and changes to the service that the app's own page did not make.
  ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !requestAllowed(details.url, workspace.origins()) || crossOriginMutation(details, workspace.origins()) }));
  ses.on('will-download', (_event, item, contents) => handleDownload(item, contents));

  // The page talks to the service only through the main process: it adds the content security policy, and it
  // answers "Show in folder" itself (the service host must never start user programs; its environment is not theirs).
  const forward = async request => {
    const transport = workspace.transport();
    // Only the service's own address is answered (any other host gets 403), and nothing is sent to a transport that was closed.
    if (!transport || new URL(request.url).origin !== transport.origin) return new Response('Not found.', { status: 403 });
    if (!transport.running) return new Response('The OpenDoc service is not running.', { status: 503 });
    const id = revealRequest(request, transport.origin);
    if (id) {
      const path = await workspace.revealPath(id);
      if (!path) return Response.json({ error: 'This exported file is no longer available.' }, { status: 404 });
      shell.showItemInFolder(path);
      return Response.json({ ok: true });
    }
    let response;
    try { response = await transport.handle(request); }
    catch (error) {
      console.error('The service failed to answer:', error?.message ?? error);
      return new Response('The OpenDoc service failed to answer.', { status: 500 });
    }
    const headers = new Headers(response.headers);
    headers.set('Content-Security-Policy', contentSecurityPolicy(transport.origin));
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };
  // One handler per scheme the app's windows use: app:// carries the shell's own pages (and, after U3, the service),
  // http:// carries the temporary adapter's service. Any other address on either scheme is refused.
  const dispatch = request => {
    const url = new URL(request.url);
    return url.protocol === `${shellScheme}:` && url.host === shellHost ? serveShell(request) : forward(request);
  };
  ses.protocol.handle(shellScheme, dispatch);
  ses.protocol.handle('http', dispatch);
}
