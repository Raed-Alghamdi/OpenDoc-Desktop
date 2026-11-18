import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import util from 'node:util';
import { syncBuiltinESMExports } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { main, readBuildInfo, usageFor, versionResult } from '../src/cli/main';
import { commandNames, commandsFor, helpCatalogue, type CommandSpec } from '../src/cli/registry';
import { failureCodes, failureOf, type FailureCode } from '../src/cli/errors';
import { InvalidOwnerRecord, OwnerShuttingDown } from '../src/cli/owner';
import { runUpdate } from '../src/cli/update';
import { parseExportArgs } from '../src/server/export-batch';
import { RenderFailure } from '../src/server/render-error';
import { ExportChangedError } from '../src/server/export-file';
import { Conflict } from '../src/server/comments';
import { RestoreRefusal } from '../src/server/history-blocks';
import { CreateDocumentError } from '../src/server/create';
import { ProjectError } from '../src/server/projects';
import { TagsError } from '../src/server/tags';
import { ThemeFoldersError } from '../src/server/theme-folders';
import { ExportError } from '../src/server/exports';
import { HistoryError } from '../src/server/history';
import { AssetError } from '../src/assets/files';
import { projectRoot } from './helpers';
import './helpers-owner';

const snapshotFile = resolve(projectRoot, 'tests/fixtures/cli-help-catalogue.json');

/** A scratch workspace whose installed application is this checkout, so the real dispatcher accepts it. */
async function installedScratch(t: TestContext) {
  const root = await mkdtemp(resolve(tmpdir(), 'opendoc-registry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { version } = JSON.parse(await readFile(resolve(projectRoot, 'package.json'), 'utf8'));
  await mkdir(resolve(root, '.opendoc'));
  await writeFile(resolve(root, 'package.json'), JSON.stringify({ name: 'scratch', private: true, dependencies: { opendoc: `npm:@ryanyahya/opendoc@${version}` } }));
  await writeFile(resolve(root, '.opendoc/workspace.json'), '{"formatVersion":1}\n');
  await mkdir(resolve(root, 'node_modules'));
  await symlink(projectRoot, resolve(root, 'node_modules/opendoc'), 'dir');
  return root;
}

/** Everything main prints, and the exit code it leaves, for one run. */
function recorder(t: TestContext) {
  const out: string[] = [], err: string[] = [];
  t.mock.method(console, 'log', (line: string) => { out.push(String(line)); });
  t.mock.method(console, 'error', (line: string) => { err.push(String(line)); });
  t.after(() => { process.exitCode = undefined; });
  return {
    out, err,
    async run(...args: string[]) {
      out.length = 0; err.length = 0; process.exitCode = undefined;
      await main(args);
      const exitCode = process.exitCode as number | undefined;
      process.exitCode = undefined;
      return { exitCode, out: [...out], err: [...err] };
    },
  };
}

const byPath = (commands: CommandSpec[]) => new Map(commands.map(command => [command.path.join(' '), command]));

test('help --json is the catalogue of every command, built from the registry', async t => {
  const root = await installedScratch(t);
  const { run } = recorder(t);
  const { version } = JSON.parse(await readFile(resolve(projectRoot, 'package.json'), 'utf8'));
  const result = await run('--workspace', root, 'help', '--json');
  assert.equal(result.exitCode, undefined);
  const catalogue = JSON.parse(result.out[0]);
  assert.deepEqual(catalogue, helpCatalogue(version, 'normal'));
  assert.equal(catalogue.version, version);
  assert.equal(catalogue.edition, 'normal');
  for (const command of catalogue.commands as CommandSpec[]) {
    assert.ok(command.path.length && command.path.every(word => /^[a-z][a-z-]*$/.test(word)), command.path.join(' '));
    assert.ok(command.summary && !command.summary.includes('\u2014'), `${command.path.join(' ')} has a summary without em dashes`);
    assert.equal(command.json, true);
    assert.deepEqual(Object.keys(command), ['path', 'summary', 'args', 'options', 'json']);
    for (const arg of command.args) assert.deepEqual(Object.keys(arg), ['name', 'required', 'repeatable']);
    for (const option of command.options) {
      assert.deepEqual(Object.keys(option), ['name', 'type', 'repeatable', 'required', 'description']);
      assert.ok(['boolean', 'string'].includes(option.type));
      assert.ok(option.description, `${command.path.join(' ')} --${option.name} has a description`);
      assert.ok(!(option.type === 'boolean' && option.repeatable), 'a flag cannot repeat');
    }
    assert.equal(new Set(command.options.map(option => option.name)).size, command.options.length, `${command.path.join(' ')} lists an option twice`);
  }
  assert.equal(byPath(catalogue.commands).size, catalogue.commands.length, 'every path appears once');
  // The usage text of --help is unchanged: the same words, still under `usage`.
  const help = JSON.parse((await run('--workspace', root, '--help', '--json')).out[0]);
  assert.deepEqual(Object.keys(help), ['usage']);
  assert.equal(help.usage, usageFor('normal'));
});

test('the catalogue matches its snapshot', async () => {
  const { version } = JSON.parse(await readFile(resolve(projectRoot, 'package.json'), 'utf8'));
  // The version is the release's, not the catalogue's: the snapshot keeps the commands, options and edition.
  const current = JSON.stringify({ ...helpCatalogue(version, 'normal'), version: '<version>' }, null, 2) + '\n';
  if (process.env.UPDATE_SNAPSHOTS) await writeFile(snapshotFile, current);
  assert.equal(current, await readFile(snapshotFile, 'utf8'), 'The command catalogue changed. Review the diff; if it is intended, regenerate with UPDATE_SNAPSHOTS=1.');
});

test('every command main dispatches is in the registry, and every registered command is dispatched', async t => {
  const source = await readFile(resolve(projectRoot, 'src/cli/main.ts'), 'utf8');
  // Word commands only: `case 'x':`, `command === 'x'`, and the help words. The --version and --help flags are not commands.
  const dispatched = new Set([
    ...[...source.matchAll(/case '([a-z][a-z-]*)':/g)].map(match => match[1]),
    ...[...source.matchAll(/command === '([a-z][a-z-]*)'/g)].map(match => match[1]),
    ...(source.includes(`'help'].includes(command)`) ? ['help'] : []),
  ]);
  assert.ok(dispatched.has('comments') && dispatched.has('init') && dispatched.has('help') && dispatched.has('status'), `the scan found the dispatcher: ${[...dispatched]}`);
  const registered = new Set(commandNames);
  assert.deepEqual([...dispatched].filter(name => !registered.has(name)), [], 'a command main dispatches is missing from the registry');
  assert.deepEqual([...registered].filter(name => !dispatched.has(name)), [], 'the registry lists a command main does not dispatch');
  // And the dispatcher really reaches each one: asking for its help never reports an unknown command.
  const root = await installedScratch(t);
  const { run } = recorder(t);
  for (const name of commandNames) {
    const result = await run(...(name === 'init' ? [] : ['--workspace', root]), name, '--help', '--json');
    assert.equal(result.exitCode, undefined, `${name} --help: ${result.err.join(' ')}`);
    assert.doesNotMatch(result.err.join('\n'), /Unknown command/, name);
    assert.ok(result.out.length, `${name} --help prints something`);
  }
  const unknown = await run('--workspace', root, 'no-such-command', '--json');
  assert.equal(unknown.exitCode, 2);
});

test('help works beside a junk .opendoc/server.json or desktop.json', async t => {
  const root = await installedScratch(t);
  await writeFile(resolve(root, '.opendoc/server.json'), 'garbage');
  await writeFile(resolve(root, '.opendoc/desktop.json'), '{"pid":');
  const { run } = recorder(t);
  for (const args of [['help', '--json'], ['help'], ['--help']]) {
    const result = await run('--workspace', root, ...args);
    assert.equal(result.exitCode, undefined, args.join(' '));
    assert.equal(result.err.length, 0);
  }
  assert.ok(JSON.parse((await run('--workspace', root, 'help', '--json')).out[0]).commands.length > 50);
});

test('status, stop, context and start are listed only where they make sense', () => {
  const only = ['start', 'status', 'stop', 'context'];
  const normal = commandsFor('normal'), headless = commandsFor('headless');
  for (const name of only) {
    assert.ok(normal.some(command => command.path[0] === name), `${name} is in the normal edition`);
    assert.ok(!headless.some(command => command.path[0] === name), `${name} is not in Headless`);
    assert.doesNotMatch(usageFor('headless'), new RegExp(`opendoc ${name}\\b`));
  }
  assert.match(usageFor('normal'), /opendoc status[\s\S]*opendoc stop/);
  const init = byPath(headless).get('init')!;
  assert.deepEqual(init.args, [{ name: 'folder', required: true, repeatable: false }]);
  assert.deepEqual(init.options, []);
  assert.equal(byPath(normal).get('init')!.args[0].required, false);
  // Everything else is in both.
  assert.deepEqual(headless.map(command => command.path.join(' ')).filter(path => !only.includes(path)),
    normal.map(command => command.path.join(' ')).filter(path => !only.includes(path)));
  assert.equal(helpCatalogue('0.6.1', 'headless').edition, 'headless');
});

// --- The drift test -------------------------------------------------------------------------------

type ParserConfig = { options: Record<string, { type: string; multiple?: boolean }> };
type Call = { config: ParserConfig; accepted: boolean; message?: string };

/** Lets each command's own parseArgs call run for real, records what it was given and whether it accepted the arguments, and stops the command right after an accepted parse. */
async function probing<T>(body: (calls: Call[]) => Promise<T>) {
  const real = util.parseArgs, calls: Call[] = [];
  util.parseArgs = ((config: ParserConfig) => {
    let parsed;
    try { parsed = real(config as never); }
    catch (error) { calls.push({ config, accepted: false, message: (error as Error).message }); throw error; }
    calls.push({ config, accepted: true });
    // An accepted parse must not go on to run the command.
    throw new ProbeStop(parsed);
  }) as typeof util.parseArgs;
  syncBuiltinESMExports();
  try { return await body(calls); }
  finally { util.parseArgs = real; syncBuiltinESMExports(); }
}
class ProbeStop extends Error { constructor(readonly parsed: unknown) { super('probe: the arguments were accepted'); } }

const placeholder = (command: CommandSpec) => command.args.filter(arg => arg.required).map((_, index) => `x${index + 1}`);
/** The option as typed, twice for a repeatable one, so the parser has to accept the repetition. */
const typed = (option: CommandSpec['options'][number]) => {
  const once = option.type === 'boolean' ? [`--${option.name}`] : [`--${option.name}`, 'value'];
  return option.repeatable ? [...once, ...once] : once;
};
/** Which parser a command's arguments reach: export history has its own. */
const parserOf = (command: CommandSpec) => command.path[0] === 'export' && command.path[1] === 'history' ? 'export history' : command.path[0];
/** Parser options that exist but are not for agents, so the registry leaves them out on purpose. */
const unlisted: Record<string, string[]> = {
  themes: ['parent', 'name'], // --parent is refused with an explanation; folders update --name is the old spelling of rename.
};
const handParsed = new Set(['help', 'check', 'export', 'update']);

test('drift: every registered option goes through the command\'s real parser, and the parser knows no option the registry lacks', async t => {
  const root = await installedScratch(t);
  recorder(t);
  const seen = new Map<string, Set<string>>();
  let probed = 0;
  await probing(async calls => {
    for (const command of commandsFor('normal')) {
      if (handParsed.has(command.path[0]) && !(command.path[0] === 'export' && command.path[1] === 'history')) continue;
      const parser = parserOf(command);
      for (const option of [undefined, ...command.options]) {
        calls.length = 0; process.exitCode = undefined;
        const words = [...command.path, ...placeholder(command), ...(option ? typed(option) : [])];
        // init is the one command that runs without a workspace, and refuses --workspace.
        await main(command.path[0] === 'init' ? words : ['--workspace', root, ...words]);
        process.exitCode = undefined;
        const label = `opendoc ${words.join(' ')}`;
        assert.equal(calls.length, 1, `${label} reaches one parser`);
        assert.ok(calls[0].accepted, `${label} is rejected by the parser: ${calls[0].message}`);
        probed++;
        const parsed = calls[0].config.options;
        if (option) {
          assert.ok(Object.hasOwn(parsed, option.name), `${label}: the parser has no --${option.name}`);
          assert.equal(parsed[option.name].type, option.type, `${label}: type of --${option.name}`);
          if (option.repeatable) assert.equal(parsed[option.name].multiple, true, `${label}: --${option.name} repeats`);
        }
        const names = seen.get(parser) ?? new Set<string>();
        for (const name of Object.keys(parsed)) names.add(name);
        seen.set(parser, names);
      }
    }
  });
  assert.ok(probed > 150, `${probed} invocations probed`);
  // The other direction: every option a parser accepts is registered for some command that reaches it.
  for (const [parser, names] of seen) {
    const registered = new Set(['json', 'help', ...(unlisted[parser] ?? []),
      ...commandsFor('normal').filter(command => parserOf(command) === parser).flatMap(command => command.options.map(option => option.name))]);
    assert.deepEqual([...names].filter(name => !registered.has(name)), [], `${parser}: the parser accepts options the registry does not list`);
  }
  assert.deepEqual([...seen.keys()].sort(), ['assets', 'comments', 'context', 'create', 'documents', 'export history', 'history', 'init', 'media', 'packs', 'projects', 'review', 'start', 'status', 'stop', 'tags', 'templates', 'themes']);
});

test('drift: the hand-written parsers of export, update and check agree with the registry', async t => {
  const root = await installedScratch(t);
  const { run } = recorder(t);
  const all = byPath(commandsFor('normal'));
  // export: parseExportArgs is the real parser the command runs.
  const exporting = all.get('export')!;
  for (const option of exporting.options) {
    assert.doesNotThrow(() => parseExportArgs(option.name === 'all' ? ['--all'] : ['proof', ...typed(option).slice(0, option.type === 'boolean' ? 1 : 2).map(word => word === 'value' ? 'pdf' : word)]), `export --${option.name}`);
  }
  assert.doesNotThrow(() => parseExportArgs(['proof', 'other', '--json']));
  assert.throws(() => parseExportArgs(['proof', '--no-such-option']), /Invalid argument/);
  // update: the real runUpdate refuses an option it does not know before touching anything; here it never gets further than the missing workspace.
  const updating = all.get('update')!;
  const failure = async (...args: string[]) => {
    try { await runUpdate(args, resolve(root, 'no-such-workspace')); return undefined; }
    catch (error) { return (error as Error).message; }
    finally { process.exitCode = undefined; }
  };
  for (const option of updating.options) {
    const message = await failure(...(option.type === 'boolean' ? [`--${option.name}`] : [`--${option.name}`, '1.0.0']));
    assert.doesNotMatch(message ?? '', /Unknown update option|Duplicate update option|requires an exact/, `update --${option.name}`);
  }
  assert.match((await failure('--no-such-option')) ?? '', /Unknown update option/);
  // check and help take no options at all.
  for (const name of ['check', 'help']) assert.deepEqual(all.get(name)!.options, []);
  const refused = await run('--workspace', root, 'check', '--no-such-option', '--json');
  assert.equal(refused.exitCode, 2);
});

test('drift: the probe notices a parser that rejects what the registry lists', async t => {
  const root = await installedScratch(t);
  recorder(t);
  await probing(async calls => {
    await main(['--workspace', root, 'comments', 'list', 'x1', '--no-such-option']);
    process.exitCode = undefined;
    assert.equal(calls.length, 1);
    assert.equal(calls[0].accepted, false);
    assert.match(calls[0].message!, /Unknown option/);
  });
});

// --- Failures: code and exit status ---------------------------------------------------------------

test('a --json failure carries ok:false, the unchanged error text and a stable code', async t => {
  const root = await installedScratch(t);
  const { run } = recorder(t);
  const failed = async (args: string[], code: string, exitCode: number, message: RegExp) => {
    const result = await run('--workspace', root, ...args, '--json');
    assert.equal(result.exitCode, exitCode, `${args.join(' ')} exit status`);
    const body = JSON.parse(result.out.at(-1)!);
    assert.deepEqual(Object.keys(body), ['ok', 'error', 'code']);
    assert.equal(body.ok, false);
    assert.equal(body.code, code, args.join(' '));
    assert.equal(typeof body.error, 'string');
    assert.match(body.error, message);
    assert.equal(result.err.at(-1), body.error, 'the same text goes to stderr');
  };
  await failed(['context'], 'not-found', 1, /^There is no current context yet\. Open this workspace in OpenDoc and open a document, then try again\.$/);
  await writeFile(resolve(root, '.opendoc/server.json'), 'garbage');
  await failed(['status'], 'owner-unconfirmed', 1, /Cannot read the OpenDoc session/);
  await rm(resolve(root, '.opendoc/server.json'));
  await mkdir(resolve(root, 'documents'));
  await failed(['documents', 'delete', 'no-such-document'], 'not-found', 1, /./);
  await failed(['projects', 'create', 'x1'], 'invalid-input', 1, /./);
});

test('usage errors exit with status 2 and code usage; other failures exit with status 1', async t => {
  const root = await installedScratch(t);
  const { run } = recorder(t);
  const usage = async (args: string[]) => {
    for (const json of [true, false]) {
      const result = await run(...args, ...(json ? ['--json'] : []));
      assert.equal(result.exitCode, 2, args.join(' '));
      assert.ok(result.err.length, 'the message goes to stderr');
      if (json) assert.deepEqual(JSON.parse(result.out.at(-1)!), { ok: false, error: result.err.at(-1), code: 'usage' }, args.join(' '));
      else assert.equal(result.out.length, 0, 'nothing on stdout without --json');
    }
  };
  const inside = (...args: string[]) => ['--workspace', root, ...args];
  await usage(inside('no-such-command'));
  await usage(inside('comments', 'list', 'proof', '--no-such-option'));       // parseArgs: unknown option
  await usage(inside('comments', 'add', 'proof', 'block', 'text', '--phrase')); // parseArgs: missing value
  await usage(inside('status', 'extra'));                                      // the command's own usage text
  await usage(inside('projects', 'frobnicate'));                               // "Unknown project command or missing arguments"
  await usage(inside('export'));                                               // export without documents
  await usage(inside('export', 'proof', '--format', 'docx'));
  // update --json reports its own failures (see the report), so only the text form reaches main.
  const update = await run(...inside('update', '--no-such-option'));
  assert.equal(update.exitCode, 2);
  await usage(inside('check', 'extra'));
  await usage(inside('--version', 'extra'));
  await usage(['--workspace', root, '--workspace', root, 'status']);          // a global option twice
  await usage(['--workspace']);
  await usage(['--workspace', root, 'init', 'folder']);
  await usage(inside('start', 'folder'));
  // The text of each error is the one it always had.
  assert.equal((await run(...inside('no-such-command'))).err[0], 'Unknown command: no-such-command. Use npx opendoc --help.');
  assert.equal((await run(...inside('--version', 'extra'))).err[0], 'Use --version without other arguments.');
  assert.equal((await run('--workspace', root, '--workspace', root, 'status')).err[0], 'Provide --workspace only once.');
  // Everything that is not a mistake in the command line stays at 1.
  for (const args of [inside('context'), inside('documents', 'delete', 'no-such-document'), ['--workspace', resolve(root, 'nowhere'), 'status']]) {
    const result = await run(...args);
    assert.equal(result.exitCode, 1, args.join(' '));
  }
  // A command that sets its own exit status keeps it.
  assert.equal((await run(...inside('help'))).exitCode, undefined);
});

test('no workspace is its own failure, with its text unchanged', async t => {
  const { run } = recorder(t);
  const folder = await mkdtemp(resolve(tmpdir(), 'opendoc-registry-none-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const here = process.cwd();
  process.chdir(folder);
  t.after(() => process.chdir(here));
  const result = await run('projects', '--json');
  assert.equal(result.exitCode, 1);
  const body = JSON.parse(result.out[0]);
  assert.equal(body.code, 'no-workspace');
  assert.equal(body.error, `No OpenDoc workspace found. Run npx --yes @ryanyahya/opendoc init <folder>, or use --workspace <folder> for an existing workspace.`);
});

test('failureOf derives each code from the error\'s class, status, parse failure or text', () => {
  const parseFailure = (() => { try { util.parseArgs({ args: ['--nope'], options: {} }); } catch (error) { return error; } })();
  const cases: [unknown, FailureCode][] = [
    [Object.assign(new Error('x'), { failureCode: 'usage' }), 'usage'],
    [parseFailure, 'usage'],
    [new Error('Usage: npx opendoc status [--json]\nShows whether...'), 'usage'],
    [new Error('Duplicate --all option.\nUsage: npx opendoc export <document-id>'), 'usage'],
    [new Error('Unknown comments command or missing arguments.\nUsage: npx opendoc comments'), 'usage'],
    [new Error('Unknown update option: --x. Use update [--check] [--version <exact>] [--json].'), 'usage'],
    [Object.assign(new Error('x'), { failureCode: 'unsupported-runtime' }), 'unsupported-runtime'],
    [Object.assign(new Error('x'), { failureCode: 'not-a-code' }), 'failed'],
    [new Error('OpenDoc Headless has no browser service. Use npx opendoc create.'), 'unsupported-edition'],
    [new Error('No OpenDoc workspace found. Run npx --yes x init <folder>'), 'no-workspace'],
    [new Error('This is not an initialized OpenDoc workspace: /x\nInitialize a new folder'), 'workspace-invalid'],
    [new Error('Unsupported OpenDoc workspace format 2. This runtime supports format 1. No files were changed.'), 'workspace-invalid'],
    [new Error('OpenDoc is not installed in /x. Run npm install in that folder, then npx opendoc check.'), 'installation-invalid'],
    [new Error('The workspace\'s pinned OpenDoc version or edition does not match its installation. Run npm install in /x to repair it.'), 'installation-invalid'],
    [new Error('Another OpenDoc command is in progress. Wait for it to finish, then retry.'), 'workspace-locked'],
    [new Error('This workspace is open in opendoc-desktop. Close the app before running opendoc start. If opendoc-desktop is not running, delete .opendoc/desktop.json and try again.'), 'desktop-owns-workspace'],
    [new Error('OpenDoc is still running. Stop it first.'), 'service-running'],
    [new Error('OpenDoc is unavailable. Start or restart it before adding a comment.'), 'service-unavailable'],
    [new OwnerShuttingDown(), 'owner-shutting-down'],
    [new Error('The recorded OpenDoc process is still running or finishing shutdown. Wait.'), 'owner-shutting-down'],
    [new InvalidOwnerRecord(), 'owner-unconfirmed'],
    [new Error('Cannot read the OpenDoc session. Check .opendoc/server.json before starting another server.'), 'owner-unconfirmed'],
    [new Error('The opendoc-desktop record .opendoc/desktop.json cannot be read. If opendoc-desktop is not running, delete .opendoc/desktop.json and try again.'), 'owner-unconfirmed'],
    [new Error('Document not found.'), 'not-found'],
    [new Error('Comment not found.'), 'not-found'],
    [Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }), 'not-found'],
    [new ProjectError('Project not found.', 404), 'not-found'],
    [new TagsError('x', 409), 'conflict'],
    [new Conflict('The comment changed.'), 'conflict'],
    [new AssetError('The logo changed. Reload.', 409), 'conflict'],
    [new ThemeFoldersError('x'), 'invalid-input'],
    [new ExportError('x', 400), 'invalid-input'],
    [new HistoryError('x', 404), 'not-found'],
    [new CreateDocumentError('x', 'INVALID_INPUT', 400), 'invalid-input'],
    [new CreateDocumentError('x', 'ALREADY_EXISTS', 409), 'already-exists'],
    [new CreateDocumentError('x', 'UNSAFE_PATH', 409), 'unsafe-path'],
    [new CreateDocumentError('x', 'CREATE_FAILED', 500), 'failed'],
    [new RestoreRefusal('x'), 'restore-refused'],
    [new ExportChangedError(), 'document-changed'],
    [new RenderFailure('x', []), 'render-failed'],
    [new Error('Workspace typecheck failed. Correct the authoring errors above and run npx opendoc check again.'), 'typecheck-failed'],
    [Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }), 'permission-denied'],
    [new Error('Something nobody planned for.'), 'failed'],
    ['a string', 'failed'],
  ];
  for (const [error, code] of cases) {
    const failure = failureOf(error);
    assert.equal(failure.code, code, String((error as Error)?.message ?? error));
    assert.equal(failure.exitCode, code === 'usage' ? 2 : 1);
    assert.equal(failure.message, error instanceof Error ? error.message : String(error), 'the message is the error\'s own text');
  }
  // Every code is documented, and every documented code is derived by something above.
  assert.deepEqual([...new Set(cases.map(([, code]) => code))].sort(), Object.keys(failureCodes).sort());
  for (const code of Object.keys(failureCodes)) assert.match(code, /^[a-z]+(?:-[a-z]+)*$/, 'codes are kebab-case');
  // A class that is not a plain Error keeps its own name.
  assert.equal(failureOf(new RenderFailure('x', [])).code, 'render-failed');
});

// --- Build information ---------------------------------------------------------------------------

test('--version --json adds build when build-info.json sits beside the runtime, and prints what it did without it', async t => {
  const runtime = await mkdtemp(resolve(tmpdir(), 'opendoc-registry-runtime-'));
  t.after(() => rm(runtime, { recursive: true, force: true }));
  await writeFile(resolve(runtime, 'package.json'), JSON.stringify({ name: '@ryanyahya/opendoc', version: '0.6.1' }));
  assert.deepEqual(await versionResult(runtime), { version: '0.6.1' }, 'an npm install has no build-info.json');
  assert.equal(await readBuildInfo(runtime), undefined);
  const info = { build: 3, commit: 'b79e5b1', builtAt: '2026-11-18T10:00:00.000Z' };
  await writeFile(resolve(runtime, 'build-info.json'), JSON.stringify(info));
  assert.deepEqual(await versionResult(runtime), { version: '0.6.1', build: info });
  // Unknown keys stay out; a text build number is kept.
  await writeFile(resolve(runtime, 'build-info.json'), JSON.stringify({ ...info, build: '3-rc1', secret: 'x' }));
  assert.deepEqual(await versionResult(runtime), { version: '0.6.1', build: { ...info, build: '3-rc1' } });
  // A damaged file is no build, never a failed --version.
  for (const text of ['garbage', '[]', 'null', '{}', '{"build":{"n":1}}', '']) {
    await writeFile(resolve(runtime, 'build-info.json'), text);
    assert.deepEqual(await versionResult(runtime), { version: '0.6.1' }, JSON.stringify(text));
  }
  await rm(resolve(runtime, 'build-info.json'));
  assert.deepEqual(await versionResult(runtime), { version: '0.6.1' });
});

test('main prints the version, with build only when this runtime has a build-info.json', async t => {
  const root = await installedScratch(t);
  const { run } = recorder(t);
  const { version } = JSON.parse(await readFile(resolve(projectRoot, 'package.json'), 'utf8'));
  const json = await run('--workspace', root, '--version', '--json');
  assert.equal(json.exitCode, undefined);
  assert.deepEqual(JSON.parse(json.out[0]), await versionResult());
  assert.equal('build' in JSON.parse(json.out[0]), existsSync(resolve(projectRoot, 'build-info.json')));
  assert.deepEqual((await run('--workspace', root, '--version')).out, [version], 'the plain text is the version alone');
  assert.deepEqual(Object.keys(JSON.parse(json.out[0]))[0], 'version');
});
