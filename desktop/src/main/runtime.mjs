// The runtime the app carries: a folder with `node_modules/opendoc` (the CLI and service), `package.json` and
// `build-info.json` ({ build, commit, builtAt }), built by the packaging work. The app runs the CLI with its
// own executable as Node (ELECTRON_RUN_AS_NODE), so users need no Node or npm.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { environment } from './identity.mjs';

/**
 * Where the runtime is: the override for tests and development, the packaged resources, or the dev build folder.
 * An installed app (packaged, and not a test build) never takes the override: an environment variable must not choose the code it runs.
 */
export function runtimeLocation({ env = process.env, packaged, testBuild = false, resourcesPath, developmentRoot, platform = process.platform, arch = process.arch }) {
  if (env[environment.runtime] && (!packaged || testBuild)) return env[environment.runtime];
  if (packaged) return join(resourcesPath, 'runtime');
  return join(developmentRoot, 'build', 'runtime', `${platform}-${arch}`);
}

export const cliPath = runtime => join(runtime, 'node_modules', 'opendoc', 'bin', 'opendoc.mjs');

/** `{ build, commit, builtAt }`, or null when the runtime has no build-info.json (npm packages and dev builds). */
export async function readBuildInfo(runtime) {
  try {
    const info = JSON.parse(await readFile(join(runtime, 'build-info.json'), 'utf8'));
    return Number.isSafeInteger(info.build) ? info : null;
  } catch { return null; }
}

/** The environment for a child that runs this executable as Node. Never inherits ELECTRON_FORCE_IS_PACKAGED. */
export function nodeModeEnvironment(extra = {}, base = process.env) {
  const env = { ...base, ...extra, ELECTRON_RUN_AS_NODE: '1' };
  delete env.ELECTRON_FORCE_IS_PACKAGED;
  return env;
}

/** Run the CLI and collect its output. */
export function runCli(runtime, args, { cwd, env, timeout = 10 * 60_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath(runtime), ...args], { cwd, env: nodeModeEnvironment(env), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    const stop = () => child.kill('SIGKILL'); // the caller gave up (the app is quitting)
    if (signal?.aborted) stop(); else signal?.addEventListener('abort', stop, { once: true });
    child.once('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', stop); reject(error); });
    child.once('close', (code, killed) => { clearTimeout(timer); signal?.removeEventListener('abort', stop); resolve({ code: code ?? 1, signal: killed, stdout, stderr }); });
  });
}
