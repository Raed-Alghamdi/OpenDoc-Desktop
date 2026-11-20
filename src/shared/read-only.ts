/** Why the desktop app opened a workspace read-only (the version policy). The app writes the message; every surface shows it as given. */
export const readOnlyReasons = ['newer-patch', 'newer-minor', 'declined-upgrade', 'restored-backup'] as const;
export interface ReadOnlyState { reason: typeof readOnlyReasons[number]; message: string }

/** The code a refused write carries: in HTTP error bodies and as the CLI's `--json` failure code. */
export const readOnlyCode = 'workspace-read-only';

/** A well-formed read-only state, or null for anything else (including no state at all). */
export function readOnlyState(value: unknown): ReadOnlyState | null {
  if (!value || typeof value !== 'object') return null;
  const { reason, message } = value as Record<string, unknown>;
  if (typeof message !== 'string' || !message.trim() || !(readOnlyReasons as readonly unknown[]).includes(reason)) return null;
  return { reason: reason as ReadOnlyState['reason'], message };
}
