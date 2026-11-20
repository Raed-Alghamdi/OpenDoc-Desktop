import { lstat, readFile, realpath, rm, stat, symlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { applicationRoot, managedRuntime } from '../runtime/paths';

export const workspaceFormat = 1;
export type Edition = 'normal' | 'headless';
export const packageNames = { normal: '@ryanyahya/opendoc', headless: '@ryanyahya/opendoc-headless' } as const;
export type PackageIdentity = { name: typeof packageNames[Edition]; version: string; edition: Edition };
export type PackageMetadata = { name: string; version: string; bin?: string | Record<string, string>; dependencies?: Record<string, string>; opendoc?: { edition?: unknown } };
/** `managed` says node_modules is a link to the desktop app's runtime. It is per device and travels with git, so it counts only where managedRuntime() finds that runtime. */
export type WorkspaceMarker = { formatVersion: number; createdWith?: string; edition?: Edition; managed?: boolean };

export function isStableVersion(value: unknown): boolean {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return false;
  return value.split('.').every(part => Number.isSafeInteger(Number(part)));
}

/**
 * Where a workspace's pin stands against the running OpenDoc (the version policy):
 * `current` is the same minor with the same or an older patch (it opens normally and the app moves the pin up),
 * `newer-patch` and `newer-minor` open read-only, and `older-minor` is an upgrade only the app can run.
 */
export type PinStatus = 'current' | 'newer-patch' | 'older-minor' | 'newer-minor';

const parts = (version: string) => version.split('.').map(Number) as [number, number, number];

export function comparePin(pin: string, running: string): PinStatus {
  if (!isStableVersion(pin) || !isStableVersion(running)) throw new Error('OpenDoc versions must be exact stable versions.');
  const [pinMajor, pinMinor, pinPatch] = parts(pin), [major, minor, patch] = parts(running);
  if (pinMajor !== major || pinMinor !== minor) return pinMajor < major || (pinMajor === major && pinMinor < minor) ? 'older-minor' : 'newer-minor';
  return pinPatch > patch ? 'newer-patch' : 'current';
}

/** Published packages declare their edition and must match its exact registry identity. */
export function packageIdentity(metadata: PackageMetadata): PackageIdentity {
  if (!metadata || typeof metadata !== 'object') throw new Error('The OpenDoc package has invalid metadata. Reinstall the intended OpenDoc edition.');
  const edition = metadata.opendoc?.edition;
  const name = edition === 'normal' || edition === 'headless' ? packageNames[edition] : undefined;
  if (!name || metadata.name !== name || !isStableVersion(metadata.version)) throw new Error('The OpenDoc package has an invalid name, edition, or exact stable version. Reinstall the intended OpenDoc edition.');
  return { name, version: metadata.version, edition: edition as Edition };
}

/** Both editions install under the opendoc key so authored imports remain portable. */
export function dependencyPin(identity: Pick<PackageIdentity, 'edition' | 'version'>) {
  if (!isStableVersion(identity.version)) throw new Error('OpenDoc requires an exact stable version.');
  return `npm:${packageNames[identity.edition]}@${identity.version}`;
}

export function workspaceIdentity(metadata: Pick<PackageMetadata, 'dependencies'>, marker?: WorkspaceMarker): PackageIdentity {
  const pin = metadata?.dependencies?.opendoc;
  let identity: PackageIdentity | undefined;
  for (const edition of ['normal', 'headless'] as const) {
    const name = packageNames[edition], prefix = `npm:${name}@`;
    if (typeof pin === 'string' && pin.startsWith(prefix) && isStableVersion(pin.slice(prefix.length))) {
      identity = { name, version: pin.slice(prefix.length), edition };
      break;
    }
  }
  if (!identity) throw new Error(`The workspace must pin dependencies.opendoc to an exact stable version alias: npm:${packageNames.normal}@<exact-version> or npm:${packageNames.headless}@<exact-version>.`);
  if (marker?.edition && marker.edition !== identity.edition) throw new Error('The workspace edition does not match its pinned OpenDoc dependency. Restore its original edition before continuing; edition switching is not an update.');
  return identity;
}

export async function readWorkspaceMarker(root: string): Promise<WorkspaceMarker> {
  let marker: WorkspaceMarker;
  try { marker = JSON.parse(await readFile(resolve(root, '.opendoc/workspace.json'), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`This is not an initialized OpenDoc workspace: ${root}\nInitialize a new folder with the intended OpenDoc edition, or select an existing initialized workspace.`);
    throw new Error(`Cannot read the workspace format in ${root}: ${(error as Error).message}`);
  }
  if (!marker || marker.formatVersion !== workspaceFormat) throw new Error(`Unsupported OpenDoc workspace format ${marker?.formatVersion ?? '(missing)'}. This runtime supports format ${workspaceFormat}. No files were changed.`);
  if (marker.edition !== undefined && !['normal', 'headless'].includes(marker.edition)) throw new Error('Unsupported OpenDoc workspace edition. No files were changed.');
  if (marker.managed !== undefined && typeof marker.managed !== 'boolean') throw new Error('Unsupported OpenDoc workspace marker: managed must be true or false. No files were changed.');
  return marker;
}

export async function discoverWorkspace(start = process.cwd()): Promise<string | null> {
  let root = resolve(start);
  for (;;) {
    try { await stat(resolve(root, '.opendoc/workspace.json')); await readWorkspaceMarker(root); return await realpath(root); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = dirname(root);
    if (parent === root) return null;
    root = parent;
  }
}

export async function explicitWorkspace(path: string) {
  const root = await realpath(resolve(path));
  await readWorkspaceMarker(root);
  return root;
}

export async function packageMetadata(root = applicationRoot): Promise<PackageMetadata> {
  return JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
}

/** In a workspace the desktop app manages, node_modules is only a link to the app's runtime: create it when missing, replace it when dangling or foreign, never touch a real folder. */
export async function ensureRuntimeLink(root: string, nodeModules: string) {
  const link = resolve(root, 'node_modules');
  let existing;
  try { existing = await lstat(link); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (existing && !existing.isSymbolicLink()) return;
  if (existing) {
    try { if (await realpath(link) === await realpath(nodeModules)) return; } catch { /* dangling */ }
    await rm(link);
  }
  await symlink(nodeModules, link, 'dir');
}

/** Whether the desktop app manages this workspace here: its marker says so and this runtime is the app's. */
export async function isManagedHere(root: string) {
  return Boolean((await readWorkspaceMarker(root)).managed && managedRuntime());
}

/**
 * The installed application of a workspace the desktop app manages, which is the app's own runtime. The version
 * policy table applies instead of the exact npm pin, and the CLI never says "npm install": a workspace from an older minor
 * is the app's to upgrade. A newer pin returns the runtime and the read-only guard (read-only.ts) keeps writes out.
 */
async function appHoldsReadOnly(root: string): Promise<boolean> {
  try { return Boolean((await (await import('./owner')).workspaceOwner(root, { pidOnly: true })).readOnly); }
  catch { return false; } // A record that cannot be read is no reason to skip the refusal.
}

async function managedApplication(root: string, runtime: NonNullable<ReturnType<typeof managedRuntime>>, marker: WorkspaceMarker) {
  await ensureRuntimeLink(root, runtime.nodeModules);
  const app = resolve(root, 'node_modules/opendoc');
  let installed;
  try { installed = await packageMetadata(app); }
  catch { throw new Error('The OpenDoc runtime of the desktop app is missing or damaged here. Reinstall opendoc-desktop, then open this workspace in it.'); }
  const expected = workspaceIdentity(await packageMetadata(root), marker);
  let identity;
  try { identity = packageIdentity(installed); } catch { throw new Error('The OpenDoc runtime of the desktop app is missing or damaged here. Reinstall opendoc-desktop, then open this workspace in it.'); }
  if (identity.name !== expected.name || identity.edition !== expected.edition) throw new Error('The workspace edition does not match the OpenDoc edition of the desktop app. Edition switching is not an update.');
  if (comparePin(expected.version, identity.version) === 'older-minor' && !await appHoldsReadOnly(root)) {
    throw new Error(`This workspace was made with OpenDoc ${expected.version} and this app has ${identity.version}. Open this workspace in opendoc-desktop to upgrade it.`);
  }
  return await realpath(app);
}

export async function installedApplication(root: string) {
  const marker = await readWorkspaceMarker(root);
  const runtime = marker.managed ? managedRuntime() : null;
  if (runtime) return managedApplication(root, runtime, marker);
  const app = resolve(root, 'node_modules/opendoc');
  let installed;
  try { installed = await packageMetadata(app); }
  catch { throw new Error(`OpenDoc is not installed in ${root}. Run npm install in that folder, then npx opendoc check.`); }
  const manifest = await packageMetadata(root);
  const expected = workspaceIdentity(manifest, marker);
  const mismatch = `The workspace's pinned OpenDoc version or edition does not match its installation. Run npm install in ${root} to repair it.`;
  let identity;
  try { identity = packageIdentity(installed); } catch { throw new Error(mismatch); }
  if (identity.name !== expected.name || identity.version !== expected.version || identity.edition !== expected.edition) {
    throw new Error(mismatch);
  }
  return await realpath(app);
}
