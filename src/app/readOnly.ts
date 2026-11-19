import { readOnlyState, type ReadOnlyState } from '../shared/read-only';

/**
 * Whether the service opened this workspace read-only (plan 3.4), from `GET /api/session`. The browser edition's
 * service never says so and answers null. The message is the desktop app's own wording, shown exactly as given.
 */
export async function fetchReadOnly(signal?: AbortSignal): Promise<ReadOnlyState | null> {
  const response = await fetch('/api/session', { signal });
  if (!response.ok) return null;
  return readOnlyState((await response.json().catch(() => null))?.readOnly);
}
