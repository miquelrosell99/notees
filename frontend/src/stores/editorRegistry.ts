/**
 * Editor Registry — holds references to active Lexical editors.
 *
 * Since the app uses a monolithic LexicalComposer per page (list/document mode)
 * and per-card editors in card mode, we need a way for page-level UI (like
 * find/replace) to access the primary editor instance.
 *
 * Only the "primary" editor (list/document view) registers itself here.
 * Per-card or per-cell editors do NOT register, to avoid conflicts.
 */

import { create } from 'zustand';
import type { LexicalEditor } from 'lexical';

interface EditorRegistryState {
  /** The primary page-level editor (list/document view) */
  primaryEditor: LexicalEditor | null;

  setPrimaryEditor: (editor: LexicalEditor | null) => void;
}

export const useEditorRegistry = create<EditorRegistryState>((set) => ({
  primaryEditor: null,
  setPrimaryEditor: (editor) => set({ primaryEditor: editor }),
}));
