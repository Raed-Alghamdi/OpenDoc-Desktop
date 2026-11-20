// The size of a window that must fit the screen it opens on. Pure, so the rule is tested without Electron.

/**
 * `wanted` ({ width, height }) cut down to the display's work area (the screen minus panels and docks) with `margin` left on every side,
 * but not below `min` (a window smaller than that is unusable; a work area smaller than `min` wins, since the window must fit it).
 */
export function fitToWorkArea(wanted, workArea, { margin = 12, min = { width: 480, height: 380 } } = {}) {
  const fit = (size, available, least) => {
    const room = Math.max(1, Math.floor(available));
    return Math.min(Math.max(Math.min(size, room), Math.min(least, room)), room);
  };
  return {
    width: fit(wanted.width, workArea.width - 2 * margin, min.width),
    height: fit(wanted.height, workArea.height - 2 * margin, min.height),
  };
}
