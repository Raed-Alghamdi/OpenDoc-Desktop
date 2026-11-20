#!/usr/bin/env node
// Check the agent integration files: the JSON shape of both plugin marketplaces and manifests,
// and that the three copies of the router skill are identical. Plain Node, no dependencies.
// Usage: node desktop/integrations/check.mjs [integrations-folder]
import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(process.argv[2] ?? dirname(fileURLToPath(import.meta.url)));
const skillCopies = ['skills/opendoc/SKILL.md', 'claude/opendoc/skills/opendoc/SKILL.md', 'codex/opendoc/skills/opendoc/SKILL.md'];
const names = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const problems = [];
const fail = (file, message) => problems.push(`${file}: ${message}`);
const isText = value => typeof value === 'string' && value.trim() !== '';
const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

async function json(file) {
  try { return JSON.parse(await readFile(resolve(root, file), 'utf8')); }
  catch (error) { fail(file, error.code === 'ENOENT' ? 'missing' : `not valid JSON (${error.message})`); return undefined; }
}

// A relative plugin path as both vendors read it: from the marketplace root, starting "./", never leaving it.
function pluginFolder(file, marketplaceRoot, value) {
  if (!isText(value) || !value.startsWith('./') || value.includes('\\') || value.split('/').includes('..')) { fail(file, `plugin path ${JSON.stringify(value)} must start with "./", use forward slashes and stay inside the marketplace`); return undefined; }
  return resolve(root, marketplaceRoot, value);
}

async function checkManifest(file, name) {
  const manifest = await json(file);
  if (manifest === undefined) return undefined;
  if (!isObject(manifest)) { fail(file, 'must be a JSON object'); return undefined; }
  if (manifest.name !== name) fail(file, `name must be "${name}"`);
  if (!isText(manifest.description)) fail(file, 'description is required');
  if (!semver.test(manifest.version ?? '')) fail(file, 'version must be a semantic version');
  if (!isObject(manifest.author) || !isText(manifest.author.name)) fail(file, 'author.name is required');
  if (manifest.license !== 'MIT') fail(file, 'license must be "MIT", like the repository');
  return manifest;
}

async function checkMarketplace({ file, marketplaceRoot, manifestFile, source }) {
  const marketplace = await json(file);
  if (marketplace === undefined) return undefined;
  if (marketplace.name !== 'opendoc') fail(file, 'marketplace name must be "opendoc"');
  if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length !== 1) { fail(file, 'plugins must list exactly the opendoc plugin'); return undefined; }
  const [entry] = marketplace.plugins;
  if (entry.name !== 'opendoc' || !names.test(entry.name)) fail(file, 'plugin name must be "opendoc"');
  const path = source(file, entry);
  const folder = pluginFolder(file, marketplaceRoot, path);
  if (folder === undefined) return undefined;
  const expected = resolve(root, marketplaceRoot, 'opendoc');
  if (folder !== expected) fail(file, `plugin path must point at ${relative(root, expected) || '.'}`);
  return checkManifest(relative(root, resolve(folder, manifestFile)).split(sep).join('/'), entry.name);
}

const claude = await checkMarketplace({
  file: 'claude/.claude-plugin/marketplace.json',
  marketplaceRoot: 'claude',
  manifestFile: '.claude-plugin/plugin.json',
  source: (file, entry) => {
    const marketplace = entry.source;
    return typeof marketplace === 'string' ? marketplace : (fail(file, 'plugin source must be a relative path string'), undefined);
  },
});
const claudeMarketplace = await json('claude/.claude-plugin/marketplace.json');
if (claudeMarketplace !== undefined) {
  if (!isObject(claudeMarketplace.owner) || !isText(claudeMarketplace.owner.name)) fail('claude/.claude-plugin/marketplace.json', 'owner.name is required');
  if (!isText(claudeMarketplace.description)) fail('claude/.claude-plugin/marketplace.json', 'description is required');
}

const codex = await checkMarketplace({
  file: 'codex/.agents/plugins/marketplace.json',
  marketplaceRoot: 'codex',
  manifestFile: 'plugin.json',
  source: (file, entry) => {
    const { source } = entry;
    if (!isObject(source) || source.source !== 'local') { fail(file, 'plugin source must be { "source": "local", "path": "./..." }'); return undefined; }
    return source.path;
  },
});
const codexMarketplace = await json('codex/.agents/plugins/marketplace.json');
if (codexMarketplace !== undefined) {
  const file = 'codex/.agents/plugins/marketplace.json';
  const [entry] = Array.isArray(codexMarketplace.plugins) ? codexMarketplace.plugins : [];
  if (entry !== undefined) {
    if (!isObject(entry.policy) || !isText(entry.policy.installation) || !isText(entry.policy.authentication)) fail(file, 'plugin policy needs installation and authentication');
    if (!isText(entry.category)) fail(file, 'plugin category is required');
  }
  if (!isObject(codexMarketplace.interface) || !isText(codexMarketplace.interface.displayName)) fail(file, 'interface.displayName is required');
}
if (claude !== undefined && codex !== undefined && claude.version !== codex.version) fail('claude and codex plugin manifests', 'versions must match');

// The router skill: three identical copies, each with the frontmatter both vendors need.
const copies = [];
for (const file of skillCopies) {
  try { copies.push({ file, text: await readFile(resolve(root, file), 'utf8') }); }
  catch (error) { fail(file, error.code === 'ENOENT' ? 'missing' : error.message); }
}
for (const { file, text } of copies) {
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';
  if (!/^name: opendoc$/m.test(front)) fail(file, 'frontmatter must set name: opendoc');
  if (!/^description: \S/m.test(front)) fail(file, 'frontmatter must have a description');
}
for (const copy of copies.slice(1)) if (copy.text !== copies[0].text) fail(copy.file, `differs from ${copies[0].file}; copy it over byte for byte`);

// The app copies this folder to its data folder, so it must hold plain files and folders only.
async function walk(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = resolve(folder, entry.name);
    const name = relative(root, path).split(sep).join('/');
    if ((await lstat(path)).isSymbolicLink()) fail(name, 'symbolic links are not allowed');
    else if (entry.isDirectory()) await walk(path);
  }
}
try { await walk(root); } catch (error) { fail(relative(process.cwd(), root) || '.', error.message); }

if (problems.length > 0) {
  console.error(`Integration check failed (${problems.length}):\n${problems.map(problem => `  ${problem}`).join('\n')}`);
  process.exit(1);
}
console.log('Integration check passed: 2 marketplaces, 2 plugin manifests, 3 identical skill copies.');
