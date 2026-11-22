// The `opendoc` command for agents, as the app sees it. The file work is in cli-shim.mjs.
//   AppImage (Linux, started through its AppImage): at every launch the command in ~/.local/bin is written or pointed
//   at this AppImage, and the user is told once if ~/.local/bin is not on their PATH.
//   macOS: the menu item "Install Command-Line Tool" installs it; at launch an installed command is kept current.
//   Linux packages: nothing to do here, /usr/bin/opendoc comes with the package.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { commandOnPath, commandName, installAppImageShim, installMacCommand, pathNotice, refreshMacCommand, userBinDirectory } from './cli-shim.mjs';

export class CommandLineTool {
  /**
   * @param options.config the app's config.json handle (createConfig)
   * @param options.runtime the runtime folder (node_modules/opendoc inside)
   * @param options.templatePath resources/cli/opendoc-appimage.sh
   * @param options.parent () => the window dialogs belong to, or undefined
   * Everything else is for tests: home, env, platform, executable, macCandidates, show(options).
   */
  constructor({ config, runtime, templatePath, parent = () => undefined, home, env = process.env, platform = process.platform, executable = process.execPath, macCandidates, show, log = line => console.log(`[command] ${line}`) }) {
    Object.assign(this, { config, runtime, templatePath, parent, home, env, platform, executable, macCandidates, log });
    this.show = show ?? (async options => {
      const { dialog } = await import('electron'); // not at the top, so the file loads in plain Node for the unit tests
      const window = parent();
      return window && !window.isDestroyed() ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
    });
  }

  /** Called once the app is up. Never throws: a problem with the command must not stop the app. */
  async launch() {
    try {
      if (this.platform === 'linux' && this.env.APPIMAGE) return await this.#appImage();
      if (this.platform === 'darwin') return await refreshMacCommand({ executable: this.executable, runtime: this.runtime, home: this.home, candidates: this.macCandidates });
    } catch (error) {
      this.log(`could not set up the command: ${error.message}`);
    }
    return { action: 'none' };
  }

  async #appImage() {
    const appImage = this.env.APPIMAGE;
    if (!existsSync(appImage)) return { action: 'none' };
    const result = await installAppImageShim({ template: await readFile(this.templatePath, 'utf8'), appImage, home: this.home });
    this.log(`${commandName}: ${result.action}${result.repointed ? ' (the AppImage moved)' : ''} at ${result.path}`);
    if (result.action === 'foreign') {
      await this.#noticeOnce('foreign', {
        message: `${result.path} already exists, so the opendoc command was not installed.`,
        detail: 'It is not the OpenDoc Desktop command, so it was left alone. Remove or rename it and start the app again; agents need an "opendoc" command to work with your documents.',
      });
    } else {
      await this.#checkPath(userBinDirectory(this.home));
    }
    return result;
  }

  /** Tell the user once when the command's folder is not on their PATH. */
  async #checkPath(directory) {
    const flags = (await this.config.read()).commandLineNotices ?? {};
    if (flags.path) return;
    const answer = await commandOnPath({ directory, env: this.env });
    if (answer.onPath || !answer.checked) return;
    await this.#noticeOnce('path', pathNotice({ directory, home: this.home, shell: answer.shell }));
  }

  async #noticeOnce(name, { message, detail }) {
    const flags = (await this.config.read()).commandLineNotices ?? {};
    if (flags[name]) return;
    // Recorded before the dialog opens: it is shown once even if the app is closed while it is up.
    await this.config.update(current => ({ ...current, commandLineNotices: { ...(current.commandLineNotices ?? {}), [name]: true } }));
    await this.show({ type: 'info', title: 'The opendoc command', message, detail, buttons: ['OK'], noLink: true });
  }

  /** The macOS menu item. Always answers with a dialog. */
  async installFromMenu() {
    if (this.platform !== 'darwin') return { ok: false, reason: 'not-macos' };
    let result;
    try { result = await installMacCommand({ executable: this.executable, runtime: this.runtime, home: this.home, candidates: this.macCandidates }); }
    catch (error) { result = { ok: false, reason: 'failed', message: `Installing the command failed: ${error.message}` }; }
    if (!result.ok) {
      await this.show({ type: 'error', title: 'Install Command-Line Tool', message: 'The opendoc command was not installed.', detail: result.message, buttons: ['OK'], noLink: true });
      return result;
    }
    const answer = await commandOnPath({ directory: result.folder, env: this.env });
    const notice = !answer.onPath && answer.checked ? pathNotice({ directory: result.folder, home: this.home, shell: answer.shell }) : null;
    await this.show({
      type: 'info',
      title: 'Install Command-Line Tool',
      message: `The opendoc command is ${result.action === 'unchanged' ? 'already installed' : 'installed'} at ${result.path}.`,
      detail: notice ? `${notice.message}\n\n${notice.detail}` : 'Agents and terminals can run "opendoc" now. Open a new terminal window if one was already open.',
      buttons: ['OK'],
      noLink: true,
    });
    return result;
  }
}

/** Where the AppImage launcher template is: the app's resources when packaged, the source tree in development. */
export function appImageTemplatePath({ packaged, resourcesPath, developmentRoot }) {
  return packaged ? join(resourcesPath, 'cli', 'opendoc-appimage.sh') : join(developmentRoot, 'resources', 'cli', 'opendoc-appimage.sh');
}
