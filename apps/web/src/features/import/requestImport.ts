/**
 * requestImport — the module-level request queue the ImportHost listens
 * on (the AddSourceHost / PropertyCreateHost idiom): the command palette's
 * "Import…" row, and later the sidebar or settings entries, open the
 * unified import modal through this call instead of prop re-wiring.
 * Requests fired before any host mounts queue until one does.
 */

export interface ImportRequest {
  /** Preselect a source (a future entry point may deep-link straight to one). */
  initialSource?: string | undefined;
}

type RequestListener = (request: ImportRequest) => void;

const listeners = new Set<RequestListener>();
/** Requests fired before any host mounted (queued until one listens). */
const pending: ImportRequest[] = [];

/** Ask the host to open the import modal. */
export function requestImport(request: ImportRequest = {}): void {
  if (listeners.size === 0) {
    pending.push(request);
    return;
  }
  for (const listener of listeners) listener(request);
}

/** Host-side subscription: returns the unsubscribe cleanup. */
export function subscribeImportRequests(listener: RequestListener): () => void {
  listeners.add(listener);
  // Drain anything requested before this host mounted.
  while (pending.length > 0) listener(pending.shift()!);
  return () => {
    listeners.delete(listener);
  };
}
