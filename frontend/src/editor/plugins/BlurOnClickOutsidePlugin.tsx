/**
 * BlurOnClickOutsidePlugin — Blurs the editor when clicking outside.
 * 
 * When the user clicks anywhere outside the editor container,
 * this plugin blurs the editor to exit edit mode and clears
 * any block selection.
 * 
 * Interactive overlays (popups, menus, dialogs) should add the
 * `data-editor-companion` attribute to avoid triggering blur.
 */

import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { clearBlockSelection } from '../utils/selectionUtils';
import { setActiveEditor, clearActiveEditor } from '../activeEditorRegistry';

export interface BlurOnClickOutsidePluginProps {
  /** Whether the editor is in read-only mode */
  readOnly?: boolean;
}

export function BlurOnClickOutsidePlugin({
  readOnly = false,
}: BlurOnClickOutsidePluginProps): null {
  const [editor] = useLexicalComposerContext();

  // ─── Cross-editor coordination ──────────────────────────────
  // When this editor gains focus, blur the previously active editor.
  // This prevents dual-editor input when clicking between editors
  // (e.g., scratchpad → page editor).
  useEffect(() => {
    if (readOnly) return;

    const rootElement = editor.getRootElement();
    if (!rootElement) return;

    const onFocus = () => {
      setActiveEditor(editor);
      rootElement.spellcheck = true;
    };
    const onBlur = () => {
      clearActiveEditor(editor);
      rootElement.spellcheck = false;
    };

    rootElement.addEventListener('focus', onFocus, true);
    rootElement.addEventListener('blur', onBlur, true);

    return () => {
      rootElement.removeEventListener('focus', onFocus, true);
      rootElement.removeEventListener('blur', onBlur, true);
      clearActiveEditor(editor);
    };
  }, [editor, readOnly]);

  // ─── Click-outside blur ─────────────────────────────────────
  useEffect(() => {
    if (readOnly) return;

    const rootElement = editor.getRootElement();
    if (!rootElement) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      
      // Don't blur if clicking inside the editor itself
      if (rootElement.contains(target)) return;
      
      // Don't blur if clicking on a companion overlay (popup, menu, dialog)
      // Any interactive overlay should have data-editor-companion or [role="dialog"]/[role="menu"]
      if (
        target.closest('[data-editor-companion]') ||
        target.closest('[role="dialog"]') ||
        target.closest('[role="menu"]')
      ) return;
      
      // Blur editor and clear block selection
      editor.blur();
      const rootEl = editor.getRootElement();
      if (rootEl) clearBlockSelection(rootEl);
    };

    document.addEventListener('mousedown', handleClickOutside, true);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside, true);
    };
  }, [editor, readOnly]);

  return null;
}
