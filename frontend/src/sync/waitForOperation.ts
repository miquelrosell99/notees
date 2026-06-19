/**
 * waitForOperation — small promise wrapper around OperationRuntime acknowledgement.
 *
 * Hooks that emit runtime intents but still expose a mutateAsync-style promise
 * can use this to resolve once the operation is acknowledged by SyncManager.
 */

import { getOperationRuntime } from '@/runtime';

const DEFAULT_TIMEOUT_MS = 30_000;

export function waitForOperationAck(operationId: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    const runtime = getOperationRuntime();
    const check = (): { done: boolean; error?: string } => {
      const operation = runtime.getOperations().find((op) => op.id === operationId);
      if (!operation || operation.state === 'acknowledged') {
        return { done: true };
      }
      if (operation.state === 'failed') {
        return { done: true, error: operation.error };
      }
      return { done: false };
    };

    const initial = check();
    if (initial.done) {
      if (initial.error) {
        reject(new Error(initial.error));
      } else {
        resolve();
      }
      return;
    }

    let unsubscribe: (() => void) | null = null;
    const timer = setTimeout(() => {
      if (unsubscribe) unsubscribe();
      reject(new Error(`Operation ${operationId} acknowledgement timed out`));
    }, timeoutMs);

    unsubscribe = runtime.subscribe(() => {
      const state = check();
      if (state.done) {
        clearTimeout(timer);
        if (unsubscribe) unsubscribe();
        if (state.error) {
          reject(new Error(state.error));
        } else {
          resolve();
        }
      }
    });
  });
}
