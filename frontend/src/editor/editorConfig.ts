/**
 * Editor configuration — node registry and serialization helpers.
 *
 * Split from BlockEditor.tsx so that BlockEditor only exports React
 * components, enabling Vite Fast Refresh (HMR).  Exporting non-component
 * values from a component file forces full module invalidation, which
 * breaks Lexical's node-type registry and causes
 * "Type inline-link … does not match registered node" errors.
 */

/**
 * Plugin dependency map — describes which plugins interact or depend on others.
 * Breaking changes during plugin modification often stem from missing this context.
 *
 * FOUNDATIONAL (must be mounted before any plugin that depends on them):
 *   BlockPlugin       — provides BlockNode structure; all block-aware plugins depend on it
 *   EditablePlugin    — controls Lexical readonly state; must precede any plugin that checks editable
 *   RichTextPlugin    — Lexical core text editing; FormattingPlugin depends on it
 *
 * SELECTION CHAIN (load order matters — each depends on the previous):
 *   SelectionPlugin            — tracks selected block IDs in store; no upstream deps
 *   DragDropPlugin             — depends on SelectionPlugin (reads/writes selection on drag)
 *   BlockDragSelectionPlugin   — depends on SelectionPlugin (Logseq-style vertical drag)
 *   KeyboardSelectionPlugin    — depends on SelectionPlugin + DragDropPlugin
 *   SelectionConstraintPlugin  — depends on SelectionPlugin (restricts selection to active block)
 *   FloatingToolbarPlugin      — depends on SelectionPlugin (appears on text selection)
 *
 * BLOCK CONTENT (all depend on BlockPlugin):
 *   NodeLinkPlugin      — renders pill nodes inside blocks, needs block ID context
 *   CollapsePlugin      — toggles BlockNode collapse state
 *   ThreadLinePlugin    — visual guide line, positions relative to BlockNode
 *   AutoWrapPlugin      — wraps orphaned content into a BlockNode
 *   TaskCyclePlugin     — cycles task status on BlockNode
 *   PasteBlocksPlugin   — creates block hierarchy on paste
 *   TriggerPlugin       — /@ # triggers; needs block ID for positioning popups
 *   CreateLinkPlugin    — depends on NodeLinkPlugin (inserts an InlineLinkNode)
 *   CustomCaretPlugin   — depends on EditablePlugin (caret override only when editable)
 *
 * FORMATTING:
 *   FormattingPlugin  — depends on RichTextPlugin
 *   InlineCodePlugin  — depends on FormattingPlugin (extends inline formatting)
 *
 * VIRTUALIZATION (VirtualizationPlugin must wrap all portal/expensive plugins):
 *   VirtualizationPlugin wraps (activated after viewport measurement):
 *     BlockClassPillsPlugin    — renders class badge pills; uses BlockPlugin node IDs
 *     BlockPropertyIconsPlugin — page-level property index, zero per-block queries
 *     BlockPropertiesPlugin    — inline property rows rendered below blocks
 *     AssetBlockPlugin         — image/audio/file previews on asset-class blocks
 *     AssetLinkImagePlugin     — inline asset-link image previews
 *     TableBlockPlugin         — table element on table-class blocks
 *     QueryBlockPlugin         — query result list on query-class blocks
 *     BlockCodePlugin          — syntax-highlighted line numbers on code blocks
 *     EmbedBlockPlugin         — embedded node card previews
 */

import { BlockNode } from './nodes/BlockNode';
import { InlineLinkNode } from './nodes/InlineLinkNode';
import { BlockHeadingNode } from './nodes/BlockHeadingNode';
import { BlockCodeNode } from './nodes/BlockCodeNode';
import { BlockTableCellNode } from './nodes/BlockTableCellNode';
import type { ContentAST } from '../runtime/types';

// ─── Lexical node registry (shared between List and Card editors) ─

export const EDITOR_NODES = [
  BlockNode,
  InlineLinkNode,
  BlockHeadingNode,
  BlockCodeNode,
  BlockTableCellNode,
];

/**
 * Serialize a ContentAST to a JSON string suitable for API persistence.
 *
 * The `name` column in the database stores the full AST as JSON —
 * NOT plain text — so we must preserve every formatting mark,
 * node-link, and structural node.
 */
export function serializeContentAST(contentAST: ContentAST): string {
  return JSON.stringify(contentAST);
}
