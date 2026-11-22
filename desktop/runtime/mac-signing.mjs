// electron-builder hooks for the macOS app (electron-builder.yml names this file for afterPack and afterSign).
//
// The runtime is read-only (runtime/build.mjs), and extraResources keeps the modes. codesign writes into every file it signs: the
// native pieces get their signature inside the file, and every other binary file (fonts, images) in extended attributes. So the
// runtime in the .app is opened just before signing and closed again right after it, before the zip and the dmg are made.
// runtime/dist.mjs makes sure signing always happens on a Mac (pull request builds too), so the second hook always runs; the
// packaged check (tests/packaging/check-packaged.mjs) fails a Mac app whose runtime is left writable.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { setWritable } from './permissions.mjs';

/** The runtime folder inside the app electron-builder just packed, or null when this pack is not a macOS app. */
export function macRuntime(context) {
  if (context.electronPlatformName !== 'darwin' && context.electronPlatformName !== 'mas') return null;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const runtime = path.join(app, 'Contents', 'Resources', 'runtime');
  if (!existsSync(runtime)) throw new Error(`No runtime in ${app}: the macOS signing hooks expected one at ${runtime}.`);
  return runtime;
}

export async function afterPack(context) {
  const runtime = macRuntime(context);
  if (runtime) setWritable(runtime, true);
}

export async function afterSign(context) {
  const runtime = macRuntime(context);
  if (runtime) setWritable(runtime, false);
}
