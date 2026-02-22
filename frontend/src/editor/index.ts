/**
 * Editor barrel export.
 */

export { BlockEditor } from './BlockEditor';
export { EDITOR_NODES, serializeContentAST } from './editorConfig';
export type { BlockEditorProps, EditorMode } from './BlockEditor';

// Nodes
export {
  BlockNode,
  $createBlockNode,
  $isBlockNode,
  InlineLinkNode,
  $createInlineLinkNode,
  $isInlineLinkNode,
  BlockHeadingNode,
  $createBlockHeadingNode,
  $isBlockHeadingNode,
  BlockCodeNode,
  $createBlockCodeNode,
  $isBlockCodeNode,
  BlockTableCellNode,
  $createBlockTableCellNode,
  $isBlockTableCellNode,
} from './nodes';

// Plugins
export {
  BlockPlugin,
  NodeLinkPlugin,
  DragDropPlugin,
  SelectionPlugin,
  CollapsePlugin,
  FormattingPlugin,
  TriggerPlugin,
  FloatingToolbarPlugin,
  ContextMenuPlugin,
} from './plugins';

// Theme
export { notesEditorTheme } from './theme';
