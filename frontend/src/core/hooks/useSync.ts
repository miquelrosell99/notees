import { useCallback, useEffect, useState } from 'react';
import { getWorkspaceSyncEngine } from '../adapters/workspaceStoreAdapter';
import type { SyncStatus } from '../sync';

export interface UseSyncResult {
  status: SyncStatus;
  lastError: Error | null;
  sync: () => Promise<void>;
}

export function useSync(workspaceId: string): UseSyncResult {
  const [status, setStatus] = useState<SyncStatus>('idle');
  const [lastError, setLastError] = useState<Error | null>(null);

  useEffect(() => {
    const syncEngine = getWorkspaceSyncEngine(workspaceId);
    if (!syncEngine) {
      setStatus('idle');
      return;
    }
    return syncEngine.subscribeStatus((newStatus, error) => {
      setStatus(newStatus);
      if (error) setLastError(error);
    });
  }, [workspaceId]);

  const sync = useCallback(async (): Promise<void> => {
    const syncEngine = getWorkspaceSyncEngine(workspaceId);
    if (!syncEngine) {
      throw new Error(`Workspace ${workspaceId} is not open`);
    }
    await syncEngine.syncOnce();
  }, [workspaceId]);

  return { status, lastError, sync };
}
