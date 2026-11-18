/**
 * The environment for a program that is not Node: a file manager, a browser, the clipboard tools.
 * Inside the desktop app the service host runs with ELECTRON_RUN_AS_NODE=1 (render and import workers need it),
 * and an Electron-based program that inherits it would start as plain Node and fail. Node children keep the variable.
 */
export function externalEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { ELECTRON_RUN_AS_NODE: _, ...rest } = env;
  return rest;
}
