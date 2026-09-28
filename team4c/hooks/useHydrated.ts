import { useSyncExternalStore } from "react";

function subscribe() {
  // Nothing to subscribe to -- hydration completes exactly once and
  // never changes back, so this store never actually emits an update.
  return () => {};
}
function getClientSnapshot() {
  return true;
}
function getServerSnapshot() {
  return false;
}

/**
 * Stage 10 — fixes a live-reproduced bug: a `DialogTrigger`/
 * `AlertDialogTrigger` button clicked as the very FIRST interaction on a
 * freshly-loaded page (e.g. "Create Workspace" right after landing on
 * /dashboard, or "Add Material" right after navigating to a workspace
 * page) silently swallows that click — the dialog only opens on the
 * second click. Confirmed live, twice: the same button opens on the
 * first click once the page has had ANY prior interaction. This is a
 * hydration race, not a bug in the dialog wiring itself — the native DOM
 * click event can arrive before React finishes hydrating and attaching
 * this specific element's handler, and a browser click with no handler
 * attached yet is simply lost, never queued for replay.
 *
 * `mounted` starts `false` identically on the server and the client's
 * first render (so this causes no hydration mismatch), and flips to
 * `true` only inside a `useEffect` — which React guarantees never runs
 * until AFTER hydration has completed for this component. Consumers
 * render their trigger `disabled={!hydrated}` (see WorkspaceDashboard's
 * "Create Workspace" and WorkspaceFiles' "Add Material" buttons): by the
 * time the button visually becomes enabled, React has already attached
 * its click handler, so the race this hook exists to close cannot
 * reopen. This trades an imperceptibly brief (one render pass) disabled
 * state for guaranteeing the button's first REAL click is never lost.
 *
 * Implemented via `useSyncExternalStore` (React's own sanctioned
 * mechanism for a value that legitimately differs between the server
 * render and the client) rather than `useState` + `useEffect(() =>
 * setHydrated(true), [])` -- the more common version of this idiom
 * elsewhere -- because this repo's own react-hooks/set-state-in-effect
 * rule flags that pattern, and unlike WorkspaceDashboard's prop-sync fix
 * (components/shared/workspace-dashboard.tsx), there is no prop to
 * compare against here to move the update into render instead.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, getClientSnapshot, getServerSnapshot);
}
