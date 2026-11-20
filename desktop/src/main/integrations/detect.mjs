// Finding an agent app without running it. A command is looked up on PATH as a file; nothing found is ever executed.
//
// Some Linux setups put every agent command on PATH as a mise shim, installed or not, and running a shim installs the tool. So a
// shim is never run. It is recognised by what it is (a link to the `mise` program, or a tiny script that hands over to it) and
// answered from mise's own install folders: `<mise data>/installs/<tool>/<version>/`. The tool counts as installed only when one
// of those folders holds a runnable file of that name; otherwise the app is absent and the reason says why.
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { expandHome, isDirectory } from './files.mjs';
import { isRunnable } from './run.mjs';

const isRunnableFile = async path => {
  try { return (await stat(path)).isFile() && (await isRunnable(path)); } catch { return false; }
};

/** Whether the file at `path` is a mise shim: it resolves to a program named `mise`, or it is a short script that hands over to mise. */
export async function isMiseShim(path) {
  try {
    const real = await realpath(path);
    if (/^mise(\.exe)?$/.test(basename(real))) return true;
    const info = await stat(real);
    if (info.size > 0 && info.size <= 4096) {
      const text = await readFile(real, 'utf8');
      return text.startsWith('#!') && /\bmise\b/.test(text) && /\bexec\b/.test(text);
    }
  } catch { /* unreadable or binary: not a shim we can name */ }
  return false;
}

/** The folders where mise keeps its tools, from the environment and from where a shim lives (`<data>/shims/x`, `<data>/command-wrappers/bin/x`). */
export function miseDataDirectories({ env, home, shimPath }) {
  const list = [];
  if (env.MISE_DATA_DIR) list.push(env.MISE_DATA_DIR);
  if (env.XDG_DATA_HOME && env.XDG_DATA_HOME.startsWith('/')) list.push(join(env.XDG_DATA_HOME, 'mise'));
  list.push(join(home, '.local', 'share', 'mise'));
  if (shimPath) {
    const folder = dirname(shimPath);
    if (basename(folder) === 'shims') list.push(dirname(folder));
    else if (basename(folder) === 'bin' && basename(dirname(folder)) === 'command-wrappers') list.push(dirname(dirname(folder)));
  }
  return [...new Set(list)];
}

const aliasOrder = ['global', 'latest'];

/** Look in mise's install folders for a runnable file called `name`. Returns `{ executable, tool, version }` or null. Runs nothing. */
export async function findMiseInstall(name, dataDirectories) {
  for (const data of dataDirectories) {
    const installs = join(data, 'installs');
    let tools;
    try { tools = (await readdir(installs)).filter(entry => !entry.startsWith('.')).sort(); } catch { continue; }
    // The tool named like the command first, then the others (a tool may ship several commands).
    tools.sort((a, b) => Number(b === name) - Number(a === name));
    for (const tool of tools) {
      const toolFolder = join(installs, tool);
      let versions;
      try { versions = (await readdir(toolFolder)).filter(entry => !entry.startsWith('.')); } catch { continue; }
      versions.sort((a, b) => {
        const rank = value => { const index = aliasOrder.indexOf(value); return index === -1 ? aliasOrder.length : index; };
        return rank(a) - rank(b) || (a < b ? 1 : a > b ? -1 : 0);
      });
      for (const version of versions) {
        const versionFolder = join(toolFolder, version);
        if (!(await isDirectory(versionFolder))) continue;
        const folders = [versionFolder, join(versionFolder, 'bin'), join(versionFolder, '.mise-bins'), join(versionFolder, 'node_modules', '.bin')];
        // Archives that unpack into one top-level folder (gh_2.1.0_linux_amd64/bin).
        try {
          for (const inner of await readdir(versionFolder)) {
            const innerFolder = join(versionFolder, inner);
            if (!inner.startsWith('.') && (await lstat(innerFolder)).isDirectory()) folders.push(join(innerFolder, 'bin'));
          }
        } catch { /* unreadable: skip */ }
        for (const folder of folders) {
          const executable = join(folder, name);
          if (await isRunnableFile(executable)) return { executable, tool, version: basename(await realpath(versionFolder).catch(() => versionFolder)) };
        }
      }
    }
  }
  return null;
}

/** Resolve `name` along `pathDirectories` without running it.
 *  Returns `{ found, executable, viaShim, shims, reason }`:
 *  - found with `viaShim: null` when a real program of that name is first on the path;
 *  - found with `viaShim` set when the first hit is a mise shim whose tool is installed (`executable` is the real file);
 *  - not found, with `shims` listing mise shims that stand for a tool that is not installed. */
export async function resolveCommand(name, { pathDirectories, env, home }) {
  const shims = [];
  for (const folder of pathDirectories) {
    const candidate = join(folder, name);
    if (!(await isRunnableFile(candidate))) continue;
    if (await isMiseShim(candidate)) {
      const install = await findMiseInstall(name, miseDataDirectories({ env, home, shimPath: candidate }));
      if (install) return { found: true, executable: install.executable, viaShim: candidate, installer: `mise (${install.tool} ${install.version})`, shims };
      shims.push(candidate);
      continue;
    }
    return { found: true, executable: candidate, viaShim: null, installer: null, shims };
  }
  return { found: false, executable: null, viaShim: null, installer: null, shims };
}

/** The config folder an app uses: its variable when set, else the default folder under the home folder. */
export function configFolder(app, { variables, home }) {
  const configured = app.configVariable ? variables[app.configVariable]?.value : null;
  return configured ? expandHome(configured, home) : join(home, ...app.defaultConfigFolder);
}

/** One app's detection result: plain data for the screen. */
export async function detectApp(app, { pathDirectories, env, home, variables }) {
  const resolved = await resolveCommand(app.command, { pathDirectories, env, home });
  const config = configFolder(app, { variables, home });
  const configExists = await isDirectory(config);
  const result = {
    id: app.id, name: app.name, kind: app.kind, command: app.command,
    present: false, canConnect: false, reason: '',
    executable: resolved.executable, viaShim: resolved.viaShim,
    configFolder: config, configFolderExists: configExists,
    configVariable: app.configVariable, configFolderSource: app.configVariable && variables[app.configVariable] ? variables[app.configVariable].source : 'default',
  };
  if (resolved.found) {
    result.present = true;
    result.canConnect = true;
    result.reason = resolved.viaShim
      ? `Found ${app.command} at ${resolved.executable}, installed with ${resolved.installer}.`
      : `Found ${app.command} at ${resolved.executable}.`;
    return result;
  }
  const shimNote = resolved.shims.length ? `The ${app.command} command on this PC is a mise shim for a tool that is not installed, so it was not run (running a shim would install the tool).` : `There is no ${app.command} command on the search path.`;
  if (app.kind === 'skill-files' && configExists) {
    // This app needs only a folder of files, so its own config folder is enough.
    result.present = true;
    result.canConnect = true;
    result.reason = `${shimNote} Its config folder ${config} exists, so the skill can still be copied there.`;
    return result;
  }
  result.reason = configExists ? `${shimNote} The config folder ${config} exists, but installing needs the ${app.command} command.` : shimNote;
  return result;
}
