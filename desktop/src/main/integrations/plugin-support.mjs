// Pieces the three plugin connectors share. A connector gets a context from the module (`ctx`): `ctx.exec` runs the vendor's
// command and records a step for the screen, `ctx.record` is what the manifest keeps for this app, and `ctx.save()` writes it.
import { rmdir } from 'node:fs/promises';

/** The first line worth showing in a summary from a failed run's output. */
export function firstLine(text) {
  return (text ?? '').split('\n').map(line => line.trim()).find(Boolean) ?? '';
}

/** Run a vendor command that prints JSON, and parse it. `{ ok, value, result }`; a bad parse marks the step failed. */
export async function readJson(ctx, label, args) {
  const result = await ctx.exec(label, args);
  if (!result.ok) return { ok: false, value: null, result };
  try { return { ok: true, value: JSON.parse(result.stdout), result }; }
  catch { ctx.failLastStep('The command succeeded but did not print JSON.'); return { ok: false, value: null, result }; }
}

/** The failure a connector returns when a vendor command did not work: the code, and a summary that carries its first line of output. */
export function commandFailure(ctx, result, what) {
  const detail = firstLine(result.output) || (result.spawnError ?? (result.timedOut ? 'it did not finish in time' : `exit code ${result.exitCode}`));
  return { ok: false, code: ctx.failureCode(result), summary: `${what}: ${detail}` };
}

/** Remove folders only when they are empty, deepest first. Folders that are missing or still hold something stay. */
export async function removeEmptyFolders(folders) {
  const removed = [];
  for (const folder of folders) {
    try { await rmdir(folder); removed.push(folder); } catch { /* not empty or already gone: leave it */ }
  }
  return removed;
}
