// Where OpenDoc is connected inside an app: its "targets". Most apps have one (their config folder). An app that may keep its
// settings in several folders (`multiFolder` in apps.mjs: Claude Code, whose desktop app and terminal can use different ones) has
// one target per folder, each with its own record, its own vendor environment and its own Connect and Disconnect.
//
// A target id is the app id for the app's default target (`claude` is `~/.claude`, so a record written before targets existed keeps
// its key), and `<app id>@<folder>` for any other: the folder relative to the home folder when it lies inside it (`claude@.claude-Work`),
// else the absolute path. A page only ever sends ids; the module accepts the ones detection found or its own manifest holds.
import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { expandHome, isDirectory, realOrResolved } from './files.mjs';

export const targetSeparator = '@';

/** The app id inside a target id (`claude@.claude-Work` is `claude`). */
export const appIdOfTarget = id => String(id).split(targetSeparator, 1)[0];

/** `~/x` for a folder inside the home folder, else the path as it is. */
export function displayPath(folder, home) {
  const path = relative(home, folder);
  return path && !path.startsWith('..') && !isAbsolute(path) ? `~/${path}` : folder;
}

/** The target id for `folder` of `app`: the app's id for its default folder, else `<id>@<folder>`. Pure (no file access). */
export function targetIdFor(app, folder, home) {
  const path = resolve(folder);
  if (path === join(home, ...app.defaultConfigFolder)) return app.id;
  const inside = relative(home, path);
  return `${app.id}${targetSeparator}${inside && !inside.startsWith('..') && !isAbsolute(inside) ? inside : path}`;
}

/** Whether `folder` holds something the app writes into a settings folder: one of the marker files, or one of the marker folders. */
export async function looksLikeSettingsFolder(folder, markers) {
  for (const name of markers.files) {
    try { if ((await stat(join(folder, name))).isFile()) return true; } catch { /* not there */ }
  }
  for (const name of markers.folders) if (await isDirectory(join(folder, name))) return true;
  return false;
}

const target = (app, fields) => ({ app: app.id, terminal: false, exists: false, ...fields });

/** What a vendor command needs in its environment for this folder: the variable set to it, or removed for the default folder. */
const environmentFor = (app, id, folder) => (app.configVariable ? { [app.configVariable]: id === app.id ? null : folder } : {});

/**
 * The targets of `app` on this computer, default first. `variables` is what the login shell and the app's environment say
 * (`{ NAME: { value, source } }`). Folders are looked up, nothing is run.
 */
export async function discoverTargets(app, { home, variables }) {
  const variable = app.configVariable ? variables[app.configVariable] : null;
  const defaultFolder = join(home, ...app.defaultConfigFolder);
  if (!app.multiFolder) {
    // One folder: the variable's when set, else the default. The vendor command gets the variable as the user has it.
    const configured = variable?.value ? expandHome(variable.value, home) : null;
    const folder = configured ?? defaultFolder;
    return [target(app, {
      id: app.id, label: displayPath(folder, home), configFolder: folder, source: variable ? variable.source : 'default', terminal: true,
      environment: app.configVariable ? { [app.configVariable]: variable?.value ?? null } : {}, exists: await isDirectory(folder),
      note: variable ? `Set by ${app.configVariable} (${variable.source}).` : '',
    })];
  }

  const fromVariable = variable?.value ? expandHome(variable.value, home) : null;
  const usable = fromVariable && isAbsolute(fromVariable) ? resolve(fromVariable) : null;
  const terminalFolder = usable ?? defaultFolder;
  const list = [];
  const seen = new Set();
  const add = async (folder, fields) => {
    const real = await realOrResolved(folder);
    if (seen.has(real)) return false;
    seen.add(real);
    const id = targetIdFor(app, folder, home);
    list.push(target(app, { id, label: displayPath(folder, home), configFolder: folder, environment: environmentFor(app, id, folder), terminal: resolve(folder) === terminalFolder, exists: await isDirectory(folder), ...fields }));
    return true;
  };

  await add(defaultFolder, {
    source: 'default',
    note: usable && usable !== defaultFolder
      ? `The default folder. ${app.configVariable} points somewhere else here, so a terminal does not use it.`
      : `The folder the ${app.command} command in a terminal uses, unless ${app.configVariable} is set.`,
  });
  let names = [];
  try { names = (await readdir(home)).filter(name => name.startsWith(app.multiFolder.prefix) && name.length > app.multiFolder.prefix.length).sort(); } catch { /* an unreadable home: no siblings */ }
  for (const name of names) {
    const folder = join(home, name);
    if (await isDirectory(folder) && await looksLikeSettingsFolder(folder, app.multiFolder.markers)) {
      await add(folder, { source: 'found', note: `Another ${app.name} settings folder. An app such as the Claude desktop app can use one like it.` });
    }
  }
  if (usable) {
    const added = await add(usable, { source: variable.source, note: `Named by ${app.configVariable} (${variable.source}).` });
    // The variable names a folder that is already listed: say so on that row.
    if (!added) for (const item of list) if (item.terminal) item.note = `${item.note} ${app.configVariable} points here (${variable.source}).`.trim();
  }
  return list;
}
