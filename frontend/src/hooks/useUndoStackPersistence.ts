/**
 * useUndoStackPersistence — Persist runtime undo/redo stacks to IndexedDB.
 *
 * Listens to runtime undo_stack_changed events and debounces saves so rapid
 * edits don't hammer IndexedDB.
 */

import { useEffect } from 'react';
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import { saveUndoStacks } from '@/lib/undoStackStorage';

const SAVE_DEBOUNCE_MS = 500;

export function useUndoStackPersistence(): void {
  useEffect(() => {
    const runtime = getNodeGraphRuntime();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const unsubscribe = runtime.subscribe((event) => {
      if (event.type !== 'undo_stack_changed') return;
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = null;
        const { undo, redo } = runtime.serializeUndoStacks();
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
