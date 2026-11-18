// Every Electron launch of these tests runs on a virtual display (xvfb-run) with the Claude app's display and
// Electron variables removed, so no window can ever reach the real screen. run.mjs sets the marker below.
export const virtualDisplayMarker = 'OPENDOC_SHELL_TESTS_XVFB';
export const strippedVariables = ['ELECTRON_FORCE_IS_PACKAGED', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_OZONE_PLATFORM_HINT', 'ELECTRON_PA_APP_NAME', 'WAYLAND_DISPLAY', 'OZONE_PLATFORM', 'XDG_BACKEND', 'HYPRLAND_INSTANCE_SIGNATURE', 'XDG_CURRENT_DESKTOP', 'GDK_SCALE', 'GDK_DPI_SCALE', 'QT_SCALE_FACTOR'];

export function assertVirtualDisplay(env = process.env) {
  if (env[virtualDisplayMarker] !== '1' || env.WAYLAND_DISPLAY) {
    throw new Error('Refusing to run: these tests open Electron windows and must run on a virtual display. Use `node desktop/tests/shell/run.mjs`.');
  }
}

/** The environment for an Electron process. */
export function electronEnvironment(extra = {}, base = process.env) {
  assertVirtualDisplay(base);
  const env = { ...base };
  for (const name of strippedVariables) delete env[name];
  // The desktop's display scale (GDK_SCALE=2 on a HiDPI screen) must not halve the virtual screen's size.
  return { ...env, GDK_BACKEND: 'x11', XDG_SESSION_TYPE: 'x11', GDK_SCALE: '1', ...extra };
}
