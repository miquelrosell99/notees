/**
 * useWhiteboard save hook — debounced backend persistence
 */

import { useCallback, useRef } from 'react';
import type { WhiteboardData } from '@/types/whiteboard';
import { DEFAULT_WHITEBOARD_DATA } from '@/types/whiteboard';

const SAVE_DEBOUNCE_MS = 1000;

export function useWhiteboardSave(
  nodeId: number | null,
  titleRef: React.MutableRefObject<string>,
  mutateRef: React.MutableRefObject<any>,
) {
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const latestDataRef = useRef<WhiteboardData>(DEFAULT_WHITEBOARD_DATA);

  /** Serialize and fire the mutation immediately (no debounce). */
  const flushSave = useCallback((whiteboardData: WhiteboardData) => {
    if (!nodeId) return;
    const ast = [
      { type: 'paragraph' as const, children: [{ type: 'text' as const, text: titleRef.current }] },
      { type: 'whiteboard' as const, data: whiteboardData },
    ];
    const serialized = JSON.stringify(ast);
    mutateRef.current({ id: nodeId, data: { name: serialized } });
  }, [nodeId]);

  const saveToBackend = useCallback((newData: WhiteboardData) => {
    latestDataRef.current = newData;
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    saveTimeoutRef.current = setTimeout(() => {
      flushSave(newData);
      saveTimeoutRef.current = undefined;
    }, SAVE_DEBOUNCE_MS);
  }, [flushSave]);

  return { flushSave, saveToBackend, saveTimeoutRef, latestDataRef };
}
