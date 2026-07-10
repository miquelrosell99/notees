/**
 * Public surface of the editor feature.
 *
 * Contains the Lexical inline editor, its plugins/nodes/theme, and the
 * debounced content-save hook. Cross-feature imports should prefer
 * `@/features/editor` (this barrel) over reaching into internal subdirectories.
 */

// Inline editor
export { CustomInlineEditor } from './custom/components/CustomInlineEditor';
export type { InlineEditorHandle } from './editor/types';

// Link editing UI
export { LinkEditModal, type LinkEditResult } from './editor/components/LinkEditModal';

// Content save hook + helpers
export {
  useContentSave,
  flushAllContentSaves,
  awaitAllContentSaves,
} from './hooks/useContentSave';

// Clipboard / block helpers used by the block editor
export { pasteBlocksAfterBlock } from './editor/utils/pasteBlocks';

// Companion UI detection shared by editor-adjacent features
export { isInsideEditorCompanion } from './custom/utils/editorCompanion';

// Re-export the internal editor barrel (nodes, plugins, theme, AST serializer)
export * from './editor';
