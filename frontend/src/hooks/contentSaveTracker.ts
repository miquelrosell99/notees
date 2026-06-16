/**
 * Global content-save tracker — shared between useContentSave and mutation hooks
 * so that structural mutations can flush pending debounced saves before running.
 *
 * In the new architecture pending saves are operations in OperationRuntime.
 * This module keeps the same public contract but delegates to the runtime.
 */

import { getOperationRuntime } from '@/runtime';

/** Set of flush functions registered by active useContentSave instances */
export const flushRegistry = new Set<() => void>();

/** Flush all pending content saves immediately (fire-and-forget). */
export function flushAllContentSaves(): void {
  for (const flush of flushRegistry) flush();
}

/**
 * Wait until the runtime has no pending or in-flight content operations.
 * Operations that start after this function is invoked are not awaited.
 *
 * A timeout prevents hanging when the device is offline or the sync pipe is
 * stalled. Callers should still proceed after the timeout.
 */
export async function awaitAllContentSaves(timeoutMs = 3000): Promise<void> {
  const runtime = getOperationRuntime();
  const start = Date.now();

  while (true) {
    const pending = runtime.getPendingOperations().length + runtime.getInFlightOperations().length;
    if (pending === 0) return;
    if (Date.now() - start > timeoutMs) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
