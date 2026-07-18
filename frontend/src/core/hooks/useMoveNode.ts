import { useCallback, useState } from 'react';
import { useWorkspaceStore } from './useWorkspaceStore';

export interface UseMoveNodeResult {
  mutate: (
    args: { nodeId: string; newParentId: string | null },
    options?: { onSuccess?: () => void; onError?: (error: Error) => void }
  ) => void;
  mutateAsync: (args: { nodeId: string; newParentId: string | null }) => Promise<void>;
  isPending: boolean;
  error: Error | null;
}

export function useMoveNode(workspaceId: string): UseMoveNodeResult {
  const { store } = useWorkspaceStore(workspaceId);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const mutateAsync = useCallback(
    async (args: { nodeId: string; newParentId: string | null }): Promise<void> => {
      if (!store) throw new Error('Workspace store is not ready');
      setIsPending(true);
      setError(null);
      try {
        store.moveNode(args.nodeId, args.newParentId);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        throw error;
      } finally {
        setIsPending(false);
      }
    },
    [store]
  );

  const mutate = useCallback(
    (
      args: { nodeId: string; newParentId: string | null },
      options?: { onSuccess?: () => void; onError?: (error: Error) => void }
    ): void => {
      mutateAsync(args)
        .then(() => options?.onSuccess?.())
        .catch((err) => options?.onError?.(err instanceof Error ? err : new Error(String(err))));
    },
    [mutateAsync]
  );

  return { mutate, mutateAsync, isPending, error };
}
