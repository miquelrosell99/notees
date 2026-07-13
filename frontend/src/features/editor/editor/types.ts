/**
 * Shared editor types for the inline editor.
 */

export type InlineLinkRefType = 'node' | 'class' | 'url' | 'embed' | 'broken' | 'user';

export interface InlineEditorHandle {
  /** Focus the editor. */
  focus: () => void;
  /** Blur the editor. */
  blur: () => void;
  /** Get cursor position category relative to the block content. */
  getCursorPosition: () => 'start' | 'end' | 'middle' | 'empty';
  /** Get exact cursor offset (anchor offset) for split_block intent. */
  getCursorOffset: () => number;
  /** Plain-text content of the block (atomic nodes do not contribute text). */
  getText: () => string;
  /** Replace the logical text range [start, end) with `text`. */
  replaceRange: (start: number, end: number, text: string) => void;
  /** Select the logical text range [start, end). */
  selectRange: (start: number, end: number) => void;
  /** Scroll the block into view. */
  scrollIntoView: () => void;
}
