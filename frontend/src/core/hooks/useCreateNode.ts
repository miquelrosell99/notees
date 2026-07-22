import { useCallback, useState } from 'react';
import { useUndoManager } from './useUndoManager';

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
  const manager = useUndoManager(workspaceId);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const mutateAsync = useCallback(
    async (args: CreateNodeArgs): Promise<void> => {
      if (!manager) throw new Error('Workspace store client is not ready');
      setIsPending(true);
      setError(null);
      try {
        await manager.createNode(args);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        throw error;
      } finally {
        setIsPending(false);
      }
    },
    [manager]
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
