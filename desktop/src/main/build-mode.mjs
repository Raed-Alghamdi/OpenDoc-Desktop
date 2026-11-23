// What a packaged build honours from the environment. The switches below exist so tests and development runs can point the app at a
// scratch runtime, a scratch updater folder, a package tarball and so on. In an installed app they would let an environment
// variable (set for the next launch by any program running as the user) choose the code or the update source the app uses, so a
// packaged build ignores them unless the build itself was made as a test build. No Electron import.
import { readFileSync } from 'node:fs';
import { environment } from './identity.mjs';

/** The field a test build has in the app's package.json (packaged into the app's archive; see desktop/README.md, "Test builds"). */
export const testBuildField = 'opendocTestBuild';

/** Every environment variable that changes which code, which feed or which folders a run uses. */
export const testSwitches = [
  environment.runtime,
  'OPENDOC_DESKTOP_UPDATE_RESOURCES',
  environment.healthInterval,
  environment.integrations,
  'OPENDOC_PACKAGE_TARBALL', // `opendoc init` installs the package from this file instead of the registry
];

/** True when the app's package.json says the build was made as a test build. A missing or unreadable file is not a test build. */
export function readTestBuild(packageUrl = new URL('../../package.json', import.meta.url), read = readFileSync) {
  try { return JSON.parse(read(packageUrl, 'utf8'))[testBuildField] === true; } catch { return false; }
}

/** Test switches and loopback update addresses are honoured by an unpackaged run, and by a packaged one only when it is a test build. */
export const testModeAllowed = ({ packaged, testBuild }) => !packaged || testBuild === true;

/**
 * Remove the test switches from `env` (in place) when they must be ignored; returns the names that were set and removed.
 * Removing them (instead of checking at each use) also keeps them away from the children the app starts.
 */
export function ignoreTestSwitches(env, { packaged, testBuild }) {
  if (testModeAllowed({ packaged, testBuild })) return [];
  const removed = testSwitches.filter(name => env[name] !== undefined && env[name] !== '');
  for (const name of testSwitches) delete env[name];
  return removed;
}
