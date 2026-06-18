/**
 * useWhiteboard history hook — undo/redo stack
 */

import { useCallback, useRef } from 'react';
import type { WhiteboardElement, WhiteboardGroup, WhiteboardHistoryEntry, WhiteboardData } from '@/features/whiteboard/types/whiteboard';

const MAX_HISTORY = 50;

export function useWhiteboardHistory(
  setData: React.Dispatch<React.SetStateAction<WhiteboardData>>,
  saveToBackend: (data: WhiteboardData) => void,
) {
  const historyRef = useRef<WhiteboardHistoryEntry[]>([]);
  const historyIndexRef = useRef(-1);

  const pushHistory = useCallback((elements: WhiteboardElement[], groups: WhiteboardGroup[]) => {
    const history = historyRef.current;
    const idx = historyIndexRef.current;

    history.splice(idx + 1);
    history.push({ elements: structuredClone(elements), groups: structuredClone(groups), timestamp: Date.now() });

    if (history.length > MAX_HISTORY) {
      history.shift();
    }

    historyIndexRef.current = history.length - 1;
  }, []);

  const undo = useCallback(() => {
    const idx = historyIndexRef.current;
    if (idx > 0) {
      historyIndexRef.current = idx - 1;
      const entry = historyRef.current[idx - 1];
      setData(prev => {
        const newData = { ...prev, elements: structuredClone(entry.elements), groups: structuredClone(entry.groups) };
        saveToBackend(newData);
        return newData;
      });
    }
  }, [saveToBackend, setData]);

  const redo = useCallback(() => {
    const history = historyRef.current;
    const idx = historyIndexRef.current;
    if (idx < history.length - 1) {
      historyIndexRef.current = idx + 1;
      const entry = history[idx + 1];
      setData(prev => {
        const newData = { ...prev, elements: structuredClone(entry.elements), groups: structuredClone(entry.groups) };
        saveToBackend(newData);
        return newData;
      });
    }
  }, [saveToBackend, setData]);

  return { historyRef, historyIndexRef, pushHistory, undo, redo };
}
