/**
 * Editor barrel export.
 */

export { NoteesEditor } from './NoteesEditor';
export type { NoteesEditorProps } from './NoteesEditor';

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
  SlashCommandPlugin,
  FloatingToolbarPlugin,
} from './plugins';

// Theme
export { notesEditorTheme } from './theme';
