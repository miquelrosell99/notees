/**
 * Editor barrel export.
 */

export { BlockEditor, EDITOR_NODES, serializeContentAST } from './BlockEditor';
export type { BlockEditorProps, EditorMode } from './BlockEditor';

export { NodeCard } from './CardItem';
export type { NodeCardProps } from './CardItem';

export { CardModeView } from './CardModeView';

// Nodes
export {
  NodeBlockNode,
  $createNodeBlockNode,
  $isNodeBlockNode,
  NodePillNode,
  $createNodePillNode,
  $isNodePillNode,
  NodeBlockHeadingNode,
  $createNodeBlockHeadingNode,
  $isNodeBlockHeadingNode,
  NodeBlockCodeNode,
  $createNodeBlockCodeNode,
  $isNodeBlockCodeNode,
  NodeBlockTableCellNode,
  $createNodeBlockTableCellNode,
  $isNodeBlockTableCellNode,
} from './nodes';

// Plugins
export {
  NodeBlockPlugin,
  NodePillPlugin,
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
