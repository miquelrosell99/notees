/**
 * NoteesEditor — Single Lexical editor for List Mode and Document Mode.
 *
 * This component renders ONE Lexical editor instance that projects
 * the entire block hierarchy from NodeGraphRuntime as a flat list
 * of NodeBlockNodes with depth metadata for indentation.
 *
 * Used by:
 * - List Mode: full hierarchy with bullets, indent, collapse
 * - Document Mode: same hierarchy, bullets hidden via CSS
 *
 * NOT used for Card Mode — see CardModeView for per-card editors.
 */

import { useCallback, useMemo, useId, type JSX } from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';

import { notesEditorTheme } from './theme';
import { NodeBlockNode } from './nodes/NodeBlockNode';
import { NodePillNode } from './nodes/NodePillNode';
import { NodeBlockHeadingNode } from './nodes/NodeBlockHeadingNode';
import { NodeBlockCodeNode } from './nodes/NodeBlockCodeNode';
import { NodeBlockTableCellNode } from './nodes/NodeBlockTableCellNode';

import { NodeBlockPlugin } from './plugins/NodeBlockPlugin';
import { NodePillPlugin } from './plugins/NodePillPlugin';
import { DragDropPlugin } from './plugins/DragDropPlugin';
import { BlockDragSelectionPlugin } from './plugins/BlockDragSelectionPlugin';
import { KeyboardSelectionPlugin } from './plugins/KeyboardSelectionPlugin';
import { SelectionPlugin } from './plugins/SelectionPlugin';
import { CollapsePlugin } from './plugins/CollapsePlugin';
import { FormattingPlugin } from './plugins/FormattingPlugin';
import { SlashCommandPlugin, type TriggerType } from './plugins/SlashCommandPlugin';
import { FloatingToolbarPlugin } from './plugins/FloatingToolbarPlugin';
import { ContextMenuPlugin } from './plugins/ContextMenuPlugin';
import { BlurOnClickOutsidePlugin } from './plugins/BlurOnClickOutsidePlugin';

import { getNodeGraphRuntime } from '../runtime/NodeGraphRuntime';
import { apiNodesToGraphNodes } from '../hooks/useRuntimeSync';
import { useStructureSync } from '../hooks/useStructureSync';
import { useBlockPersist } from '../hooks/useBlockPersist';
import type { ContentAST } from '../runtime/types';
import type { Node } from '../types/api';

import './NoteesEditor.css';

// ─── Lexical node registry (shared between List and Card editors) ─

export const EDITOR_NODES = [
  NodeBlockNode,
  NodePillNode,
  NodeBlockHeadingNode,
  NodeBlockCodeNode,
  NodeBlockTableCellNode,
];

// ─── Props ────────────────────────────────────────────────────────

export type EditorMode = 'list' | 'document';

export interface NoteesEditorProps {
  /** Unique editor instance ID */
  editorId?: string;
  /** 
   * Nodes to display - primary input for query-driven views.
   * When pageId/pageUuid are also provided, uses the real page as root.
   * Otherwise falls back to a virtual root.
   */
  nodes?: Node[];
  /**
   * Root block ID - alternative to nodes[] for runtime-managed scenarios.
   * If both nodes and rootBlockId provided, nodes takes precedence.
   */
  rootBlockId?: string;
  /** Server ID of the parent page (used with nodes[] to avoid virtual root) */
  pageId?: number;
  /** UUID of the parent page (used with nodes[] to avoid virtual root) */
  pageUuid?: string;
  /** Editor mode: 'list' (bullets + indent) or 'document' (prose) */
  mode?: EditorMode;
  /** Read-only mode */
  readOnly?: boolean;
  /** Called when a node pill is clicked */
  onNavigateToNode?: (linkId: string) => void;
  /** Called when bullet is shift+clicked (for sidebar) */
  onOpenInSidebar?: (blockId: string) => void;
  /** Called on escape */
  onEscape?: () => void;
  /** Called when selection changes (block IDs) */
  onSelectionChange?: (blockIds: string[]) => void;
  /** Custom trigger popup renderer */
  renderTriggerPopup?: (state: {
    type: TriggerType;
    query: string;
    position: { top: number; left: number };
    onSelect: (value: string, metadata?: any) => void;
    onClose: () => void;
  }) => JSX.Element | null;
  /** Called when any block's content changes (for API persistence) */
  onContentChange?: (blockId: string, content: string) => void;
  /** Custom class name */
  className?: string;
  /** Placeholder text */
  placeholder?: string;
  /** Whether to include the root block itself in projection (default: false) */
  includeRoot?: boolean;
  /** Maximum depth to project (-1 = unlimited, default: -1) */
  maxDepth?: number;
  /** Slice projection: block IDs to project (overrides tree-based projection) */
  sliceBlockIds?: string[];
  /** Slice projection: how many levels of children to expand (-1 = unlimited) */
  sliceRecursiveLevel?: number;
  /** Slice projection: whether to show parent nodes as locked projection roots */
  sliceShowParent?: boolean;
  /** Structural guard — return false to prevent indent */
  canIndent?: (blockId: string) => boolean;
  /** Structural guard — return false to prevent outdent */
  canOutdent?: (blockId: string) => boolean;
  /** Structural guard — return false to prevent merge */
  canMerge?: (sourceBlockId: string, targetBlockId: string) => boolean;
  /** Structural guard — return false to prevent delete */
  canDelete?: (blockId: string) => boolean;
}

// ─── Shared content serializer ────────────────────────────────────

export function serializeContentAST(contentAST: ContentAST): string {
  return contentAST
    .map(node => {
      if ('text' in node) return node.text;
      if ('children' in node) return node.children.map((c: any) => c.text ?? '').join('');
      return '';
    })
    .join('\n');
}

// ─── Component ────────────────────────────────────────────────────

export function NoteesEditor({
  editorId: externalEditorId,
  nodes,
  rootBlockId: externalRootBlockId,
  pageId,
  pageUuid,
  mode = 'list',
  readOnly = false,
  onNavigateToNode,
  onOpenInSidebar,
  onEscape,
  onSelectionChange,
  onContentChange: onContentChangeCallback,
  renderTriggerPopup,
  className,
  placeholder = 'Type / for commands…',
  includeRoot,
  maxDepth,
  sliceBlockIds,
  sliceRecursiveLevel,
  sliceShowParent,
  canIndent,
  canOutdent,
  canMerge,
  canDelete,
}: NoteesEditorProps): JSX.Element {
  const generatedId = useId();
  const editorId = externalEditorId || `editor-${generatedId}`;

  // ─── Sync structural changes to database ───────────────────
  // Listens to runtime structure_changed events (indent, outdent, reorder)
  // and persists parent_id and sequence to the backend
  useStructureSync();

  // ─── Persist new blocks to database ────────────────────────
  // Watches for runtime nodes without serverId and creates them via API
  useBlockPersist();

  // ─── Sync nodes to runtime ─────────────────────────────────
  // If nodes[] provided, sync them to runtime with a virtual root.
  // This happens synchronously before render so Lexical has data.
  
  const resolvedRootBlockId = useMemo(() => {
    if (nodes && nodes.length > 0) {
      const runtime = getNodeGraphRuntime();
      
      // Convert API nodes to GraphNodes, passing pageId/pageUuid for parent resolution
      const { graphNodes, rootBlockId: derivedRootId } = apiNodesToGraphNodes(
        nodes, pageId, pageUuid,
      );
      
      // Register parent serverId so useBlockPersist can resolve it for new blocks
      if (pageId != null && derivedRootId) {
        runtime.registerParentServerId(derivedRootId, pageId);
      }
      
      // Clean up stale children that are no longer in the API response
      // but keep optimistic blocks (no serverId) that haven't been persisted yet
      const newBlockIds = new Set(graphNodes.map(n => n.blockId));
      const currentChildren = runtime.getChildren(derivedRootId);
      const staleIds = currentChildren
        .filter(child => !newBlockIds.has(child.blockId) && child.serverId != null)
        .map(child => child.blockId);
      if (staleIds.length > 0) {
        runtime.removeNodes(staleIds);
      }
      
      runtime.upsertNodes(graphNodes);
      return derivedRootId;
    }
    return externalRootBlockId || '';
  }, [nodes, externalRootBlockId, pageId, pageUuid]);

  // Auto-detect includeRoot: if the rootBlockId corresponds to a node
  // in the nodes array, the root IS a displayed node (e.g. focused block).
  // If it's NOT in the array, it's a structural parent (e.g. page) that shouldn't render.
  const effectiveIncludeRoot = useMemo(() => {
    if (includeRoot !== undefined) return includeRoot;
    if (!nodes || !resolvedRootBlockId) return false;
    return nodes.some(n => n.uuid === resolvedRootBlockId);
  }, [includeRoot, nodes, resolvedRootBlockId]);

  // ─── Lexical config ────────────────────────────────────────

  const initialConfig = useMemo(() => ({
    namespace: `NoteesEditor-${editorId}`,
    theme: notesEditorTheme,
    nodes: EDITOR_NODES,
    editable: !readOnly,
    editorState: null,
    onError: (error: Error) => {
      console.error(`[NoteesEditor ${editorId}]`, error);
    },
  }), [editorId, readOnly]);

  // ─── Handlers ──────────────────────────────────────────────

  const handleContentChange = useCallback((blockId: string, contentAST: ContentAST) => {
    const runtime = getNodeGraphRuntime();
    runtime.applyIntent({
      type: 'update_content',
      blockId,
      contentAST,
    });
    if (onContentChangeCallback) {
      onContentChangeCallback(blockId, serializeContentAST(contentAST));
    }
  }, [onContentChangeCallback]);

  const handleBlockCreate = useCallback((parentId: string, afterBlockId: string, newBlockId: string) => {
    const runtime = getNodeGraphRuntime();
    const node = runtime.getNode(afterBlockId);
    runtime.applyIntent({
      type: 'create_block',
      parentId: node?.parentId || parentId,
      afterBlockId,
      blockId: newBlockId,
      contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: '' }] }],
    });
  }, []);

  const handleBlockMerge = useCallback((sourceBlockId: string, targetBlockId: string) => {
    if (canMerge && !canMerge(sourceBlockId, targetBlockId)) return;
    const runtime = getNodeGraphRuntime();
    runtime.applyIntent({
      type: 'merge_blocks',
      sourceBlockId,
      targetBlockId,
    });
  }, [canMerge]);

  const handleBlockDelete = useCallback((blockId: string) => {
    if (canDelete && !canDelete(blockId)) return;
    const runtime = getNodeGraphRuntime();
    runtime.applyIntent({ type: 'delete_block', blockId });
  }, [canDelete]);

  const handleIndent = useCallback((blockId: string) => {
    if (canIndent && !canIndent(blockId)) return;
    const runtime = getNodeGraphRuntime();
    runtime.applyIntent({ type: 'indent_block', blockId });
  }, [canIndent]);

  const handleOutdent = useCallback((blockId: string) => {
    if (canOutdent && !canOutdent(blockId)) return;
    const runtime = getNodeGraphRuntime();
    runtime.applyIntent({ type: 'outdent_block', blockId });
  }, [canOutdent]);

  const handlePillClick = useCallback((linkId: string) => {
    onNavigateToNode?.(linkId);
  }, [onNavigateToNode]);

  const handlePillRemove = useCallback((_linkId: string) => {
    // Content change will be picked up by the update listener
  }, []);

  // ─── Render ────────────────────────────────────────────────

  const editorClassName = [
    'notees-editor',
    `notees-editor--${mode}`,
    readOnly ? 'notees-editor--readonly' : '',
    className || '',
  ].filter(Boolean).join(' ');

  return (
    <div className={editorClassName}>
      <LexicalComposer initialConfig={initialConfig}>
        <RichTextPlugin
          contentEditable={
            <ContentEditable
              className="notees-editor-content"
              aria-label="Note editor"
            />
          }
          placeholder={
            <div className="notees-editor-placeholder">{placeholder}</div>
          }
          ErrorBoundary={LexicalErrorBoundary}
        />

        {/* Core plugins — global undo/redo in list mode */}
        <HistoryPlugin />
        <FormattingPlugin />
        <CollapsePlugin />

        {/* NodeBlock projection plugin */}
        <NodeBlockPlugin
          editorId={editorId}
          rootBlockId={resolvedRootBlockId}
          onContentChange={handleContentChange}
          onBlockCreate={handleBlockCreate}
          onBlockMerge={handleBlockMerge}
          onBlockDelete={handleBlockDelete}
          onIndent={handleIndent}
          onOutdent={handleOutdent}
          onEscape={onEscape}
          readOnly={readOnly}
          includeRoot={effectiveIncludeRoot}
          maxDepth={maxDepth}
          sliceBlockIds={sliceBlockIds}
          sliceRecursiveLevel={sliceRecursiveLevel}
          sliceShowParent={sliceShowParent}
        />

        {/* NodePill plugin */}
        <NodePillPlugin
          onPillClick={handlePillClick}
          onPillRemove={handlePillRemove}
        />

        {/* Drag & drop */}
        <DragDropPlugin
          editorId={editorId}
          readOnly={readOnly}
        />

        {/* Block drag selection (Logseq-style vertical drag) */}
        <BlockDragSelectionPlugin
          editorId={editorId}
          readOnly={readOnly}
          onSelectionChange={onSelectionChange}
        />

        {/* Keyboard-based block selection (Esc, Shift+arrows) */}
        <KeyboardSelectionPlugin
          editorId={editorId}
          readOnly={readOnly}
          onSelectionChange={onSelectionChange}
          onEscape={onEscape}
        />

        {/* Selection */}
        <SelectionPlugin
          editorId={editorId}
          onSelectionChange={onSelectionChange}
        />

        {/* Slash commands and triggers */}
        <SlashCommandPlugin
          renderPopup={renderTriggerPopup}
          onLinkSelect={handlePillClick}
        />

        {/* Floating toolbar */}
        <FloatingToolbarPlugin />

        {/* Context menu for bullet right-click */}
        <ContextMenuPlugin
          onNavigateToNode={onNavigateToNode}
          onOpenInSidebar={onOpenInSidebar}
        />

        {/* Blur editor when clicking outside */}
        <BlurOnClickOutsidePlugin readOnly={readOnly} />
      </LexicalComposer>
    </div>
  );
}
