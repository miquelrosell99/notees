/**
 * InlineEditorKeysPlugin — Intercepts Enter, Backspace, Delete, Tab
 * inside InlineEditor and calls external callbacks for block-level actions.
 *
 * This replaces BlockList.onKeyDown for keys that need cursor-position
 * awareness. ArrowUp/ArrowDown navigation stays in BlockList.
 */

import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  KEY_ENTER_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  KEY_TAB_COMMAND,
  KEY_ESCAPE_COMMAND,
} from 'lexical';

// ─── Types ────────────────────────────────────────────────────────

export interface InlineEditorKeysPluginProps {
  /** Called on Enter (not Shift+Enter). */
  onEnter: () => void;
  /** Called on Backspace when cursor is at the start of the block. */
  onBackspaceAtStart: () => void;
  /** Called on Delete when cursor is at the end of the block. */
  onDeleteAtEnd: () => void;
  /** Called on Tab. */
  onTab: (shift: boolean) => void;
  /** Called on Escape (blur editor and select block). */
  onEscape?: () => void;
}

// ─── Plugin ───────────────────────────────────────────────────────

export function InlineEditorKeysPlugin({
  onEnter,
  onBackspaceAtStart,
  onDeleteAtEnd,
  onTab,
  onEscape,
}: InlineEditorKeysPluginProps): null {
  const [editor] = useLexicalComposerContext();

  // ─── Enter ──────────────────────────────────────────────────────

  useEffect(() => {
    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        if (event?.shiftKey) return false; // Let Shift+Enter insert line break
        onEnter();
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, onEnter]);

  // ─── Backspace ──────────────────────────────────────────────────

  useEffect(() => {
    return editor.registerCommand(
      KEY_BACKSPACE_COMMAND,
      (_event) => {
        let atStart = false;
        editor.getEditorState().read(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) return;
          if (selection.anchor.offset === 0 && selection.focus.offset === 0) {
            atStart = true;
          }
        });
        if (atStart) {
          onBackspaceAtStart();
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, onBackspaceAtStart]);

  // ─── Delete ─────────────────────────────────────────────────────

  useEffect(() => {
    return editor.registerCommand(
      KEY_DELETE_COMMAND,
      (_event) => {
        let atEnd = false;
        editor.getEditorState().read(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) return;
          const node = selection.anchor.getNode();
          const textLength = node.getTextContent().length;
          if (selection.anchor.offset >= textLength && selection.focus.offset >= textLength) {
            atEnd = true;
          }
        });
        if (atEnd) {
          onDeleteAtEnd();
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, onDeleteAtEnd]);

  // ─── Tab ────────────────────────────────────────────────────────

  useEffect(() => {
    return editor.registerCommand(
      KEY_TAB_COMMAND,
      (event) => {
        onTab(event?.shiftKey ?? false);
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, onTab]);

  // ─── Escape ─────────────────────────────────────────────────────

  useEffect(() => {
    return editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      (_event) => {
        const rootEl = editor.getRootElement();
        if (rootEl) {
          editor.blur();
          const activeEl = document.activeElement;
          if (activeEl && rootEl.contains(activeEl) && activeEl !== rootEl) {
            (activeEl as HTMLElement).blur();
          }
        }
        onEscape?.();
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, onEscape]);

  return null;
}
