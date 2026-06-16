/**
 * Global OperationRuntime singleton.
 *
 * The runtime is a pure derived-state engine shared across the app.
 * SyncManager is the only layer that persists operations.
 */

import { OperationRuntime } from './OperationRuntime';

let instance: OperationRuntime | null = null;

export function getOperationRuntime(): OperationRuntime {
  if (!instance) {
    instance = new OperationRuntime();
  }
  return instance;
}

/**
 * Replace the global runtime instance. Useful for tests.
 */
export function setOperationRuntime(runtime: OperationRuntime | null): void {
  instance = runtime;
}
