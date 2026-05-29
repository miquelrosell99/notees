/**
 * Global content-save tracker — shared between useContentSave and mutation hooks
 * so that mutations can await pending debounced saves before invalidating queries.
 *
 * Keeping this in a tiny standalone module breaks a would-be circular dependency:
 * useContentSave → useNodes → useNodeMutations, and useNodeMutations needs to
 * await saves.
 */

/** Set of flush functions registered by active useContentSave instances */
export const flushRegistry = new Set<() => void>();

/** Flush all pending content saves immediately (fire-and-forget). */
export function flushAllContentSaves(): void {
  for (const flush of flushRegistry) flush();
}

/** Pending save promises tracked globally so callers can await them. */
export const pendingSavePromises = new Set<Promise<void>>();

/**
 * Wait until all currently in-flight content saves have resolved.
 * Snapshots the set at call time, so saves that start after this
 * function is invoked are not awaited.
 */
export async function awaitAllContentSaves(): Promise<void> {
  if (pendingSavePromises.size === 0) return;
  const snapshot = Array.from(pendingSavePromises);
  await Promise.all(snapshot);
}
