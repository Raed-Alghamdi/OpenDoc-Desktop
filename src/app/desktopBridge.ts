export type HostState = 'restarting' | 'running' | 'failed';

/** What the desktop app's preload script offers the page. It exists only inside the app; the browser edition has none. */
export interface DesktopBridge {
  onChange(listener: () => void): () => void;
  onHostState?(listener: (event: { state: HostState }) => void): () => void;
}

export function desktopBridge(scope: object = window): DesktopBridge | undefined {
  return (scope as { opendocDesktop?: DesktopBridge }).opendocDesktop;
}

/** Short, non-blocking notices for the states in which the service is not answering. */
export const hostStateMessage: Record<Exclude<HostState, 'running'>, string> = {
  restarting: 'Reconnecting to OpenDoc. Your unsaved text stays here until it is back.',
  failed: 'OpenDoc stopped.',
};

/** Subscribes to the bridge and returns the function that unsubscribes. Unknown states are ignored. */
export function connectDesktop(bridge: DesktopBridge, handlers: { change(): void; hostState(state: HostState): void }) {
  const stopChange = bridge.onChange(() => handlers.change());
  const stopState = bridge.onHostState?.(event => {
    if (event?.state === 'restarting' || event?.state === 'running' || event?.state === 'failed') handlers.hostState(event.state);
  });
  return () => { stopChange(); stopState?.(); };
}
