// The updater as the app uses it: which install this is, when it checks, what the user is told and offered, and what
// happens at quit. No Electron import: the shell hands in the config handle, the dialog, the updater factory and the app calls, so
// the unit tests drive it with fakes. electron-updater itself is built by classes.mjs (see electron.mjs).
//
//   managed (AUR) and inactive installs     no updater object, no network
//   switched off in the app                 no updater object, no network, no timer
//   AppImage                                downloads in the background, swaps the file at quit, no prompt
//   deb, rpm, pacman                        downloads in the background, then "Restart to Update" (the system password)
//   macOS                                   downloads and checks, then "Restart to Update" runs the app's own swap, or a notice
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseBuild } from './build-compare.mjs';
import { feedLabel, feedProviderOptions, isBuiltInFeed, parseFeedAddress, releasePageUrl, releaseRepository, repositoryFromUpdateConfig } from './feed.mjs';
import { detectInstallType, needsRestartClick } from './install-type.mjs';
import { manualCommand } from './privileged-install.mjs';
import { describeRun, launchOutcome } from './release-notes.mjs';
import { createSchedule } from './schedule.mjs';

const title = 'opendoc-desktop updates';
const describeInfo = info => `${info.version}${parseBuild(info.build) === null ? '' : `, build ${parseBuild(info.build)}`}`;
const firstLine = error => String(error?.message ?? error).split('\n')[0].slice(0, 300);

export class UpdateController {
  /**
   * @param options.config the app's config.json handle (createConfig)
   * @param options.packaged true for a packaged app, or when a test switch names a resources folder
   * @param options.resourcesDir process.resourcesPath, or the test switch's folder; null for a development run
   * @param options.getVersion () => the app's version
   * @param options.getBuild () => the running build number, or null when there is none (a development run)
   * @param options.allowLoopbackFeed true for an unpackaged run or a test build: a plain-http loopback `updateFeed` is accepted (never in an installed app)
   * @param options.createUpdater (type, { feed, logger, feedLabel }) => an electron-updater instance (classes.mjs); null for none
   * @param options.show (options) => Promise<{ response }>, Electron's showMessageBox
   * @param options.openExternal (url) => void, opens the system browser
   * @param options.relaunch, quit: the app's relaunch and quit
   * @param options.onChange called when the menu must be rebuilt
   * @param options.onAppImageMoved async (newPath): the AppImage got a new file name, so the opendoc command must follow it
   * @param options.helperLogs async () => lines the macOS swap helper left from the last run (and removes them)
   * Everything else is for tests: platform, env, readText(path), createSchedule.
   */
  constructor({ config, packaged, allowLoopbackFeed = false, resourcesDir, getVersion, getBuild, createUpdater, show, openExternal, relaunch = () => {}, quit = () => {}, onChange = () => {}, onAppImageMoved = async () => {}, helperLogs = async () => [], log = () => {}, platform = process.platform, env = process.env, readText = path => readFileSync(path, 'utf8'), scheduleFactory = createSchedule }) {
    Object.assign(this, { config, packaged, allowLoopbackFeed, resourcesDir, getVersion, getBuild, createUpdater, show, openExternal, relaunch, quit, onChange, onAppImageMoved, helperLogs, log, platform, env, readText });
    this.schedule = scheduleFactory({ run: () => this.check({ manual: false }), log });
    this.kind = { type: 'inactive', active: false, reason: 'not started' };
    this.base = this.kind; // the install type with the user's switch left out: what a manual check works with
    this.generation = 0; // raised when the switch goes off: a check that started before it neither downloads nor speaks
    this.checkIsManual = false;
    this.checkingGeneration = 0;
    this.automatic = true;
    this.updater = null;
    this.updaterType = null;
    this.feedError = null;
    this.feedLabel = null; // names the feed to the user when it is not the built-in address
    this.repository = releaseRepository();
    this.blocked = null;
    this.ready = null;
    this.installing = false;
    this.checking = null;
    this.cancellation = null;
    this.renamedTo = null;
    this.swapping = false;
    this.hooks = new Set();
    this.background = new Set();
    this.noticed = new Set();
  }

  // ---------- what the menu shows ----------

  /**
   * { show, automatic, checkEnabled, restartReady }: the menu's update items (menu-template.mjs). The switch governs the automatic
   * checks only: "Check for Updates…" works whenever this install can update itself (managed and inactive installs show no items).
   */
  get menuState() {
    return {
      show: this.base.active,
      automatic: this.automatic,
      checkEnabled: this.base.active && !this.installing,
      restartReady: Boolean(this.ready) && needsRestartClick(this.updaterType) && this.updater?.installDownloaded != null && !this.installing,
      installing: this.installing,
    };
  }

  #changed() { try { this.onChange(); } catch (error) { this.log(`the menu could not be refreshed: ${error.message}`); } }

  // ---------- start ----------

  /** Called once the app is up. Never throws, and never waits for a dialog. */
  async start() {
    try {
      await this.#announceRun();
      await this.#swapNotice();
      await this.#helperNotes();
      await this.refresh();
      await this.#launchNotices();
    } catch (error) {
      this.log(`the updater could not start: ${error.message}`);
    }
  }

  /** Register a function to call once, at the first launch of a build newer than the last one that ran ({ previous, current }). */
  onUpdated(callback) {
    this.hooks.add(callback);
    return () => this.hooks.delete(callback);
  }

  /** Resolves when every dialog and hook started in the background has finished (for tests). */
  async idle() {
    while (this.background.size) await Promise.allSettled([...this.background]);
  }

  #track(promise) {
    const tracked = promise.catch(error => this.log(`a background step failed: ${error?.message ?? error}`)).finally(() => this.background.delete(tracked));
    this.background.add(tracked);
    return tracked;
  }

  /** Record this run, tell the hooks, and show what changed, once (never for a first run or a development run). */
  async #announceRun() {
    const current = { version: this.getVersion(), build: this.getBuild() };
    const stored = (await this.config.read()).lastRun;
    const outcome = launchOutcome({ last: stored, current });
    if (outcome.kind === 'unknown') return;
    if (outcome.kind !== 'same') await this.config.update(value => ({ ...value, lastRun: outcome.current })); // before any dialog: shown once even if the app is closed while it is up
    if (outcome.kind !== 'updated') return;
    this.log(`updated from ${describeRun(outcome.previous)} to ${describeRun(outcome.current)}`);
    for (const hook of this.hooks) {
      try { await hook({ previous: outcome.previous, current: outcome.current }); }
      catch (error) { this.log(`an update hook failed: ${error?.message ?? error}`); }
    }
    this.#track(this.#showWhatChanged(outcome));
  }

  async #showWhatChanged({ previous, current }) {
    const repository = await this.#repository();
    const answer = await this.show({
      type: 'info',
      title,
      message: `opendoc-desktop was updated to ${current.version}, build ${current.build}`,
      detail: `Before: ${describeRun(previous)}.`,
      buttons: ['OK', 'What Changed'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (answer.response === 1) this.openExternal(releasePageUrl(repository, current.version, current.build));
  }

  // ---------- the install type, the address, the updater ----------

  async #repository() {
    const config = await this.config.read();
    let feed = null;
    const parsed = typeof config.updateFeed === 'string' ? parseFeedAddress(config.updateFeed, { allowLoopback: this.allowLoopbackFeed }) : null;
    if (parsed?.ok) feed = parsed.url;
    return releaseRepository({ feed, packaged: this.#packagedRepository() });
  }

  /** The GitHub repository the packaged app updates from (resources/app-update.yml), or null. */
  #packagedRepository() {
    if (!this.resourcesDir) return null;
    try { return repositoryFromUpdateConfig(this.readText(join(this.resourcesDir, 'app-update.yml'))); } catch { return null; /* none: the fork's releases */ }
  }

  /** Work out the install type again and bring the updater, the timer and the menu in line with it. */
  async refresh() {
    const config = await this.config.read();
    this.automatic = config.checkForUpdates !== false;
    const detect = options => detectInstallType({ packaged: this.packaged, resourcesDir: this.resourcesDir, config: options, platform: this.platform, env: this.env });
    this.base = detect({ ...config, checkForUpdates: undefined });
    this.kind = this.automatic || !this.base.active ? this.base : detect(config);
    if (!this.automatic || !this.base.active) {
      // Nothing automatic from here on: the timer stops, a check that is still fetching or downloading is dropped (it must not download
      // or open a dialog after the user switched off), and electron-updater's own swap at quit is off.
      this.generation++;
      this.schedule.stop();
      this.cancellation?.cancel?.();
      if (this.updater) this.updater.autoInstallOnAppQuit = false;
      this.log(`no automatic update checks: ${this.kind.reason ?? this.kind.type}`);
      this.#changed();
      return;
    }
    this.repository = await this.#repository();
    await this.#ensureUpdater(config);
    if (this.updater) this.updater.autoInstallOnAppQuit = this.base.type === 'appimage';
    this.#changed();
    this.schedule.start();
  }

  async #ensureUpdater(config) {
    this.feedError = null;
    this.feedLabel = null;
    let feed = null;
    if (config.updateFeed !== undefined && config.updateFeed !== null) {
      const parsed = parseFeedAddress(config.updateFeed, { allowLoopback: this.allowLoopbackFeed });
      if (!parsed.ok) {
        this.feedError = parsed.message;
        this.log(`refused the update address: ${parsed.message}`);
        this.updater = null;
        this.updaterType = null;
        return;
      }
      feed = feedProviderOptions(parsed.url, this.repository);
      this.log(`the update address is ${parsed.url.origin}${parsed.url.pathname} (from config.json)`);
      // The prompts name the feed when it is not the address the app was built with: it came from config.json, not from the release.
      if (!isBuiltInFeed(feed, this.#packagedRepository() ?? releaseRepository())) this.feedLabel = feedLabel(feed);
    }
    if (this.updater && this.updaterType === this.base.type && JSON.stringify(this.feed) === JSON.stringify(feed) && this.createdLabel === this.feedLabel) return;
    this.createdLabel = this.feedLabel;
    this.feed = feed;
    const logger = { info: message => this.log(String(message)), warn: message => this.log(`warning: ${message}`), error: message => this.log(`error: ${message}`), debug: () => {} };
    const updater = this.createUpdater(this.base.type, { feed, logger, feedLabel: this.feedLabel });
    this.updater = updater;
    this.updaterType = this.base.type;
    if (!updater) return;
    updater.autoRunAppAfterInstall = true;
    updater.autoInstallOnAppQuit = this.automatic && this.base.type === 'appimage'; // electron-updater's default is on; the swap at quit is ours (installOnQuit)
    updater.on('appimage-filename-updated', path => {
      this.log(`the AppImage is now ${path}`);
      this.renamedTo = path;
      // installOnQuit() waits for the command to follow. Only electron-updater's own quit handler (the fallback) gets here without it,
      // and the process may end before this finishes; the next launch repoints the command then.
      if (!this.swapping) void Promise.resolve().then(() => this.onAppImageMoved(path)).catch(error => this.log(`the opendoc command could not follow the AppImage: ${error.message}`));
    });
    let lastTenth = -1;
    updater.on('download-progress', progress => {
      const tenth = Math.floor(progress.percent / 10);
      if (tenth !== lastTenth) { lastTenth = tenth; this.log(`downloading: ${Math.round(progress.percent)}% (${progress.transferred} of ${progress.total} bytes)`); }
    });
    updater.on('update-available', info => this.log(`found ${describeInfo(info)}`));
    updater.on('update-not-available', () => this.log('no newer build'));
    updater.on('update-downloaded', info => this.log(`downloaded ${describeInfo(info)}`));
    updater.on('error', error => {
      this.log(`error: ${firstLine(error)}`);
      if (this.swapping) this.swapError = firstLine(error);
    });
  }

  // ---------- the user's switch ----------

  /** The app's "Check for Updates Automatically" switch. Off takes effect at once: the timer is cancelled and nothing more is asked. */
  async setAutomatic(enabled) {
    await this.config.update({ checkForUpdates: Boolean(enabled) });
    this.log(`automatic checks ${enabled ? 'on' : 'off'}`);
    await this.refresh();
  }

  // ---------- checking ----------

  /** The menu's "Check for Updates…": checks now and says what it found. */
  async checkNow() { return this.check({ manual: true }); }

  /**
   * One check. A check that is already running (the timer fired during a download, a second click) is joined, not repeated.
   * Resolves { status: 'up-to-date' | 'available' | 'downloaded' | 'error' | 'none', info?, error? }.
   */
  async check({ manual }) {
    if (!this.base.active) {
      if (manual) await this.#say('info', 'Updates are not available', this.base.reason ? `This copy of opendoc-desktop does not update itself: ${this.base.reason}.` : 'This copy of opendoc-desktop does not update itself.');
      return { status: 'none' };
    }
    if (!manual && !this.automatic) return { status: 'none' }; // the switch is off: only the user's own click checks
    if (!this.updater) await this.#ensureUpdater(await this.config.read()); // with the switch off the updater is made at the first manual check
    if (!this.updater) {
      if (manual && this.feedError) await this.#say('error', 'Could not check for updates', this.feedError);
      return { status: 'none' };
    }
    while (this.checking && this.checkingGeneration !== this.generation) await this.checking; // one dropped by the switch is not joined
    if (!this.checking) {
      this.checkIsManual = manual;
      this.checkingGeneration = this.generation;
      this.checking = this.#runCheck().finally(() => { this.checking = null; });
    } else if (manual) this.checkIsManual = true; // a click that joins a background check wants its answer
    const mine = this.generation;
    const result = await this.checking;
    if (mine !== this.generation) return { status: 'none' }; // switched off meanwhile: nothing is said
    await this.#report(result, manual);
    return result;
  }

  async #runCheck() {
    const updater = this.updater;
    const generation = this.generation;
    const dropped = () => generation !== this.generation;
    this.blocked = null;
    try {
      const preflight = await updater.preflight();
      if (!preflight.ok) this.blocked = preflight;
      // The check runs with autoDownload off: the download starts only after the metadata has come back and nobody switched off meanwhile.
      updater.autoDownload = false;
      const result = await updater.checkForUpdates();
      if (dropped()) return { status: 'up-to-date' };
      if (!result?.isUpdateAvailable) { await this.#clearDownloaded('nothing newer is left'); return { status: 'up-to-date' }; }
      this.cancellation = result.cancellationToken ?? null;
      const info = result.updateInfo;
      if (!preflight.ok) return { status: 'available', info };
      // electron-updater removes the older downloaded file when a newer one starts to download, so a "ready" update must not outlive that.
      if (this.ready) { this.ready = null; this.#changed(); }
      await updater.downloadUpdate(this.cancellation ?? undefined);
      if (dropped()) return { status: 'up-to-date' };
      this.ready = { info, manual: this.checkIsManual };
      this.#changed();
      return { status: 'downloaded', info };
    } catch (error) {
      if (error?.constructor?.name === 'CancellationError' || /^cancell?ed$/i.test(String(error?.message ?? ''))) return { status: 'up-to-date' }; // switched off during a download
      if (dropped()) return { status: 'up-to-date' };
      this.log(`the check failed: ${firstLine(error)}`);
      return { status: 'error', error };
    } finally {
      this.cancellation = null;
    }
  }

  /** What the user is told. A background check says nothing unless there is something to do. */
  async #report(result, manual) {
    const installsOnQuit = this.updaterType === 'appimage';
    switch (result.status) {
      case 'downloaded':
        if (installsOnQuit) {
          if (manual) await this.#say('info', 'An update is ready', `${describeInfo(result.info)} has been downloaded. It is installed when you quit opendoc-desktop, and the next start runs it.${this.#feedNote()}`);
        } else await this.#offerRestart(result.info);
        break;
      case 'available': {
        const key = `${describeInfo(result.info)}`;
        if (!manual && (this.updaterType === 'appimage' || this.noticed.has(key))) break; // the launch notice already told the AppImage user
        this.noticed.add(key);
        await this.#offerDownloadPage(result.info, this.blocked?.message ?? 'This update was not downloaded.');
        break;
      }
      case 'up-to-date':
        if (manual) await this.#say('info', 'opendoc-desktop is up to date', `You have the newest version: ${describeRun({ version: this.getVersion(), build: this.getBuild() ?? 'development' })}.`);
        break;
      case 'error':
        if (manual) await this.#say('error', 'Could not check for updates', firstLine(result.error));
        break;
      default:
    }
  }

  async #say(type, message, detail) {
    return this.show({ type, title, message, detail, buttons: ['OK'], defaultId: 0, cancelId: 0, noLink: true });
  }

  async #offerDownloadPage(info, reason) {
    const answer = await this.show({
      type: 'info',
      title,
      message: `A new version is available: ${describeInfo(info)}`,
      detail: reason,
      buttons: ['Open the Release Page', 'Not Now'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (answer.response === 0) this.openExternal(releasePageUrl(this.repository, info.version, parseBuild(info.build) ?? 1));
  }

  /** What the install prompts add when the update comes from an address that is not the built-in one: where it comes from. */
  #feedNote() {
    return this.feedLabel ? `\n\nThis update comes from ${this.feedLabel}, the update address set in config.json. Install it only if you set that address.` : '';
  }

  async #offerRestart(info) {
    if (this.offering) return;
    this.offering = true;
    try {
      const mac = this.updaterType === 'mac';
      const answer = await this.show({
        type: 'info',
        title,
        message: `A new version is ready: ${describeInfo(info)}`,
        detail: `It has been downloaded and checked. opendoc-desktop restarts to install it.${mac ? '' : ' Your system asks for your password, because the app is installed for all users.'}${this.#feedNote()}`,
        buttons: ['Restart to Update', 'Later'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (answer.response === 0) await this.restartToUpdate();
    } finally { this.offering = false; }
  }

  // ---------- installing ----------

  /** "Restart to Update" (deb, rpm, pacman, macOS). The window stays usable while a password prompt is open. */
  async restartToUpdate() {
    if (!this.ready || this.installing || !this.updater?.installDownloaded) return { outcome: 'none' };
    this.installing = true;
    this.#changed();
    let result;
    try { result = await this.updater.installDownloaded(); }
    catch (error) { result = { outcome: 'failed', message: firstLine(error) }; }
    finally { this.installing = false; }
    this.log(`install: ${result.outcome}${result.message ? ` (${firstLine(result.message)})` : ''}`);
    if (result.outcome === 'installed') {
      this.ready = null;
      await this.#clearDownloaded('it is installed');
      this.#changed();
      if (this.updaterType !== 'mac') this.relaunch(); // the macOS helper opens the new bundle itself
      this.quit();
      return result;
    }
    this.#changed();
    if (result.outcome === 'cancelled') {
      await this.#say('info', 'Update cancelled', 'Nothing was changed. The update stays downloaded: choose Restart to Update in the menu when you want it.');
    } else if (result.outcome === 'blocked') {
      await this.#offerDownloadPage(this.ready.info, result.message);
    } else {
      const file = this.updater.downloaded?.()?.file;
      const manual = file ? manualCommand(this.updaterType, file) : null;
      await this.#say('error', 'The update could not be installed', `${result.message ?? 'The installer failed.'}${manual ? `\n\nYou can install the downloaded file yourself:\n${manual}` : ''}`);
    }
    return result;
  }

  /**
   * Delete the downloaded file and update-info.json from the updater's pending folder: after a package install (deb, rpm, pacman) the
   * installed file is no use any more, and the next check that finds nothing newer clears what a crash, an AppImage swap or a macOS swap
   * left. Never while a downloaded update still waits (the AppImage's swap at quit needs its file). Never throws.
   */
  async #clearDownloaded(why) {
    if (typeof this.updater?.clearDownloaded !== 'function') return;
    if (this.ready) return; // a download the user postponed is still the one to install
    try { await this.updater.clearDownloaded(); this.log(`the downloaded update was removed: ${why}`); }
    catch (error) { this.log(`the downloaded update could not be removed: ${firstLine(error)}`); }
  }

  /** The AppImage's swap, run while the app quits (called from the shell's shutdown, after the service has stopped). Never throws. */
  async installOnQuit() {
    try {
      // A download from an automatic check is swapped in only while the switch is on; one the user asked for with "Check for Updates…" always is.
      if (!this.updater?.installAtQuit || !this.ready || (!this.automatic && !this.ready.manual) || this.updaterType !== 'appimage') return false;
      this.renamedTo = null;
      this.swapError = null;
      this.swapping = true;
      const installed = this.updater.installAtQuit();
      this.log(`swap at quit: ${installed ? 'done' : 'not done'}`);
      if (installed && this.renamedTo) await this.onAppImageMoved(this.renamedTo);
      // False with no error means install() was ignored (electron-updater's own quit handler already swapped, or is doing it): not a failure.
      if (!installed && this.swapError) await this.#rememberSwapFailure(this.swapError);
      else if (!installed) this.log('the swap was not run here: electron-updater\'s own install already ran');
      return Boolean(installed);
    } catch (error) {
      this.log(`the swap at quit failed: ${error.message}`);
      await this.#rememberSwapFailure(firstLine(error));
      return false;
    } finally {
      this.swapping = false;
    }
  }

  /** The swap at quit failed (no room, a folder that turned read-only): keep why, so the next launch can say it once. Never throws. */
  async #rememberSwapFailure(reason) {
    try {
      const appImage = this.env.APPIMAGE;
      const failure = { folder: appImage ? dirname(appImage) : null, reason, build: parseBuild(this.ready?.info?.build) };
      await this.config.update(value => ({ ...value, updateNotices: { ...(value.updateNotices ?? {}), swapFailed: failure } }));
    } catch (error) { this.log(`the swap failure could not be recorded: ${error.message}`); }
  }

  /** At launch: the last quit could not install the update. Said once (the record goes before the dialog), without holding anything up. */
  async #swapNotice() {
    const notices = (await this.config.read()).updateNotices ?? {};
    const failure = notices.swapFailed;
    if (!failure) return;
    await this.config.update(value => {
      const { swapFailed, ...rest } = value.updateNotices ?? {};
      return { ...value, updateNotices: rest };
    });
    this.log(`the last update could not be installed: ${failure.reason}`);
    this.#track(this.#say('info', 'The last update could not be installed', `opendoc-desktop could not replace itself${failure.folder ? ` in ${failure.folder}` : ''}: ${failure.reason}\n\nNothing was changed, and this is still the version you had. The next check tries again.`));
  }

  /** macOS: what the swap helper wrote last time (it runs after the app has quit), put in the updater's log; the next check offers the update again. */
  async #helperNotes() {
    try {
      const lines = await this.helperLogs();
      for (const line of lines) this.log(`the update helper said: ${line}`);
      if (lines.some(line => /nothing was swapped|swap failed/.test(line))) this.log('the last update was not installed; the next check offers it again');
    } catch (error) { this.log(`the update helper's log could not be read: ${error.message}`); }
  }

  /** At launch: an AppImage in a folder the user cannot write to is told once (the swap would fail at quit), and nothing is downloaded. */
  async #launchNotices() {
    if (this.updaterType !== 'appimage' || !this.updater) return;
    const blocked = await this.updater.preflight();
    if (blocked.ok || blocked.reason !== 'not-writable') return;
    this.log(`not downloading: ${blocked.message}`);
    this.#track(this.#noticeBlockedFolder(blocked));
  }

  async #noticeBlockedFolder(blocked) {
    const notices = (await this.config.read()).updateNotices ?? {};
    if (notices.folder === blocked.folder) return;
    await this.config.update(value => ({ ...value, updateNotices: { ...(value.updateNotices ?? {}), folder: blocked.folder } })); // before the dialog, as the other one-time notices
    await this.#say('info', 'opendoc-desktop cannot update itself here', blocked.message);
  }

  /** Stop everything (the timer); the app is closing. */
  stop() {
    this.schedule.stop();
  }
}
