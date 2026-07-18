import { useCallback, useState } from 'react';
import type { TextCrdt } from '../crdt/text';
import { useWorkspaceStore } from './useWorkspaceStore';
import { useUndoManager } from './useUndoManager';

export interface UseUpdateTextResult {
  mutate: (
    args: { nodeId: string; editor: (text: TextCrdt) => void },
    options?: { onSuccess?: () => void; onError?: (error: Error) => void }
  ) => void;
  mutateAsync: (args: { nodeId: string; editor: (text: TextCrdt) => void }) => Promise<void>;
  isPending: boolean;
  error: Error | null;
}

export function useUpdateText(workspaceId: string): UseUpdateTextResult {
  const { store } = useWorkspaceStore(workspaceId);
  const manager = useUndoManager(workspaceId);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const mutateAsync = useCallback(
    async (args: { nodeId: string; editor: (text: TextCrdt) => void }): Promise<void> => {
      if (!store) throw new Error('Workspace store is not ready');
      setIsPending(true);
      setError(null);
      try {
        if (manager) {
          manager.updateText(args.nodeId, args.editor);
        } else {
          store.updateText(args.nodeId, args.editor);
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        setError(error);
        throw error;
      } finally {
        setIsPending(false);
      }
    },
    [store, manager]
  );

  const mutate = useCallback(
    (
      args: { nodeId: string; editor: (text: TextCrdt) => void },
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
