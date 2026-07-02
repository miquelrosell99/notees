/**
 * Inline Editor Registry — tracks all active per-block custom inline editors.
 *
 * Page-level features like find/replace discover and operate on editors
 * through this registry.
 */

import { create } from 'zustand';
import type { InlineEditorHandle } from '@/features/editor/editor/types';

interface InlineEditorRegistryState {
  /** Map of block UUID -> custom inline editor handle */
  editors: Map<string, InlineEditorHandle>;

  register: (blockId: string, editor: InlineEditorHandle) => void;
  unregister: (blockId: string) => void;
  getEditor: (blockId: string) => InlineEditorHandle | undefined;
  getAllEditors: () => IterableIterator<[string, InlineEditorHandle]>;
}

export const useInlineEditorRegistry = create<InlineEditorRegistryState>((set, get) => ({
  editors: new Map(),

  register: (blockId, editor) => {
    set((state) => {
      const next = new Map(state.editors);
      next.set(blockId, editor);
      return { editors: next };
    });
  },

  unregister: (blockId) => {
    set((state) => {
      const next = new Map(state.editors);
      next.delete(blockId);
      return { editors: next };
    });
  },

  getEditor: (blockId) => get().editors.get(blockId),

  getAllEditors: () => get().editors.entries(),
}));
