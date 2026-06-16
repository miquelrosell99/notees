/**
 * useUndoStackPersistence — Persist runtime undo/redo stacks to IndexedDB.
 *
 * Listens to undo engine undo_stack_changed events and debounces saves so rapid
 * edits don't hammer IndexedDB.
 */

import { useEffect } from 'react';
import { getUndoEngine } from '@/stores/undoEngine';
import { saveUndoStacks } from '@/lib/undoStackStorage';

const SAVE_DEBOUNCE_MS = 500;

export function useUndoStackPersistence(): void {
  useEffect(() => {
    const engine = getUndoEngine();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const unsubscribe = engine.subscribe((event) => {
      if (event.type !== 'undo_stack_changed') return;
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = null;
        const { undo, redo } = engine.serializeUndoStacks();
        saveUndoStacks(undo, redo);
      }, SAVE_DEBOUNCE_MS);
    });

    return () => {
      unsubscribe();
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, []);
}
