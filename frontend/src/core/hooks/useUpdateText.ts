import { useCallback, useState } from 'react';
import { TextCrdt } from '../crdt/text';
import type { TextCrdt as TextCrdtType } from '../crdt/text';
import { useWorkspaceStore } from './useWorkspaceStore';
import { useUndoManager } from './useUndoManager';

export interface UseUpdateTextResult {
  mutate: (
    args: { nodeId: string; editor: (text: TextCrdtType) => void },
    options?: { onSuccess?: () => void; onError?: (error: Error) => void }
  ) => void;
  mutateAsync: (args: { nodeId: string; editor: (text: TextCrdtType) => void }) => Promise<void>;
  isPending: boolean;
  error: Error | null;
}

export function useUpdateText(workspaceId: string): UseUpdateTextResult {
  const { store } = useWorkspaceStore(workspaceId);
  const manager = useUndoManager(workspaceId);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const mutateAsync = useCallback(
    async (args: { nodeId: string; editor: (text: TextCrdtType) => void }): Promise<void> => {
      if (!store) throw new Error('Workspace store is not ready');
      setIsPending(true);
      setError(null);
      try {
        if (manager) {
          const currentState = store.getTextState(args.nodeId);
          const text = new TextCrdt(currentState);
          args.editor(text);
          await manager.recordSetNodeText(args.nodeId, text.toPlaintext());
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
      args: { nodeId: string; editor: (text: TextCrdtType) => void },
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
