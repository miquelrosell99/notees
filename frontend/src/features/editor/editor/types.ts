/**
 * Shared editor types used by both the legacy Lexical InlineEditor and the
 * new custom inline editor.
 */

export interface InlineEditorHandle {
  /** Focus the editor. */
  focus: () => void;
  /** Blur the editor. */
  blur: () => void;
  /** Get cursor position category relative to the block content. */
  getCursorPosition: () => 'start' | 'end' | 'middle' | 'empty';
  /** Get exact cursor offset (anchor offset) for split_block intent. */
  getCursorOffset: () => number;
}
