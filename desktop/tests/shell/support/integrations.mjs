// A scratch world for the "Connect your AI apps" screen under Electron. The app's integration module is pointed at it through the
// options file that only an unpackaged app reads (OPENDOC_DESKTOP_INTEGRATIONS_OPTIONS): its own home, XDG folders, PATH holding
// fake vendor commands, a copy of the integration files, and the login shell never read. The login shell would otherwise report this
// session's real CLAUDE_CONFIG_DIR. The fake commands are the ones the module's own tests use.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fakeCommand, scratch } from '../unit/integrations-support.mjs';
import { workDir } from './paths.mjs';

let counter = 0;

/** `commands`: which fake vendor commands exist (`claude`, `codex`, `agy`). `mode`: a FAKE_MODE for them (`policy`, `fail-install`...). */
export async function integrationsWorld({ commands = ['claude', 'codex', 'agy'], mode = '' } = {}) {
  const world = await scratch();
  for (const name of commands) await fakeCommand(world, name);
  // The module's data folder is the app's own (inside the app's scratch HOME), so the options file leaves it out.
  /** The environment variable that points an app launch at this world, with the fake commands in `mode` (a failure to try). */
  world.appEnvironmentFor = async (fakeMode = '') => {
    const { dataDirectory, ...options } = world.options({ env: world.env(fakeMode ? { FAKE_MODE: fakeMode } : {}) });
    await mkdir(workDir, { recursive: true });
    const file = join(workDir, `integrations-options-${++counter}.json`);
    await writeFile(file, JSON.stringify(options));
    return { OPENDOC_DESKTOP_INTEGRATIONS_OPTIONS: file };
  };
  world.appEnvironment = await world.appEnvironmentFor(mode);
  return world;
}
