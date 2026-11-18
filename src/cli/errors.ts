/**
 * What `opendoc` reports when a command fails: one stable kebab-case `code` beside the message,
 * and the exit status (2 for a usage error, 1 for everything else). Commands keep throwing plain
 * errors with their own text; the code is derived here, from the error's class or status, from a
 * parse failure, or, for the few messages that carry no type, from the message itself.
 */

/** The errors main.ts raises itself carry their code in `failureCode` (it cannot import this file up front); see `failing` there. */
const named = (error: unknown): FailureCode | undefined => {
  const code = (error as { failureCode?: unknown } | null)?.failureCode;
  return typeof code === 'string' && Object.hasOwn(failureCodes, code) ? code as FailureCode : undefined;
};

/** Every code a `--json` failure can carry, with when it applies. The registry's tests keep this list and `failureOf` in step. */
export const failureCodes = {
  usage: 'The command line is wrong: an unknown or misused option, a missing argument, an unknown command. Exit status 2.',
  'unsupported-runtime': 'This Node.js version cannot run OpenDoc.',
  'unsupported-edition': 'The command does not exist in this edition, such as start in OpenDoc Headless.',
  'no-workspace': 'No OpenDoc workspace was found from the current folder or the one given with --workspace.',
  'workspace-invalid': 'The folder is not an initialized workspace, or its marker, format or edition is not supported.',
  'installation-invalid': 'The workspace\'s installed OpenDoc is missing or does not match its pin.',
  'workspace-locked': 'Another OpenDoc command holds the workspace, or its lock is unreadable.',
  'desktop-owns-workspace': 'opendoc-desktop has the workspace open and the command needs it closed.',
  'service-running': 'The browser edition\'s service is running and the command needs it stopped.',
  'service-unavailable': 'The recorded service did not answer.',
  'owner-shutting-down': 'The previous OpenDoc session is still finishing its shutdown.',
  'owner-unconfirmed': 'A session record (.opendoc/server.json or desktop.json) is unreadable, or its owner could not be confirmed.',
  'not-found': 'A document, comment, version, theme, template, asset, export or file does not exist.',
  conflict: 'The item changed since it was read (a version or revision mismatch), or it already exists.',
  'invalid-input': 'A value was refused: bad ID, bad option value, a refused change.',
  'restore-refused': 'A history restore was refused because it would lose work or does not apply.',
  'document-changed': 'The source changed while the command was working, so nothing was published.',
  'render-failed': 'A document, theme or template did not render. `issues` lists what is wrong.',
  'typecheck-failed': 'The workspace did not typecheck.',
  'already-exists': 'The thing to create already exists.',
  'unsafe-path': 'A location is not a regular workspace folder, so nothing was written.',
  'permission-denied': 'The operating system refused access to a file or folder.',
  failed: 'Any other failure.',
} as const;
export type FailureCode = keyof typeof failureCodes;

export interface Failure { message: string; code: FailureCode; exitCode: 1 | 2 }

const kebab = (value: string) => value.toLowerCase().replace(/_/g, '-');
const className = (error: unknown) => (error as { constructor?: { name?: string } } | null)?.constructor?.name ?? '';

/** The messages of usage errors raised as plain errors by the command parsers. */
const usagePatterns = [
  /(?:^|\n)\s*Usage: (?:npx )/,
  /^Unknown [a-z-]+ command or missing arguments/,
  /^(?:Unknown|Duplicate) update option/,
  /^--version requires an exact stable version\.$/,
];

/** Messages of errors that carry no type, in the order they are tried. */
const messagePatterns: [RegExp, FailureCode][] = [
  [/^OpenDoc requires Node\.js \d+ or newer/, 'unsupported-runtime'],
  [/^OpenDoc Headless has no browser service/, 'unsupported-edition'],
  [/^No OpenDoc workspace found/, 'no-workspace'],
  [/^This workspace is open in opendoc-desktop/, 'desktop-owns-workspace'],
  [/finishing (?:its previous session|shutdown)/, 'owner-shutting-down'],
  [/^OpenDoc is still running\./, 'service-running'],
  [/^OpenDoc is unavailable\./, 'service-unavailable'],
  [/\.opendoc\/(?:desktop|server)\.json|OpenDoc session|Cannot verify whether OpenDoc is running/, 'owner-unconfirmed'],
  [/(?:workspace runtime lock|Another OpenDoc command is in progress|previous OpenDoc command stopped before releasing)/, 'workspace-locked'],
  [/not an initialized OpenDoc workspace|Unsupported OpenDoc workspace (?:format|edition)|Cannot read the workspace format|must pin dependencies\.opendoc|workspace edition does not match/, 'workspace-invalid'],
  [/^OpenDoc is not installed in|does not match its installation|^The OpenDoc package has an invalid/, 'installation-invalid'],
  [/^Workspace typecheck failed/, 'typecheck-failed'],
  [/\bnot found\b|does not exist|^No deleted document|^There is no current context yet/i, 'not-found'],
];

/** The message, stable code and exit status of any error a command threw. */
export function failureOf(error: unknown): Failure {
  const message = error instanceof Error ? error.message : String(error);
  const fail = (code: FailureCode): Failure => ({ message, code, exitCode: code === 'usage' ? 2 : 1 });
  const own = named(error);
  if (own) return fail(own);
  const meta = error as { code?: unknown; status?: unknown; issues?: unknown } | null;
  // node:util parseArgs: unknown option, missing or unexpected value, unexpected positional.
  if (typeof meta?.code === 'string' && meta.code.startsWith('ERR_PARSE_ARGS_')) return fail('usage');
  const name = className(error);
  if (name === 'RenderFailure') return fail('render-failed');
  if (name === 'ExportChangedError') return fail('document-changed');
  if (name === 'Conflict') return fail('conflict');
  if (name === 'RestoreRefusal') return fail('restore-refused');
  if (name === 'InvalidOwnerRecord') return fail('owner-unconfirmed');
  if (name === 'OwnerShuttingDown') return fail('owner-shutting-down');
  // Creating a document names its own failures (INVALID_INPUT, ALREADY_EXISTS, UNSAFE_PATH, CREATE_FAILED).
  if (name === 'CreateDocumentError' && typeof meta?.code === 'string') {
    const code = kebab(meta.code);
    if (code === 'invalid-input' || code === 'already-exists' || code === 'unsafe-path') return fail(code);
    return fail('failed');
  }
  // The domain errors (projects, tags, theme folders, assets, exports, history) carry the HTTP status the app would answer with.
  if (typeof meta?.status === 'number') {
    if (meta.status === 404) return fail('not-found');
    if (meta.status === 409) return fail('conflict');
    if (meta.status >= 400 && meta.status < 500) return fail('invalid-input');
    return fail('failed');
  }
  if (usagePatterns.some(pattern => pattern.test(message))) return fail('usage');
  if (meta?.code === 'ENOENT') return fail('not-found');
  if (meta?.code === 'EACCES' || meta?.code === 'EPERM') return fail('permission-denied');
  for (const [pattern, code] of messagePatterns) if (pattern.test(message)) return fail(code);
  return fail('failed');
}
