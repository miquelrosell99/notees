/**
 * Inline Editor Registry — tracks all active per-block Lexical editors.
 *
 * Since the new architecture uses one LexicalComposer per block,
 * page-level features like find/replace need a way to discover and
 * operate on all editors in the current view.
 */

import { create } from 'zustand';
import type { LexicalEditor } from 'lexical';

interface InlineEditorRegistryState {
  /** Map of block UUID -> LexicalEditor instance */
  editors: Map<string, LexicalEditor>;

  register: (blockId: string, editor: LexicalEditor) => void;
  unregister: (blockId: string) => void;
  getEditor: (blockId: string) => LexicalEditor | undefined;
  getAllEditors: () => IterableIterator<[string, LexicalEditor]>;
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
