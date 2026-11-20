// The upgrade itself: back up, run the registry's steps, move the pin, then `check` and `review` every document
// with the new version and report what failed. Each stage that fails stops the rest and says which one it was.
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createBackup } from './backup.mjs';
import { upgradeSteps, runUpgradeSteps } from './registry.mjs';
import { setFormatVersion } from './marker.mjs';
import { writePin } from './pin.mjs';

/** The ids of a workspace's documents: the folders under documents/ that hold an index.tsx. */
export async function listDocuments(root) {
  const folder = join(root, 'documents');
  let names;
  try { names = await readdir(folder); } catch { return []; }
  const ids = [];
  for (const name of names.sort()) {
    if (name.startsWith('.')) continue;
    try { if ((await stat(join(folder, name, 'index.tsx'))).isFile()) ids.push(name); } catch { /* not a document */ }
  }
  return ids;
}

const lastLines = (text, count = 4) => String(text ?? '').split('\n').map(line => line.trim()).filter(Boolean).slice(-count).join('\n');

/** What a failed `check` or `review` said: the JSON `error` when there is one, else the last lines it printed. */
export function failureMessage({ stdout = '', stderr = '' }) {
  let error = '';
  try { const parsed = JSON.parse(stdout); error = typeof parsed?.error === 'string' ? parsed.error : ''; } catch { /* not JSON */ }
  const detail = lastLines(stderr, 6);
  return [error, detail && detail !== error ? detail : ''].filter(Boolean).join('\n') || lastLines(stdout) || 'It failed without saying why.';
}

const pendingFile = root => join(root, '.opendoc', 'upgrade-pending.json');

/** `{ from, to, backup: { name, directory }, time }` when an upgrade moved the pin and its checks were never settled, else null. */
export async function readPending(root) {
  try {
    const pending = JSON.parse(await readFile(pendingFile(root), 'utf8'));
    return pending && typeof pending.to === 'string' ? pending : null;
  } catch { return null; }
}

async function writePending(root, pending) {
  await mkdir(join(root, '.opendoc'), { recursive: true });
  const temporary = join(root, '.opendoc', `.upgrade-pending.json.opendoc-${process.pid}.part`);
  await writeFile(temporary, `${JSON.stringify(pending, null, 2)}\n`);
  await rename(temporary, pendingFile(root));
}

/** The upgrade's checks are settled (they passed, or the user has seen what failed): the marker of "unfinished" goes. */
export const clearPending = root => rm(pendingFile(root), { force: true });

/**
 * `check`, then `review` of every document, with the workspace as the working directory.
 * @returns { failures: [{ id, label, message }], checked, canceled }
 */
export async function runChecks({ root, runCli, progress = () => {}, signal }) {
  const failures = [];
  progress('Checking the workspace…');
  const check = await runCli(['check', '--json'], { cwd: root }).catch(error => ({ code: 1, stdout: '', stderr: error.message }));
  if (check.code !== 0) failures.push({ id: null, label: 'Typecheck of the workspace', message: failureMessage(check) });
  const documents = await listDocuments(root);
  let done = 0;
  for (const id of documents) {
    if (signal?.aborted) return { failures, checked: done, canceled: true };
    progress(`Reviewing document ${done + 1} of ${documents.length}: ${id}…`);
    const review = await runCli(['review', id, '--json'], { cwd: root }).catch(error => ({ code: 1, stdout: '', stderr: error.message }));
    if (review.code !== 0) failures.push({ id, label: id, message: failureMessage(review) });
    done += 1;
  }
  return { failures, checked: documents.length, canceled: false };
}

/**
 * Run an upgrade. `runCli(args, { cwd })` runs the app's CLI (rejects only when it cannot run at all).
 * Order: back up, the registry's steps, `.opendoc/upgrade-pending.json`, the new pin, the new `formatVersion` in the marker,
 * then the checks. The pending file stays until the caller settles the result (`clearPending`), so a crash after the pin moved
 * is noticed at the next open.
 * @returns { ok, stage, backup, steps, failures: [{ id, label, message }], checked } where `stage` is the stage that
 *   failed (`backup`, `steps`, `pin`), `canceled` (`signal` aborted: the app is quitting) or `done`,
 *   and `ok` is true only when every check and review passed.
 */
export async function runUpgrade({ root, from, to, edition = 'normal', formatVersion, dataDir, runCli, registry = upgradeSteps, progress = () => {}, now, free, runStep, signal }) {
  let backup;
  const canceled = () => ({ ok: false, stage: 'canceled', backup: backup ?? null, steps: [], failures: [], checked: 0, message: 'The upgrade was stopped. The backup is kept; the next time the workspace is opened it asks again.' });
  progress('Backing up the workspace…');
  try { backup = await createBackup({ root, dataDir, from, to, now, free }); }
  catch (error) { return { ok: false, stage: 'backup', backup: null, steps: [], failures: [], checked: 0, message: error.message }; }

  if (signal?.aborted) return canceled();
  progress('Running the upgrade steps…');
  const steps = await runUpgradeSteps({ registry, from, to, root, run: runStep, onStep: entry => progress(`Upgrading from ${entry.from} to ${entry.to}…`) });
  if (!steps.ok) {
    const { from: stepFrom, to: stepTo, message } = steps.failed;
    return { ok: false, stage: 'steps', backup, steps: steps.results, failures: [{ id: null, label: `Upgrade step ${stepFrom} to ${stepTo}`, message }], checked: 0, message: `The upgrade step from ${stepFrom} to ${stepTo} failed, so the workspace was not moved to ${to}.` };
  }

  if (signal?.aborted) return canceled();
  progress('Moving the workspace to the new version…');
  try {
    await writePending(root, { from, to, backup: { name: backup.name, directory: backup.directory }, time: new Date().toISOString() });
    await writePin(root, to, edition);
    if (Number.isInteger(formatVersion)) await setFormatVersion(root, formatVersion);
  } catch (error) { return { ok: false, stage: 'pin', backup, steps: steps.results, failures: [{ id: null, label: 'package.json', message: error.message }], checked: 0, message: `The version could not be written to package.json: ${error.message}` }; }

  const checked = await runChecks({ root, runCli, progress, signal });
  if (checked.canceled) return { ...canceled(), stage: 'canceled' };
  return { ok: checked.failures.length === 0, stage: 'done', backup, steps: steps.results, failures: checked.failures, checked: checked.checked, message: '' };
}

/** The text of "Copy prompt for your agent": what to fix, with which version, and how to check it. */
export function agentPrompt({ root, to, failures }) {
  const lines = failures.map(failure => `- ${failure.id ? `Document "${failure.id}"` : failure.label}: ${failure.message.replace(/\n+/g, ' ')}`);
  return [
    `The OpenDoc workspace at ${root} was just upgraded to OpenDoc ${to}, and these things no longer pass:`,
    '',
    ...lines,
    '',
    'Fix each one under OpenDoc ' + to + ', in the workspace\'s own files. For each document, run `opendoc review <document-id>` until it reports no error, then run `opendoc check` for the whole workspace. Change only what is needed to make them pass, and keep the content of the documents as it is.',
  ].join('\n');
}
