/**
 * InlineEditorKeysPlugin — Intercepts Enter, Backspace, Delete
 * inside InlineEditor and calls external callbacks for block-level actions.
 *
 * This replaces BlockList.onKeyDown for keys that need cursor-position
 * awareness. ArrowUp/ArrowDown navigation stays in BlockList.
 */

import { useCallback, useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_HIGH,
  KEY_ENTER_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  KEY_ESCAPE_COMMAND,
  INSERT_PARAGRAPH_COMMAND,
  DELETE_CHARACTER_COMMAND,
} from 'lexical';
import { useInputContext } from '@/stores/inputContext';

// ─── Types ────────────────────────────────────────────────────────

export interface InlineEditorKeysPluginProps {
  /** Called on Enter (not Shift+Enter). */
  onEnter?: () => void;
  /** Called on Ctrl+Enter (task cycle, etc.). */
  onCtrlEnter?: () => void;
  /** Called on Backspace when cursor is at the start of the block. */
  onBackspaceAtStart?: () => void;
  /** Called on Delete when cursor is at the end of the block. */
  onDeleteAtEnd?: () => void;
  /** Called on Escape (blur editor and select block). */
  onEscape?: () => void;
}

// ─── Plugin ───────────────────────────────────────────────────────

export function InlineEditorKeysPlugin({
  onEnter,
  onCtrlEnter,
  onBackspaceAtStart,
  onDeleteAtEnd,
  onEscape,
}: InlineEditorKeysPluginProps): null {
  const [editor] = useLexicalComposerContext();

  // ─── Enter ──────────────────────────────────────────────────────

  useEffect(() => {
    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        if (event?.ctrlKey || event?.metaKey) {
          if (onCtrlEnter) {
            onCtrlEnter();
            event?.preventDefault();
            return true;
          }
          return false;
        }
        if (event?.shiftKey) return false; // Let Shift+Enter insert line break
        if (onEnter) {
          event?.preventDefault();
          onEnter();
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, onEnter, onCtrlEnter]);

  // Fallback for Android soft keyboards that dispatch insertParagraph
  // via beforeinput instead of firing a keydown event.
  useEffect(() => {
    if (!onEnter) return;
    return editor.registerCommand(
      INSERT_PARAGRAPH_COMMAND,
      () => {
        onEnter();
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, onEnter]);

  // ─── Backspace ──────────────────────────────────────────────────

  const checkAtStart = useCallback(() => {
    let atStart = false;
    editor.getEditorState().read(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;
      if (selection.anchor.offset === 0 && selection.focus.offset === 0) {
        atStart = true;
      }
    });
    return atStart;
  }, [editor]);

  const checkAtEnd = useCallback(() => {
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
    return atEnd;
  }, [editor]);

  useEffect(() => {
    return editor.registerCommand(
      KEY_BACKSPACE_COMMAND,
      (_event) => {
        if (!onBackspaceAtStart) return false;
        if (checkAtStart()) {
          onBackspaceAtStart();
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, onBackspaceAtStart, checkAtStart]);

  // Fallback for Android soft keyboards that dispatch deleteCharacter
  // via beforeinput instead of firing a keydown event.
  useEffect(() => {
    if (!onBackspaceAtStart) return;
    return editor.registerCommand(
      DELETE_CHARACTER_COMMAND,
      (isBackward: boolean) => {
        if (!isBackward) return false;
        if (checkAtStart()) {
          onBackspaceAtStart();
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, onBackspaceAtStart, checkAtStart]);

  // ─── Delete ─────────────────────────────────────────────────────

  useEffect(() => {
    return editor.registerCommand(
      KEY_DELETE_COMMAND,
      (_event) => {
        if (!onDeleteAtEnd) return false;
        if (checkAtEnd()) {
          onDeleteAtEnd();
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, onDeleteAtEnd, checkAtEnd]);

  // Fallback for Android soft keyboards and other input methods that
  // dispatch deleteCharacter forward via beforeinput.
  useEffect(() => {
    if (!onDeleteAtEnd) return;
    return editor.registerCommand(
      DELETE_CHARACTER_COMMAND,
      (isBackward: boolean) => {
        if (isBackward) return false;
        if (checkAtEnd()) {
          onDeleteAtEnd();
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, onDeleteAtEnd, checkAtEnd]);

  // ─── Escape ─────────────────────────────────────────────────────

  useEffect(() => {
    return editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      (_event) => {
        // Let popups/menus handle Escape when they are open
        if (useInputContext.getState().isOverlayOpen) {
          return false;
        }
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
