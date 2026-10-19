/**
 * The block editor feature — the editable mode of a block row (the
 * contentEditable prose surface, capture gestures, popups, and the
 * outliner keyboard contract; the full contract documents
 * BlockTextEditor.tsx). Second folder under `src/features/` (tree
 * realignment, 2026-10-19): moved verbatim from `ui/BlockTextEditor.tsx`
 * — a feature surface, not pure editor logic, so it does not join the
 * React-free `src/editor/` primitives it builds on.
 */

export { BlockTextEditor, SAVE_DEBOUNCE_MS } from "./BlockTextEditor.js";
export type { EditorCaret } from "./BlockTextEditor.js";
