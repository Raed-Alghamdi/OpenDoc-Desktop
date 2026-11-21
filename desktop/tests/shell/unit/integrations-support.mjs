// Helpers for the integrations tests: scratch folders, and fake vendor commands (`claude`, `codex`, `agy`) that behave like the
// real ones did when checked by hand and keep their state in the config folder they are given. They log every call to $FAKE_LOG so a test can
// say what was run, with which config folder, and that detection ran nothing. $FAKE_MODE switches in a failure, $FAKE_DELAY_MS makes every call slow.
import { execFileSync } from 'node:child_process';
import * as sync from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const repoSource = new URL('../../../integrations', import.meta.url).pathname;

// Scratch folders go when the test process ends (a test may leave read-only folders: they are made writable first).
const roots = [];
process.once('exit', () => {
  for (const root of roots) {
    try { sync.rmSync(root, { recursive: true, force: true }); }
    catch { try { execFileSync('chmod', ['-R', 'u+w', root]); sync.rmSync(root, { recursive: true, force: true }); } catch { /* left in the temp folder */ } }
  }
});

/** A scratch world: home, data folder, a bin folder for fake commands, a copy of the real integration files, and a log. */
export async function scratch() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'opendoc-integrations-')));
  roots.push(root);
  const world = { root, home: join(root, 'home'), data: join(root, 'data'), bin: join(root, 'bin'), source: join(root, 'source'), log: join(root, 'calls.log') };
  await mkdir(world.home, { recursive: true });
  await mkdir(world.bin, { recursive: true });
  await cp(repoSource, world.source, { recursive: true });
  await writeFile(world.log, '');
  // Only what a test lists is on the path: the real commands of whoever runs the tests are never found.
  // The XDG variables point inside the scratch home too: a scratch HOME alone would leave anything that honours XDG on the real folders.
  world.env = (extra = {}) => ({ HOME: world.home, XDG_CONFIG_HOME: join(world.home, '.config'), XDG_DATA_HOME: join(world.home, '.local', 'share'), XDG_CACHE_HOME: join(world.home, '.cache'), PATH: world.bin, FAKE_LOG: world.log, FAKE_STATE: root, ...extra });
  world.options = (extra = {}) => ({ home: world.home, dataDirectory: world.data, sourceDirectory: world.source, env: world.env(), readLoginShell: false, extraPathDirectories: [], commandTimeoutMs: 20_000, ...extra });
  world.calls = async () => (await readFile(world.log, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  return world;
}

const support = new URL(import.meta.url).href;

/** Install a fake vendor command into `folder` (default the scratch bin). */
export async function fakeCommand(world, name, folder = world.bin) {
  await mkdir(folder, { recursive: true });
  const file = join(folder, name);
  await writeFile(file, `#!${process.execPath}\nimport(${JSON.stringify(support)}).then(module => module.runFake(${JSON.stringify(name)}));\n`);
  await chmod(file, 0o755);
  return file;
}

/** A stand-in for the `mise` program: it records that it ran (it must never run). */
export async function fakeMise(world, folder = world.bin) {
  await mkdir(folder, { recursive: true });
  const file = join(folder, 'mise');
  await writeFile(file, `#!${process.execPath}\nrequire('node:fs').appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool: 'mise', args: process.argv.slice(2) }) + '\\n');\n`);
  await chmod(file, 0o755);
  return file;
}

/** A mise data folder with a shims folder holding a link to `mise` for each name. */
export async function miseShims(world, names, dataFolder = join(world.root, 'mise')) {
  const mise = await fakeMise(world, join(dataFolder, 'bin'));
  const shims = join(dataFolder, 'shims');
  await mkdir(shims, { recursive: true });
  for (const name of names) await symlink(mise, join(shims, name));
  return { data: dataFolder, shims };
}

/** Put a fake command where mise keeps an installed tool: `<data>/installs/<tool>/<version>/<inner>/<name>`. */
export async function miseInstall(world, dataFolder, tool, version, name, inner = 'bin') {
  return fakeCommand(world, name, join(dataFolder, 'installs', tool, version, inner));
}

/** Every path and every file's content below `folder`, as one string: to check that something no longer appears anywhere. */
export async function dump(folder) {
  const parts = [];
  const walk = async current => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      parts.push(path);
      if (entry.isDirectory()) await walk(path); else if (entry.isFile()) parts.push((await readFile(path, 'utf8').catch(() => '')));
    }
  };
  await walk(folder).catch(() => {});
  return parts.join('\n');
}

export async function listing(folder) {
  const out = [];
  const walk = async (current, prefix) => {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      out.push(`${prefix}${entry.name}${entry.isDirectory() ? '/' : ''}`);
      if (entry.isDirectory()) await walk(join(current, entry.name), `${prefix}${entry.name}/`);
    }
  };
  await walk(folder, '').catch(() => {});
  return out;
}

// ---- the fake vendor commands (run as child processes) ----

function load(file, fallback) { try { return JSON.parse(sync.readFileSync(file, 'utf8')); } catch { return fallback; } }
function save(file, value) { sync.mkdirSync(join(file, '..'), { recursive: true }); sync.writeFileSync(file, JSON.stringify(value)); }
function say(text, code = 0) { (code ? process.stderr : process.stdout).write(`${text}\n`); process.exit(code); }
function readJson(file) { return JSON.parse(sync.readFileSync(file, 'utf8')); }

export function runFake(name) {
  const args = process.argv.slice(2);
  const mode = process.env.FAKE_MODE ?? '';
  sync.appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ tool: name, args, cwd: process.cwd(), cwdMode: sync.statSync('.').mode & 0o777, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null, CODEX_HOME: process.env.CODEX_HOME ?? null, HOME: process.env.HOME ?? null, XDG: [process.env.XDG_CONFIG_HOME, process.env.XDG_DATA_HOME, process.env.XDG_CACHE_HOME].map(value => value ?? null), ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE ?? null, mode })}\n`);
  if (mode === 'slow') setTimeout(() => {}, 60_000);
  // FAKE_DELAY_MS: every call takes that long before it answers (the vendors' own commands take about half a second each).
  else if (Number(process.env.FAKE_DELAY_MS) > 0) setTimeout(() => ({ claude: fakeClaude, codex: fakeCodex, agy: fakeAgy })[name](args, mode), Number(process.env.FAKE_DELAY_MS));
  else ({ claude: fakeClaude, codex: fakeCodex, agy: fakeAgy })[name](args, mode);
}

const matches = (args, ...words) => words.every((word, index) => args[index] === word);

function fakeClaude(args, mode) {
  const config = process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME, '.claude');
  const file = join(config, 'fake-claude.json');
  const state = load(file, { marketplaces: [], plugins: [] });
  if (matches(args, 'plugin', 'marketplace', 'list')) return say(JSON.stringify(state.marketplaces.map(entry => ({ name: entry.name, source: 'directory', path: entry.path, installLocation: entry.path })), null, 2));
  if (matches(args, 'plugin', 'list')) return say(JSON.stringify(state.plugins, null, 2));
  if (matches(args, 'plugin', 'marketplace', 'add')) {
    if (mode === 'policy') return say("Marketplace source is blocked by your organization's managed settings (strictKnownMarketplaces).", 1);
    if (mode === 'fail-add') return say('Something went wrong adding the marketplace.', 1);
    const path = args[3];
    if (!sync.existsSync(join(path, '.claude-plugin', 'marketplace.json'))) return say(`Path does not exist: ${path}`, 1);
    const marketplace = readJson(join(path, '.claude-plugin', 'marketplace.json')).name;
    if (!state.marketplaces.some(entry => entry.name === marketplace)) state.marketplaces.push({ name: marketplace, path });
    save(file, state);
    return say(`Successfully added marketplace: ${marketplace}`);
  }
  if (matches(args, 'plugin', 'install')) {
    if (mode === 'fail-install') return say('Failed to install plugin: the plugin could not be loaded.', 1);
    const [plugin, marketplace] = args[2].split('@');
    const found = state.marketplaces.find(entry => entry.name === marketplace);
    if (!found) return say(`Plugin "${plugin}" not found in marketplace "${marketplace}".`, 1);
    if (!state.plugins.some(entry => entry.id === args[2])) {
      const installPath = join(config, 'plugins', 'cache', marketplace, plugin, '1.0.0');
      if (mode === 'ghost-install') return say(`Successfully installed plugin: ${args[2]} (scope: user)`);
      sync.mkdirSync(installPath, { recursive: true });
      sync.writeFileSync(join(installPath, 'plugin.json'), '{"name":"opendoc"}');
      state.plugins.push({ id: args[2], version: '1.0.0', scope: 'user', enabled: mode !== 'disabled-install', installPath, readFromFolder: join(found.path, plugin) });
      save(file, state);
    }
    return say(`Successfully installed plugin: ${args[2]} (scope: user)`);
  }
  if (matches(args, 'plugin', 'uninstall')) {
    if (mode === 'fail-uninstall') return say('Failed to uninstall plugin: it is in use.', 1);
    const entry = state.plugins.find(item => item.id === args[2]);
    if (!entry) return say(`Plugin "${args[2]}" not found in installed plugins`, 1);
    state.plugins = state.plugins.filter(item => item !== entry);
    sync.writeFileSync(join(entry.installPath, '.orphaned_at'), String(Date.now()));
    save(file, state);
    return say(`Successfully uninstalled plugin: ${args[2]}`);
  }
  if (matches(args, 'plugin', 'marketplace', 'remove')) {
    if (!state.marketplaces.some(entry => entry.name === args[3])) return say(`Marketplace '${args[3]}' not found`, 1);
    state.marketplaces = state.marketplaces.filter(entry => entry.name !== args[3]);
    save(file, state);
    return say(`Successfully removed marketplace: ${args[3]}`);
  }
  return say(`unknown command: ${args.join(' ')}`, 2);
}

function fakeCodex(args, mode) {
  const config = process.env.CODEX_HOME ?? join(process.env.HOME, '.codex');
  const file = join(config, 'fake-codex.json');
  const state = load(file, { marketplaces: [], plugins: [] });
  process.stderr.write('WARNING: proceeding, even though we could not create PATH aliases\n');
  if (matches(args, 'plugin', 'marketplace', 'list') && args[3] === '--json') return say(JSON.stringify({ marketplaces: state.marketplaces.map(entry => ({ name: entry.name, root: entry.path, marketplaceSource: { sourceType: 'local', source: entry.path } })) }, null, 2));
  if (matches(args, 'plugin', 'list') && args.includes('--json')) {
    // Like Codex 0.171: `--marketplace NAME` (or `-m NAME`) lists that marketplace only. Without it, a Codex signed in with ChatGPT first
    // downloads OpenAI's whole plugin catalog; this fake counts those downloads so a test can show the app never causes one.
    const flag = args.findIndex(arg => arg === '--marketplace' || arg === '-m');
    const only = flag === -1 ? null : args[flag + 1];
    if (only === null) { state.catalogDownloads = (state.catalogDownloads ?? 0) + 1; save(file, state); }
    return say(JSON.stringify({ installed: state.plugins.filter(entry => only === null || entry.marketplaceName === only), available: [] }, null, 2));
  }
  if (matches(args, 'plugin', 'marketplace', 'add')) {
    if (mode === 'policy') return say('Error: marketplace sources are disabled by requirements set by your administrator.', 1);
    const path = args[3];
    const marketplacePath = join(path, '.agents', 'plugins', 'marketplace.json');
    if (!sync.existsSync(marketplacePath)) return say(`Error: no marketplace at ${path}`, 1);
    const marketplace = readJson(marketplacePath).name;
    if (!state.marketplaces.some(entry => entry.name === marketplace)) state.marketplaces.push({ name: marketplace, path });
    save(file, state);
    return say(`Added marketplace \`${marketplace}\` from ${path}.`);
  }
  if (matches(args, 'plugin', 'add')) {
    if (mode === 'fail-install') return say('Error: plugin could not be installed.', 1);
    const [plugin, marketplace] = args[2].split('@');
    const found = state.marketplaces.find(entry => entry.name === marketplace);
    if (!found) return say(`Error: marketplace ${marketplace} is not configured`, 1);
    const installPath = join(config, 'plugins', 'cache', marketplace, plugin, '1.0.0');
    sync.mkdirSync(installPath, { recursive: true });
    sync.writeFileSync(join(installPath, 'plugin.json'), `{"copiedAt":${Date.now()}}`);
    if (!state.plugins.some(entry => entry.pluginId === args[2])) state.plugins.push({ pluginId: args[2], name: plugin, marketplaceName: marketplace, version: '1.0.0', installed: true, enabled: true, source: { source: 'local', path: join(found.path, plugin) } });
    save(file, state);
    return say(`Added plugin \`${plugin}\` from marketplace \`${marketplace}\`.`);
  }
  if (matches(args, 'plugin', 'remove')) {
    if (mode === 'fail-uninstall') return say('Error: could not remove the plugin.', 1);
    const [plugin, marketplace] = args[2].split('@');
    state.plugins = state.plugins.filter(entry => entry.pluginId !== args[2]);
    sync.rmSync(join(config, 'plugins', 'cache', marketplace, plugin), { recursive: true, force: true });
    sync.mkdirSync(join(config, 'plugins', 'cache', marketplace), { recursive: true });
    save(file, state);
    return say(`Removed plugin \`${plugin}\` from marketplace \`${marketplace}\`.`);
  }
  if (matches(args, 'plugin', 'marketplace', 'remove')) {
    if (!state.marketplaces.some(entry => entry.name === args[3])) return say(`Error: marketplace \`${args[3]}\` is not configured or installed`, 1);
    state.marketplaces = state.marketplaces.filter(entry => entry.name !== args[3]);
    save(file, state);
    return say(`Removed marketplace \`${args[3]}\`.`);
  }
  return say(`unknown command: ${args.join(' ')}`, 2);
}

function fakeAgy(args, mode) {
  const config = join(process.env.HOME, '.gemini', 'config');
  const file = join(config, 'fake-agy.json');
  const state = load(file, { plugins: [] });
  if (matches(args, 'plugin', 'list') && args[2] === '--json') return say(JSON.stringify(state.plugins, null, 2));
  if (matches(args, 'plugin', 'install')) {
    if (mode === 'policy') return say('Plugin installation is not allowed by your organization policy.', 1);
    const manifest = join(args[2], 'plugin.json');
    if (!sync.existsSync(manifest)) return say(`Error: no plugin.json in ${args[2]}`, 1);
    const plugin = readJson(manifest);
    if (mode === 'ghost-install') return say(`  [ok]    ${plugin.name}`);
    const path = join(config, 'plugins', plugin.name);
    sync.rmSync(path, { recursive: true, force: true });
    sync.mkdirSync(path, { recursive: true });
    sync.writeFileSync(join(path, 'plugin.json'), JSON.stringify(plugin));
    state.plugins = state.plugins.filter(entry => entry.name !== plugin.name);
    state.plugins.push({ name: plugin.name, enabled: true, version: plugin.version ?? null, source: 'antigravity', path, skills: ['opendoc'] });
    save(file, state);
    return say(`  [ok]    ${plugin.name}`);
  }
  if (matches(args, 'plugin', 'uninstall')) {
    state.plugins = state.plugins.filter(entry => entry.name !== args[2]);
    sync.rmSync(join(config, 'plugins', args[2]), { recursive: true, force: true });
    save(file, state);
    return say(`Uninstalled plugin "${args[2]}"`);
  }
  return say(`unknown command: ${args.join(' ')}`, 2);
}
