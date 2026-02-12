/**
 * Editor barrel export.
 */

export { BlockEditor, EDITOR_NODES, serializeContentAST } from './BlockEditor';
export type { BlockEditorProps, EditorMode } from './BlockEditor';

// Nodes
export {
  BlockNode,
  $createBlockNode,
  $isBlockNode,
  PillNode,
  $createPillNode,
  $isPillNode,
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
  PillPlugin,
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
