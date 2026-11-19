import { existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Code and dependencies belong to the installation; authored files belong to the workspace. */
export const applicationRoot = fileURLToPath(new URL('../../', import.meta.url));
export const runtimeResolve = (specifier: string) => {
  const url = import.meta.resolve(specifier);
  return url.startsWith('file:') ? fileURLToPath(url) : url;
};
export const runtimeSource = (path: string) => resolve(applicationRoot, 'src', path);

/**
 * The desktop app's runtime: this package sits in `<runtime>/node_modules`, beside the `build-info.json` the runtime
 * build writes. Null for an npm install. A workspace marked `managed` is acted on as one only when this finds the runtime.
 */
export function managedRuntime(): { directory: string; nodeModules: string } | null {
  const nodeModules = dirname(resolve(applicationRoot));
  const directory = dirname(nodeModules);
  return basename(nodeModules) === 'node_modules' && existsSync(resolve(directory, 'build-info.json')) ? { directory, nodeModules } : null;
}
