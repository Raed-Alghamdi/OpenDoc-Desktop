// Remembers the main window's size, position and maximised state between launches (window-state.json beside config.json).
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const defaultSize = { width: 1360, height: 900 };
/** The smallest the workspace window can be made, and the smallest size restored from the saved state. */
export const minimumSize = { width: 640, height: 480 };

const finite = value => Number.isFinite(value) ? Math.round(value) : undefined;

/** Keep what looks like a window: a sensible size, and a position that is still on a connected display. */
export function restoreBounds(saved, workAreas) {
  if (!saved || typeof saved !== 'object') return { ...defaultSize, maximized: false };
  const width = Math.max(minimumSize.width, finite(saved.width) ?? defaultSize.width);
  const height = Math.max(minimumSize.height, finite(saved.height) ?? defaultSize.height);
  const result = { width, height, maximized: saved.maximized === true };
  const x = finite(saved.x);
  const y = finite(saved.y);
  if (x === undefined || y === undefined) return result;
  // At least a 100 by 60 corner of the window must sit on some display, so the title bar stays reachable.
  const visible = workAreas.some(area => Math.min(x + width, area.x + area.width) - Math.max(x, area.x) >= 100 && Math.min(y + height, area.y + area.height) - Math.max(y, area.y) >= 60);
  return visible ? { ...result, x, y } : result;
}

export async function loadWindowState(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

export async function saveWindowState(file, state) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(state, null, 2) + '\n');
  await rename(temporary, file);
}
