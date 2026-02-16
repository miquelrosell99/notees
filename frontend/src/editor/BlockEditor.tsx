/**
 * BlockEditor — Single Lexical editor for List Mode and Document Mode.
 *
 * This component renders ONE Lexical editor instance that projects
 * the entire block hierarchy from NodeGraphRuntime as a flat list
 * of BlockNodes with depth metadata for indentation.
 *
 * Used by:
 * - List Mode: full hierarchy with bullets, indent, collapse
 * - Document Mode: same hierarchy, bullets hidden via CSS
 *
 * NOT used for Card Mode — see CardModeView for per-card editors.
 */

import { useCallback, useMemo, useId, useLayoutEffect, useState, type JSX } from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';

import { notesEditorTheme } from './theme';
import { BlockNode } from './nodes/BlockNode';
import { PillNode } from './nodes/PillNode';
import type { PillRefType } from './nodes/PillNode';
import { BlockHeadingNode } from './nodes/BlockHeadingNode';
import { BlockCodeNode } from './nodes/BlockCodeNode';
import { BlockTableCellNode } from './nodes/BlockTableCellNode';

import { BlockPlugin } from './plugins/BlockPlugin';
import { NodeLinkPlugin } from './plugins/NodeLinkPlugin';
import { DragDropPlugin } from './plugins/DragDropPlugin';
import { BlockDragSelectionPlugin } from './plugins/BlockDragSelectionPlugin';
import { KeyboardSelectionPlugin } from './plugins/KeyboardSelectionPlugin';
import { SelectionPlugin } from './plugins/SelectionPlugin';
import { CollapsePlugin } from './plugins/CollapsePlugin';
import { FormattingPlugin } from './plugins/FormattingPlugin';
import { TriggerPlugin } from './plugins/TriggerPlugin';
import { FloatingToolbarPlugin } from './plugins/FloatingToolbarPlugin';
import { ContextMenuPlugin } from './plugins/ContextMenuPlugin';
import { BlurOnClickOutsidePlugin } from './plugins/BlurOnClickOutsidePlugin';
import { EditablePlugin } from './plugins/EditablePlugin';
import { CustomCaretPlugin } from './plugins/CustomCaretPlugin';
import { SelectionConstraintPlugin } from './plugins/SelectionConstraintPlugin';
import { BlockClassPillsPlugin } from './plugins/BlockClassPillsPlugin';
import { BlockPropertyIconsPlugin } from './plugins/BlockPropertyIconsPlugin';
import { TaskCyclePlugin } from './plugins/TaskCyclePlugin';
import { LinkEditModal, type LinkEditResult } from './components/LinkEditModal';

import { getNodeGraphRuntime } from '../runtime/NodeGraphRuntime';
import { apiNodesToGraphNodes } from '../hooks/useRuntimeSync';
import { useStructureSync } from '../hooks/useStructureSync';
import { useBlockPersist } from '../hooks/useBlockPersist';
import type { ContentAST } from '../runtime/types';
import type { Node } from '../types/api';
import { updateLinkName } from '../api/nodes';
import { parseLinkId, buildLinkId } from '../lib/astBuilder';

import './BlockEditor.css';

// ─── Lexical node registry (shared between List and Card editors) ─

export const EDITOR_NODES = [
  BlockNode,
  PillNode,
  BlockHeadingNode,
  BlockCodeNode,
  BlockTableCellNode,
];

// ─── Props ────────────────────────────────────────────────────────

export type EditorMode = 'list' | 'document';

export interface BlockEditorProps {
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

  /** Called when any block's content changes (for API persistence) */
  onContentChange?: (blockId: string, content: string) => void;
  /** Called when a class should be added to a block via @ menu (plain Enter) */
  onAddClass?: (blockId: number, classId: number) => void;
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

// ─── Component ────────────────────────────────────────────────────

export function BlockEditor({
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
  onAddClass,
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
}: BlockEditorProps): JSX.Element {
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
      const { rootBlockId: derivedRootId } = apiNodesToGraphNodes(
        nodes, pageId, pageUuid,
      );
      return derivedRootId;
    }
    return externalRootBlockId || '';
  }, [nodes, externalRootBlockId, pageId, pageUuid]);

  // Sync runtime state imperatively — runs once per dependency change,
  // synchronously before paint so Lexical has data on first render.
  useLayoutEffect(() => {
    if (!nodes || nodes.length === 0) return;

    const runtime = getNodeGraphRuntime();
    const { graphNodes, rootBlockId: derivedRootId } = apiNodesToGraphNodes(
      nodes, pageId, pageUuid,
    );

    // Register parent serverId so useBlockPersist can resolve it for new blocks
    if (pageId != null && derivedRootId) {
      runtime.registerParentServerId(derivedRootId, pageId);
    }

    // Upsert FIRST so that new/real nodes are already present in the
    // runtime before we remove stale ones.  Both calls emit events
    // that drive syncProjection; doing upsert-then-remove ensures
    // the first (non-coalesced) sync sees the new block immediately.
    runtime.upsertNodes(graphNodes);

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
  }, [nodes, pageId, pageUuid]);

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
    namespace: `BlockEditor-${editorId}`,
    theme: notesEditorTheme,
    nodes: EDITOR_NODES,
    editable: !readOnly,
    editorState: null,
    onError: (error: Error) => {
      console.error(`[BlockEditor ${editorId}]`, error);
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

  const handleBlockMerge = useCallback((sourceBlockId: string, targetBlockId: string) => {
    if (canMerge && !canMerge(sourceBlockId, targetBlockId)) return;
    const runtime = getNodeGraphRuntime();
    runtime.applyIntent({
      type: 'merge_blocks',
      sourceBlockId,
      targetBlockId,
    });
    // Flush immediately so the merge is reflected in Lexical on the same
    // frame as the Backspace keypress — avoids a 1-frame stale state.
    runtime.flushEvents();
  }, [canMerge]);

  const handleBlockDelete = useCallback((blockId: string) => {
    if (canDelete && !canDelete(blockId)) return;
    const runtime = getNodeGraphRuntime();
    runtime.applyIntent({ type: 'delete_block', blockId });
    runtime.flushEvents();
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

  const handlePillClick = useCallback((linkId: string, _refType?: PillRefType) => {
    onNavigateToNode?.(linkId);
  }, [onNavigateToNode]);

  const handlePillRemove = useCallback((_linkId: string) => {
    // Content change will be picked up by the update listener
  }, []);

  // ─── Link edit modal ──────────────────────────────────────

  const [linkEditState, setLinkEditState] = useState<{
    linkId: string;
    refType: PillRefType;
    url?: string;
  } | null>(null);

  const handlePillEdit = useCallback((linkId: string, refType: PillRefType, url?: string) => {
    setLinkEditState({ linkId, refType, url });
  }, []);

  const handleLinkEditClose = useCallback(() => {
    setLinkEditState(null);
  }, []);

  const handleLinkEditSave = useCallback((result: LinkEditResult) => {
    if (result.mode === 'url') {
      // URL mode: replace the PillNode with a URL pill
      setPendingPillUpdate({
        oldLinkId: result.originalLinkId,
        newLinkId: result.label || result.url || result.originalLinkId,
        newRefType: 'url',
        newUrl: result.url,
      });
    } else {
      // Node mode: keep existing behaviour
      const { nodeUuid: origNodeUuid, linkUuid } = parseLinkId(result.originalLinkId);

      // Update custom label via API if we have a linkUuid
      if (linkUuid) {
        updateLinkName(linkUuid, result.label).catch(err => {
          console.error('[BlockEditor] Failed to update link name:', err);
        });
      }

      // If the target node changed, update the PillNode in the Lexical tree
      if (result.targetNode && result.targetNode.uuid !== origNodeUuid) {
        const newNodeUuid = result.targetNode.uuid;
        const newLinkId = linkUuid
          ? buildLinkId(newNodeUuid, linkUuid)
          : newNodeUuid;

        setPendingPillUpdate({
          oldLinkId: result.originalLinkId,
          newLinkId,
          newRefType: linkEditState?.refType === 'class' ? 'class' : 'node',
        });
      }
    }

    setLinkEditState(null);
  }, [linkEditState]);

  // Pending pill update (applied by a useEffect that has editor access)
  const [pendingPillUpdate, setPendingPillUpdate] = useState<{
    oldLinkId: string;
    newLinkId: string;
    newRefType: PillRefType;
    newUrl?: string;
  } | null>(null);

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
        <EditablePlugin readOnly={readOnly} />
        <HistoryPlugin />
        <FormattingPlugin />
        <CollapsePlugin />

        {/* Block projection plugin */}
        <BlockPlugin
          editorId={editorId}
          rootBlockId={resolvedRootBlockId}
          onContentChange={handleContentChange}
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

        {/* Pill plugin */}
        <NodeLinkPlugin
          onPillClick={handlePillClick}
          onPillEdit={handlePillEdit}
          onPillRemove={handlePillRemove}
          pendingPillUpdate={pendingPillUpdate}
          onPillUpdateApplied={() => setPendingPillUpdate(null)}
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

        {/* Triggers (/, [[, @, #) */}
        <TriggerPlugin
          onLinkSelect={handlePillClick}
          onAddClass={onAddClass}
        />

        {/* Floating toolbar */}
        <FloatingToolbarPlugin />

        {/* Context menu for bullet right-click */}
        <ContextMenuPlugin
          onNavigateToNode={onNavigateToNode}
          onOpenInSidebar={onOpenInSidebar}
          onPillEdit={handlePillEdit}
          onPillRemove={handlePillRemove}
        />

        {/* Blur editor when clicking outside */}
        <BlurOnClickOutsidePlugin readOnly={readOnly} />

        {/* Block class pills — renders class badges on each block */}
        <BlockClassPillsPlugin onNavigateToNode={onNavigateToNode} />

        {/* Property icons on blocks (page-level index, zero per-block queries) */}
        <BlockPropertyIconsPlugin />

        {/* Ctrl+Enter cycles task status: (none) → Pending → Doing → Done → (remove) */}
        <TaskCyclePlugin />

        {/* Constrain text selection to active block + custom copy/cut */}
        <SelectionConstraintPlugin readOnly={readOnly} />

        {/* Custom caret (replaces native caret, Insert key toggles block mode) */}
        <CustomCaretPlugin readOnly={readOnly} />
      </LexicalComposer>

      {/* Link edit modal (rendered outside Lexical context) */}
      {linkEditState && (
        <LinkEditModal
          isOpen={true}
          linkId={linkEditState.linkId}
          refType={linkEditState.refType}
          currentUrl={linkEditState.url}
          onSave={handleLinkEditSave}
          onClose={handleLinkEditClose}
        />
      )}
    </div>
  );
}
