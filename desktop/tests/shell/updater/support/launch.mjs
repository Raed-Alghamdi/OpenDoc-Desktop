// Launching the app for an updater test: a scratch HOME (with XDG_CONFIG_HOME, XDG_DATA_HOME and XDG_CACHE_HOME inside it, so nothing
// of the real user's is touched), a profile with the given config.json, a resources folder standing in for the packaged app's, and the
// native stub (loaded by entry.mjs) that answers and records every dialog. The app is a development Electron on the virtual display; the updater treats it
// as packaged only because OPENDOC_DESKTOP_UPDATE_RESOURCES names the resources folder.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, newProfile } from '../../support/app.mjs';
import { waitFor } from '../../support/helpers.mjs';
import { workDir } from '../../support/paths.mjs';

const entry = join(dirname(fileURLToPath(import.meta.url)), 'entry.mjs');
let counter = 0;

const lines = async file => (await readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));

/** The labels of a menu, by path ('Help' for a top-level menu's items). */
export const menuLabels = (app, path = []) => app.evaluate(({ Menu }, names) => {
  let items = Menu.getApplicationMenu().items;
  for (const name of names) items = items.find(item => item.label === name).submenu.items;
  return items.map(item => item.label || `[${item.role ?? item.type}]`);
}, path);

export const menuItem = (app, path) => app.evaluate(({ Menu }, names) => {
  let item = { submenu: { items: Menu.getApplicationMenu().items } };
  for (const name of names) item = item.submenu.items.find(entry => entry.label === name);
  return { label: item.label, enabled: item.enabled, checked: item.checked, type: item.type };
}, path);

export const clickItem = (app, path) => app.evaluate(({ Menu }, names) => {
  let item = { submenu: { items: Menu.getApplicationMenu().items } };
  for (const name of names) item = item.submenu.items.find(entry => entry.label === name);
  item.click();
}, path);

/**
 * @param options.config config.json of the profile (updateFeed, checkForUpdates, lastRun ...)
 * @param options.resources files of the stand-in resources folder, name to text ({ 'package-type': 'deb' }, { 'update-disabled': '' })
 * @param options.path directories put first on the app's PATH (fake pkexec and package tools)
 * @param options.answers [[dialog message pattern, button label], ...] (the first match wins; the first button when none)
 * @param options.env more environment variables
 * @param options.useProfile an existing profile folder (a second launch of the same profile)
 */
export async function updaterApp({ config = {}, resources = {}, path = [], answers = [], env = {}, useProfile = null, home = null } = {}) {
  const id = ++counter;
  const root = join(workDir, `updater-${id}`);
  const homeDir = home ?? join(root, 'home');
  const folders = { config: join(homeDir, '.config'), data: join(homeDir, '.local', 'share'), cache: join(homeDir, '.cache') };
  for (const folder of [homeDir, ...Object.values(folders)]) await mkdir(folder, { recursive: true });
  const resourcesDir = join(root, 'resources');
  await mkdir(resourcesDir, { recursive: true });
  for (const [name, text] of Object.entries(resources)) await writeFile(join(resourcesDir, name), text);
  const events = join(root, 'events.jsonl');
  const answerFile = join(root, 'answers.json');
  await writeFile(events, '');
  await writeFile(answerFile, JSON.stringify(answers));
  const profile = useProfile ?? await newProfile('updater-profile', config);
  const app = await launchApp({
    profile,
    args: [entry], // Electron takes the first path as the app, so this runs before (and then imports) the shell's own entry
    env: {
      HOME: homeDir,
      XDG_CONFIG_HOME: folders.config,
      XDG_DATA_HOME: folders.data,
      XDG_CACHE_HOME: folders.cache,
      OPENDOC_UPDATER_TEST_EVENTS: events,
      OPENDOC_UPDATER_TEST_ANSWERS: answerFile,
      OPENDOC_DESKTOP_UPDATE_RESOURCES: resourcesDir,
      ...(path.length ? { PATH: `${path.join(':')}:${process.env.PATH}` } : {}),
      ...env,
    },
  });
  const events_ = () => lines(events);
  return {
    app,
    profile,
    home: homeDir,
    resourcesDir,
    cache: folders.cache,
    updaterCache: join(folders.cache, 'opendoc-desktop-updater'),
    events: events_,
    dialogs: async () => (await events_()).filter(event => event.kind === 'dialog'),
    external: async () => (await events_()).filter(event => event.kind === 'external').map(event => event.url),
    relaunched: async () => (await events_()).some(event => event.kind === 'relaunch'),
    setAnswers: rules => writeFile(answerFile, JSON.stringify(rules)),
    waitForDialog: (pattern, timeout = 60_000) => waitFor(async () => (await events_()).find(event => event.kind === 'dialog' && new RegExp(pattern).test(event.message)), { timeout, what: `the dialog ${pattern}` }),
    /** The updater's own log (the profile's logs/updater.log). */
    updaterLog: () => readFile(join(profile, 'logs', 'updater.log'), 'utf8').catch(() => ''),
  };
}
