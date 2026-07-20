import { useContext, useEffect, useState } from 'react';
import { getOrCreateWorkspaceStore } from '../adapters/workspaceStoreAdapter';
import type { WorkspaceStore } from '../store';
import { WorkspaceStoreContext } from './WorkspaceStoreContext';

export interface UseWorkspaceStoreResult {
  store: WorkspaceStore | undefined;
  isLoading: boolean;
  error: Error | null;
}

export function useWorkspaceStore(workspaceId: string): UseWorkspaceStoreResult {
  const ctx = useContext(WorkspaceStoreContext);
  const actorId = ctx?.actorId;
  const transport = ctx?.transport;

  const [result, setResult] = useState<UseWorkspaceStoreResult>({
    store: undefined,
    isLoading: !!ctx && !!workspaceId,
    error: null,
  });

  useEffect(() => {
    if (!ctx || !workspaceId) {
      setResult({ store: undefined, isLoading: false, error: null });
      return;
    }

    let cancelled = false;
    setResult({ store: undefined, isLoading: true, error: null });

    getOrCreateWorkspaceStore(workspaceId, ctx.actorId, ctx.transport)
      .then((store) => {
        if (!cancelled) {
          setResult({ store, isLoading: false, error: null });
        }
      })
      .catch((err) => {
        if (!cancelled) {
          const error = err instanceof Error ? err : new Error(String(err));
          setResult({ store: undefined, isLoading: false, error });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [workspaceId, ctx, actorId, transport]);

  return result;
}
