/**
 * Hook that returns the async worker-backed workspace store client.
 *
 * This is the migration path away from the synchronous WorkspaceStore. New and
 * converted callers should use this instead of useWorkspaceStore.
 */

import { useContext, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { WorkspaceStoreContext } from './WorkspaceStoreContext';
import { getOrCreateWorkspaceStoreClient } from '../adapters/workspaceStoreClientAdapter';
import type { IWorkspaceStoreClient } from '../worker/WorkspaceStoreClient';

export interface UseWorkspaceStoreClientResult {
  client: IWorkspaceStoreClient | undefined;
  isLoading: boolean;
  error: Error | null;
}

export function useWorkspaceStoreClient(workspaceId?: string): UseWorkspaceStoreClientResult {
  const params = useParams<{ workspaceId?: string }>();
  const resolvedWorkspaceId = workspaceId ?? params.workspaceId;
  const ctx = useContext(WorkspaceStoreContext);

  const [result, setResult] = useState<UseWorkspaceStoreClientResult>({
    client: undefined,
    isLoading: !!ctx && !!resolvedWorkspaceId,
    error: null,
  });

  useEffect(() => {
    if (!ctx || !resolvedWorkspaceId) {
      setResult({ client: undefined, isLoading: false, error: null });
      return;
    }

    let cancelled = false;
    setResult((prev) => ({ ...prev, isLoading: true, error: null }));

    getOrCreateWorkspaceStoreClient(resolvedWorkspaceId, ctx.actorId, ctx.transport)
      .then((client) => {
        if (!cancelled) {
          setResult({ client, isLoading: false, error: null });
        }
      })
      .catch((err) => {
        if (!cancelled) {
          const error = err instanceof Error ? err : new Error(String(err));
          setResult({ client: undefined, isLoading: false, error });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [resolvedWorkspaceId, ctx]);

  return result;
}
