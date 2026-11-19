import { useEffect } from "react";
import type { ReadOnlyState } from "../shared/read-only";

/**
 * Tells the reader why nothing here can be changed, in the app's own words. While it shows, the root element carries
 * `data-read-only`, and read-only.css hides Edit, Comment and Save; the service refuses every write in any case.
 */
export function ReadOnlyBanner({ state }: { state: ReadOnlyState | null }) {
  useEffect(() => {
    if (!state) return;
    document.documentElement.dataset.readOnly = state.reason;
    return () => { delete document.documentElement.dataset.readOnly; };
  }, [state]);
  return state ? <div className="read-only-banner" role="status">{state.message}</div> : null;
}
