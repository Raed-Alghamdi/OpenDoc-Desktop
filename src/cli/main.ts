import { resolve } from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
import { applicationRoot, managedRuntime } from '../runtime/paths';
import { discoverWorkspace, explicitWorkspace, installedApplication, packageIdentity, packageMetadata, packageNames, type Edition } from './workspace';
import { runProcess } from './process';
import { withWorkspaceLock } from './lock';
import { RenderFailure } from '../server/render-error';

/**
 * An error that names its own failure code. errors.ts derives a code for every other error, but it is
 * loaded only when a failure is reported, so the errors raised here carry theirs without importing it.
 */
const failing = (message: string, failureCode: string) => Object.assign(new Error(message), { failureCode });
const usageError = (message: string) => failing(message, 'usage');

export const usageFor = (edition: Edition) => `OpenDoc${edition === 'headless' ? ' Headless — remote document production for agents' : ' — local documents and editable presentations'}

${edition === 'headless'
    ? `  npx --yes ${packageNames.headless} init <folder>\n                                   Create a workspace without a server`
    : `  npx --yes ${packageNames.normal} init [folder]\n                                   Create a workspace and open OpenDoc\n  npx opendoc start [folder]         Start its installed runtime`}
  npx opendoc create <id>            Create a document or presentation
  npx opendoc projects              Manage projects and membership
  npx opendoc documents             Rename, duplicate, delete, and restore documents
  npx opendoc templates             Inspect, check, and preview templates
  npx opendoc themes                Inspect, check, and preview themes
  npx opendoc tags                  Set types, status, and tags; find work
  npx opendoc assets                Manage fonts, logos, and bindings
  npx opendoc media                 Manage document-owned media
  npx opendoc comments              Add, edit, resolve, delete, and restore feedback
  npx opendoc history               Review and restore earlier versions
  npx opendoc packs                 Share or install themes and templates
  npx opendoc export <id...>         Export PDF or editable PowerPoint
  npx opendoc export history         List, delete, restore, and reveal earlier exports
  npx opendoc review <id>            Generate page images, text, and review issues
  npx opendoc check                 Typecheck workspace authoring
  npx opendoc update [--check]       Explicitly update the runtime${edition === 'headless' ? '' : `
  npx opendoc context                Show what the OpenDoc app has selected
  npx opendoc status                 Show whether OpenDoc is running here
  npx opendoc stop                   Stop the OpenDoc service`}

Commands discover the workspace from this folder or an ancestor.
Use --workspace <folder> to select one and --json for structured results.
Use <command> --help for options, or --version for the active version.`;

export function parseGlobalArgs(args: string[]) {
  const rest: string[] = [];
  let workspace: string | undefined;
  let json = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') { rest.push(...args.slice(index)); break; }
    if (arg === '--workspace' || arg.startsWith('--workspace=')) {
      if (workspace !== undefined) throw usageError('Provide --workspace only once.');
      workspace = arg === '--workspace' ? args[++index] : arg.slice('--workspace='.length);
      if (!workspace || workspace.startsWith('--')) throw usageError('Provide a folder after --workspace.');
    } else if (arg === '--json') json = true;
    else rest.push(arg);
  }
  return { args: rest, workspace, json };
}

/**
 * Where `build-info.json` is looked for: the desktop runtime's own folder, which holds `node_modules/opendoc` (the
 * runtime build writes the file beside the runtime's package.json, not inside this package). An npm install is no
 * runtime, so it looks in the package folder, where there is no such file.
 */
const buildInfoFolder = () => managedRuntime()?.directory ?? applicationRoot;

/**
 * The build the desktop runtime was made from, when it says so. The runtime build writes
 * `build-info.json` beside the runtime's package.json; npm packages don't have it.
 * A missing or unreadable file means no build to report, never a failure.
 */
export async function readBuildInfo(root = buildInfoFolder()): Promise<{ build?: number | string; commit?: string; builtAt?: string } | undefined> {
  let info: Record<string, unknown>;
  try { info = JSON.parse(await readFile(resolve(root, 'build-info.json'), 'utf8')); } catch { return undefined; }
  if (!info || typeof info !== 'object' || Array.isArray(info)) return undefined;
  const { build, commit, builtAt } = info;
  const result = {
    ...(typeof build === 'number' || typeof build === 'string' ? { build } : {}),
    ...(typeof commit === 'string' ? { commit } : {}),
    ...(typeof builtAt === 'string' ? { builtAt } : {}),
  };
  return Object.keys(result).length ? result : undefined;
}

/** What `--version --json` prints: the version, plus the runtime's build when it has one. A `root` holds both files. */
export async function versionResult(root?: string) {
  const { version } = await packageMetadata(root ?? applicationRoot);
  const build = await readBuildInfo(root ?? buildInfoFolder());
  return { version, ...(build ? { build } : {}) };
}

export async function main(rawArgs = process.argv.slice(2)) {
  let json = rawArgs.includes('--json');
  try {
    if (Number(process.versions.node.split('.')[0]) < 24) throw failing('OpenDoc requires Node.js 24 or newer. Install Node.js 24, then retry.', 'unsupported-runtime');
    const parsed = parseGlobalArgs(rawArgs);
    json = parsed.json;
    const identity = packageIdentity(await packageMetadata());
    const usage = usageFor(identity.edition);
    const [command, ...args] = parsed.args;
    if (!command || ['--help', '-h', 'help'].includes(command)) {
      // `help --json` is the catalogue of every command; --help --json keeps printing the usage text.
      if (json && command === 'help') console.log(JSON.stringify((await import('./registry')).helpCatalogue(identity.version, identity.edition)));
      else console.log(json ? JSON.stringify({ usage }) : usage);
      return;
    }
    if (command === 'init') {
      if (parsed.workspace) throw usageError('Use init <folder> to choose the new workspace.');
      const { runInit } = await import('./init');
      await runInit([...(json ? ['--json'] : []), ...args]); return;
    }
    let startFolder: string | undefined;
    if (command === 'start') {
      const index = args.findIndex(arg => !arg.startsWith('-'));
      if (index >= 0) startFolder = args.splice(index, 1)[0];
      if (startFolder && parsed.workspace) throw usageError('Choose start <folder> or --workspace <folder>, not both.');
    }
    const root = parsed.workspace || startFolder
      ? await explicitWorkspace(parsed.workspace ?? startFolder!)
      : await discoverWorkspace();
    if (root) {
      // A broken installation still answers --version; every other command needs it.
      let active: string | undefined;
      try { active = await installedApplication(root); }
      catch (error) { if (command !== '--version' && command !== '-v') throw error; }
      if (active && active !== await realpath(applicationRoot)) {
        const result = await runProcess(process.execPath, [resolve(active, 'bin/opendoc.mjs'), ...rawArgs], process.cwd());
        if (result.code) process.exitCode = result.code;
        return;
      }
    }
    if (command === '--version' || command === '-v') {
      if (args.length) throw usageError('Use --version without other arguments.');
      const result = await versionResult();
      console.log(json ? JSON.stringify(result) : result.version); return;
    }
    if (!root && command === 'packs') {
      await (await import('../packs/cli')).runPacksCli([...(json ? ['--json'] : []), ...args]); return;
    }
    if (!root) throw failing(`No OpenDoc workspace found. Run npx --yes ${identity.name} init <folder>, or use --workspace <folder> for an existing workspace.`, 'no-workspace');
    const flags = [...(json ? ['--json'] : []), ...args];
    // A workspace the app opened read-only refuses every command that writes (plan 3.4); reading, rendering and exporting go on.
    // Only a workspace the app has open (desktop.json) or manages (marker) can be read-only; the others never load the check.
    const [desktop, marker] = await Promise.all(['desktop.json', 'workspace.json'].map(file => readFile(resolve(root, '.opendoc', file), 'utf8').catch(() => '')));
    if (desktop || marker.includes('"managed"')) await (await import('./read-only')).refuseReadOnlyWrite(root, command, args);
    const dispatch = async () => {
      switch (command) {
        case 'start': await (await import('./start')).runStart(flags, root); break;
        case 'create': await (await import('../server/create-cli')).runCreateCli(flags, root); break;
        case 'projects': await (await import('../server/projects-cli')).runProjectsCli(flags, root); break;
        case 'documents': await (await import('../server/documents-cli')).runDocumentsCli(flags, root); break;
        case 'templates': await (await import('../server/templates-cli')).runTemplatesCli(flags, root); break;
        case 'packs': await (await import('../packs/cli')).runPacksCli(flags, root); break;
        case 'themes': await (await import('../server/themes-cli')).runThemesCli(flags, root); break;
        case 'tags': await (await import('../server/tags-cli')).runTagsCli(flags, root); break;
        case 'assets': await (await import('../server/assets-cli')).runAssetsCli(flags, root); break;
        case 'media': await (await import('../server/media-cli')).runMediaCli(flags, root); break;
        case 'comments': await (await import('../server/comments-cli')).runCommentsCli(flags, root, { mode: identity.edition === 'headless' ? 'direct' : 'auto' }); break;
        case 'history': await (await import('../server/history-cli')).runHistoryCli(flags, root); break;
        case 'export': {
          // `export history <action>` manages saved exports; any other arguments name documents to export.
          if (args[0] === 'history' && ['list', 'delete', 'restore', 'reveal'].includes(args[1])) { await (await import('../server/exports-cli')).runExportHistoryCli(flags, root); break; }
          await (await import('../server/export')).runExportCli(flags, root, { mode: identity.edition === 'headless' ? 'direct' : 'preview' }); break;
        }
        case 'review': await (await import('../server/review-cli')).runReviewCli(flags, root); break;
        case 'update': await (await import('./update')).runUpdate(flags, root); break;
        case 'context': await (await import('./context')).runContext(flags, root); break;
        case 'status': await (await import('./status')).runStatus(flags, root); break;
        case 'stop': await (await import('./stop')).runStop(flags, root); break;
        case 'check': {
          if (args.includes('--help') || args.includes('-h')) { const help = 'Usage: npx opendoc check [--json]\nTypechecks workspace documents, themes, and templates.'; console.log(json ? JSON.stringify({ usage: help }) : help); break; }
          if (args.length) throw usageError('Usage: npx opendoc check [--json]');
          const { checkWorkspace, validateInstallation } = await import('./check');
          await validateInstallation();
          // Agents check after editing; without a running service this is where their edits are versioned.
          const { recordAgentChanges } = await import('../server/history-capture');
          const { discoverDocumentIds } = await import('../server/export-batch');
          await recordAgentChanges(root, await discoverDocumentIds(root));
          await checkWorkspace(root, json); break;
        }
        default: throw usageError(`Unknown command: ${command}. Use npx opendoc --help.`);
      }
    };
    if (identity.edition === 'headless' && !['update', 'start', 'packs', 'status', 'stop', 'context'].includes(command)) await withWorkspaceLock(root, dispatch);
    else await dispatch();
  } catch (error) {
    const { message, code, exitCode } = (await import('./errors')).failureOf(error);
    console.error(message);
    if (json) console.log(JSON.stringify({ ok: false, error: message, code, ...(error instanceof RenderFailure ? { issues: error.issues } : {}) }));
    if (!process.exitCode) process.exitCode = exitCode;
  }
}
