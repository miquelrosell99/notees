import type { WorkspaceStore } from '../store';
import type { NotifyChangeMessage } from '../worker/workerProtocol';

export interface GraphQuery<Input, Output> {
  /** Human-readable query name; used for worker dispatch and debugging. */
  readonly name: string;

  /** Stable cache key for the given input. */
  cacheKey(input: Input): string;

  /** Execute the query against the derived store. Must not hydrate children/properties unless required. */
  execute(store: WorkspaceStore, input: Input): Output;

  /**
   * Return true if this query should be re-executed when the worker emits a change.
   * This is the single place where invalidation rules live.
   */
  shouldInvalidate(input: Input, notification: NotifyChangeMessage): boolean;
}
