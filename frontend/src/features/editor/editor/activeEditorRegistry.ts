/**
 * ActiveEditorRegistry — ensures only one Lexical editor is active at a time.
 *
 * When an editor gains focus, the previously active editor is blurred first.
 * This prevents dual-editor input bugs where keystrokes are split between
 * two editors (e.g., scratchpad + page editor).
 */

import { FORMAT_TEXT_COMMAND, type LexicalEditor, type TextFormatType } from 'lexical';

let activeEditor: LexicalEditor | null = null;

/**
 * Called when an editor gains focus. Blurs the previously active editor
 * if it's a different instance.
 */
export function setActiveEditor(editor: LexicalEditor): void {
  if (activeEditor && activeEditor !== editor) {
    activeEditor.blur();
  }
  activeEditor = editor;
}

/**
 * Called when an editor blurs. Clears the registry if this editor
 * was the active one.
 */
export function clearActiveEditor(editor: LexicalEditor): void {
  if (activeEditor === editor) {
    activeEditor = null;
  }
}

/**
 * Returns true if a different editor instance currently has focus.
 * Used to prevent programmatic focus calls from stealing focus
 * when the user has already clicked into another editor.
 */
export function isOtherEditorActive(editor: LexicalEditor): boolean {
  return activeEditor !== null && activeEditor !== editor;
}

/**
 * Returns the currently focused editor, or null if no editor is active.
 */
export function getActiveEditor(): LexicalEditor | null {
  return activeEditor;
}

/**
 * Dispatch a text-format command on the currently focused editor.
 * Safe to call from native mobile toolbars via the JS bridge.
 */
export function applyFormatToActiveEditor(format: TextFormatType): boolean {
  if (!activeEditor) return false;
  activeEditor.dispatchCommand(FORMAT_TEXT_COMMAND, format);
  return true;
}
