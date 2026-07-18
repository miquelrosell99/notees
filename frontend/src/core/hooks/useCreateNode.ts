import { useCallback, useState } from 'react';
import { useWorkspaceStore } from './useWorkspaceStore';

export interface CreateNodeArgs {
  nodeId: string;
  kind: 'page' | 'block' | 'class';
  parentId: string | null;
  classIds?: string[];
}

export interface UseCreateNodeResult {
  mutate: (args: CreateNodeArgs, options?: { onSuccess?: () => void; onError?: (error: Error) => void }) => void;
  mutateAsync: (args: CreateNodeArgs) => Promise<void>;
  isPending: boolean;
  error: Error | null;
}

export function useCreateNode(workspaceId: string): UseCreateNodeResult {
  const { store } = useWorkspaceStore(workspaceId);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const mutateAsync = useCallback(
    async (args: CreateNodeArgs): Promise<void> => {
      if (!store) throw new Error('Workspace store is not ready');
      setIsPending(true);
      setError(null);
      try {
        store.createNode(args);
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
    (args: CreateNodeArgs, options?: { onSuccess?: () => void; onError?: (error: Error) => void }): void => {
      mutateAsync(args)
        .then(() => options?.onSuccess?.())
        .catch((err) => options?.onError?.(err instanceof Error ? err : new Error(String(err))));
    },
    [mutateAsync]
  );

  return { mutate, mutateAsync, isPending, error };
}
