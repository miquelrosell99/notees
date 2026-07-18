import { useCallback, useState } from 'react';
import { useWorkspaceStore } from './useWorkspaceStore';

export interface UseDeleteNodeResult {
  mutate: (args: { nodeId: string }, options?: { onSuccess?: () => void; onError?: (error: Error) => void }) => void;
  mutateAsync: (args: { nodeId: string }) => Promise<void>;
  isPending: boolean;
  error: Error | null;
}

export function useDeleteNode(workspaceId: string): UseDeleteNodeResult {
  const { store } = useWorkspaceStore(workspaceId);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const mutateAsync = useCallback(
    async (args: { nodeId: string }): Promise<void> => {
      if (!store) throw new Error('Workspace store is not ready');
      setIsPending(true);
      setError(null);
      try {
        store.deleteNode(args.nodeId);
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
    (args: { nodeId: string }, options?: { onSuccess?: () => void; onError?: (error: Error) => void }): void => {
      mutateAsync(args)
        .then(() => options?.onSuccess?.())
        .catch((err) => options?.onError?.(err instanceof Error ? err : new Error(String(err))));
    },
    [mutateAsync]
  );

  return { mutate, mutateAsync, isPending, error };
}
