/**
 * useBlockPersist utilities — legacy singleton state.
 *
 * Only `inFlightBlocks` remains in use (by useCreateNode). The rest of the
 * block-persist coordination has been replaced by OperationRuntime + SyncManager.
 */

export function isRetryableError(error: unknown): boolean {
  const axiosError = error as { response?: { status?: number }; message?: string };
  const status = axiosError.response?.status;
  return status == null || status >= 500;
}

// ─── Singleton coordinator ────────────────────────────────────────

class BlockPersistCoordinator {
  inFlightBlocks = new Set<string>();

  reset(): void {
    this.inFlightBlocks.clear();
  }
}

/** Singleton coordinator for cross-instance block persist state */
export const coordinator = new BlockPersistCoordinator();

// Convenience re-export (stable reference)
export const inFlightBlocks = coordinator.inFlightBlocks;
