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

import { useCallback, useMemo, useId, useLayoutEffect, useRef, useState, type JSX } from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';

import { notesEditorTheme } from './theme';
import type { InlineLinkRefType } from './nodes/InlineLinkNode';
import { EDITOR_NODES, serializeContentAST } from './editorConfig';

import { BlockPlugin } from './plugins/BlockPlugin';
import { NodeLinkPlugin } from './plugins/NodeLinkPlugin';
import { DragDropPlugin } from './plugins/DragDropPlugin';
import { BlockDragSelectionPlugin } from './plugins/BlockDragSelectionPlugin';
import { KeyboardSelectionPlugin } from './plugins/KeyboardSelectionPlugin';
import { SelectionPlugin } from './plugins/SelectionPlugin';
import { CollapsePlugin } from './plugins/CollapsePlugin';
import { ThreadLinePlugin } from './plugins/ThreadLinePlugin';
import { FormattingPlugin } from './plugins/FormattingPlugin';
import { AutoWrapPlugin } from './plugins/AutoWrapPlugin';
import { TriggerPlugin } from './plugins/TriggerPlugin';
import { FloatingToolbarPlugin } from './plugins/FloatingToolbarPlugin';
import { ContextMenuPlugin } from './plugins/ContextMenuPlugin';
import { BlurOnClickOutsidePlugin } from './plugins/BlurOnClickOutsidePlugin';
import { EditablePlugin } from './plugins/EditablePlugin';
import { CustomCaretPlugin } from './plugins/CustomCaretPlugin';
import { SelectionConstraintPlugin } from './plugins/SelectionConstraintPlugin';
import { BlockClassPillsPlugin } from './plugins/BlockClassPillsPlugin';
import { BlockPropertyIconsPlugin } from './plugins/BlockPropertyIconsPlugin';
import { BlockPropertiesPlugin } from './plugins/BlockPropertiesPlugin';
import { AssetBlockPlugin } from './plugins/AssetBlockPlugin';
import { AssetLinkImagePlugin } from './plugins/AssetLinkImagePlugin';
import { TableBlockPlugin } from './plugins/TableBlockPlugin';
import { QueryBlockPlugin } from './plugins/QueryBlockPlugin';
import { BlockCodePlugin } from './plugins/BlockCodePlugin';
import { EmbedBlockPlugin } from './plugins/EmbedBlockPlugin';
import { TaskCyclePlugin } from './plugins/TaskCyclePlugin';
import { VirtualizationPlugin } from './plugins/VirtualizationPlugin';
import { PasteImagePlugin } from './plugins/PasteImagePlugin';
import { PasteBlocksPlugin } from './plugins/PasteBlocksPlugin';
import { CreateLinkPlugin, isLikelyUrl, type PendingNewLink } from './plugins/CreateLinkPlugin';
import { LinkEditModal, type LinkEditResult } from './components/LinkEditModal';
import * as nodesApi from '@/api/nodes';

import { getNodeGraphRuntime } from '../runtime/NodeGraphRuntime';
import { apiNodesToGraphNodes } from '../hooks/useRuntimeSync';
import { useStructureSync } from '../hooks/useStructureSync';
import { useBlockPersist } from '../hooks/useBlockPersist';
import type { ContentAST } from '../runtime/types';
import type { Node } from '../types/api';
import { parseLinkId, buildLinkId } from '../lib/astBuilder';
import { useAddClass, useRemoveClass, useClassClass } from '@/hooks';

import './BlockEditor.css';
// Ensure shared Bullet styles (collapse arrow dimensions, positioning) are
// always loaded when the block editor renders, even if no React Bullet
// component is mounted on the page.
import '../components/blocks/Bullet.css';

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
  /** Called when an action-type slash command is selected (table, query, image, audio, file, comment, property, url) */
  onSlashCommand?: (commandId: string, blockServerId: number | undefined) => void;
  /** Called when a template node is selected via the /template inline picker */
  onTemplateInstantiate?: (templateNodeId: number, blockServerId: number | undefined) => void;
  /** Class IDs used to filter the /template inline picker (should be the template class ID) */
  templateClassFilters?: number[];
  /** Called when an image is pasted into a block */
  onPasteImage?: (blockServerId: number, file: File, hasContent: boolean) => void;
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
  /** Called when Enter is pressed on the root block (instead of creating a child) */
  onEnterAtRoot?: () => void;
  /** Called when UP arrow is pressed at the very first block (used by embed border selection) */
  onNavigateUpFromTop?: () => void;
  /** Whether to hide inline property rows below blocks (default: false) */
  hideProperties?: boolean;
  /** Draft mode: disables auto-persistence to the server. Blocks stay local in the runtime. */
  draftMode?: boolean;
}

// ─── Shared content serializer ────────────────────────────────────

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
  onSlashCommand,
  onTemplateInstantiate,
  templateClassFilters,
  onPasteImage,
  className,
  placeholder = '',
  includeRoot,
  maxDepth,
  sliceBlockIds,
  sliceRecursiveLevel,
  sliceShowParent,
  canIndent,
  canOutdent,
  canMerge,
  canDelete,
  onEnterAtRoot,
  onNavigateUpFromTop,
  hideProperties = false,
  draftMode = false,
}: BlockEditorProps): JSX.Element {
  const generatedId = useId();
  const editorId = externalEditorId || `editor-${generatedId}`;

  // Track whether the initial data sync has run, so subsequent syncs
  // preserve client-side collapsed state while the first one uses the DB value.
  const hasInitializedRef = useRef(false);

  // Hooks for class management  
  const addClassMutation = useAddClass();
  const removeClassMutation = useRemoveClass();
  const { classClassId } = useClassClass();

  // ─── Sync structural changes to database ───────────────────
  // Listens to runtime structure_changed events (indent, outdent, reorder)
  // and persists parent_id and sequence to the backend
  useStructureSync({ enabled: !draftMode });

  // ─── Persist new blocks to database ────────────────────────
  // Watches for runtime nodes without serverId and creates them via API
  useBlockPersist({ enabled: !draftMode });

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
    // runtime before we remove stale ones. Both calls emit events
    // that drive syncProjection; doing upsert-then-remove ensures
    // the first (non-coalesced) sync sees the new block immediately.
    //
    // On the initial sync we use the DB's collapsed values so that a
    // previous view's client-side collapse state doesn't leak into
    // this view.  Subsequent syncs preserve client-side collapsed state.
    const isInitial = !hasInitializedRef.current;
    hasInitializedRef.current = true;
    runtime.upsertNodes(graphNodes, { preserveCollapsed: !isInitial });

    // Clean up stale children that are no longer in the API response
    // but keep optimistic blocks (no serverId) that haven't been persisted yet.
    // 
    // IMPORTANT: Only clean up when displaying a page's children, not when:
    // - Displaying a focused block (includeRoot is true, the block itself is in nodes)
    // - Displaying shared content (sidebar without pageId)
    // This prevents one editor from removing nodes that another editor is displaying.
    const isFocusedBlock = nodes?.some(n => n.uuid === derivedRootId);
    if (pageId != null && derivedRootId && !isFocusedBlock) {
      const newBlockIds = new Set(graphNodes.map(n => n.blockId));
      // Check ALL descendants (not just direct children) so that nested blocks
      // deleted via the context menu are also cleaned up from the runtime.
      const allDescendants = runtime.getDescendants(derivedRootId);
      const staleIds = allDescendants
        .filter(desc => !newBlockIds.has(desc.blockId) && desc.serverId != null)
        .map(desc => desc.blockId);
      if (staleIds.length > 0) {
        runtime.removeNodes(staleIds);
      }
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

  const handleMoveUp = useCallback((blockId: string) => {
    const runtime = getNodeGraphRuntime();
    runtime.applyIntent({ type: 'move_up', blockId });
  }, []);

  const handleMoveDown = useCallback((blockId: string) => {
    const runtime = getNodeGraphRuntime();
    runtime.applyIntent({ type: 'move_down', blockId });
  }, []);

  const handlePillClick = useCallback((linkId: string, _refType?: InlineLinkRefType) => {
    onNavigateToNode?.(linkId);
  }, [onNavigateToNode]);

  const handlePillRemove = useCallback((_linkId: string) => {
    // Content change will be picked up by the update listener
  }, []);

  // ─── Link edit modal ──────────────────────────────────────

  const [linkEditState, setLinkEditState] = useState<{
    linkId: string;
    refType: InlineLinkRefType;
    url?: string;
    label?: string;
  } | null>(null);

  // ─── Create link from selection (Ctrl+L / Ctrl+Shift+L / Ctrl+Alt+L) ───

  const [createLinkModalState, setCreateLinkModalState] = useState<{
    initialMode?: 'node' | 'block' | 'url';
    initialLabel?: string;
    initialUrl?: string;
    initialSearchQuery?: string;
    title?: string;
  } | null>(null);

  const [pendingNewLink, setPendingNewLink] = useState<PendingNewLink | null>(null);

  // Ctrl+L — page link: auto-select first search result if text is selected,
  // otherwise fall back to opening the modal with the text as query.
  const handleOpenPageSearch = useCallback(async (selectedText: string) => {
    if (selectedText) {
      try {
        const results = await nodesApi.searchNodes(selectedText);
        if (results.length > 0) {
          setPendingNewLink({
            refType: 'node',
            nodeUuid: results[0].uuid,
            label: null,
          });
          return;
        }
      } catch {
        // fall through to modal on error
      }
    }
    setCreateLinkModalState({
      initialMode: 'node',
      initialSearchQuery: selectedText || undefined,
      title: 'Insert Page Link',
    });
  }, []);

  // Ctrl+Shift+L — page link, selected text as custom label
  const handleOpenPageLabel = useCallback((selectedText: string) => {
    setCreateLinkModalState({
      initialMode: 'node',
      initialLabel: selectedText || undefined,
      title: 'Insert Page Link',
    });
  }, []);

  // Ctrl+Alt+L — URL link
  const handleOpenUrlLink = useCallback((selectedText: string) => {
    if (isLikelyUrl(selectedText)) {
      setCreateLinkModalState({
        initialMode: 'url',
        initialUrl: selectedText,
        title: 'Insert URL Link',
      });
    } else {
      setCreateLinkModalState({
        initialMode: 'url',
        initialLabel: selectedText || undefined,
        title: 'Insert URL Link',
      });
    }
  }, []);

  const handleCreateLinkModalClose = useCallback(() => {
    setCreateLinkModalState(null);
  }, []);

  const handleCreateLinkModalSave = useCallback((result: LinkEditResult) => {
    if (result.mode === 'url') {
      setPendingNewLink({
        refType: 'url',
        url: result.url,
        label: result.label,
      });
    } else {
      if (result.targetNode) {
        setPendingNewLink({
          refType: 'node',
          nodeUuid: result.targetNode.uuid,
          label: result.label,
        });
      }
    }
    setCreateLinkModalState(null);
  }, []);

  const handleNewLinkApplied = useCallback(() => {
    setPendingNewLink(null);
  }, []);

  const handleSlashCommand = useCallback((commandId: string, blockServerId: number | undefined) => {
    if (commandId === 'link') {
      setCreateLinkModalState({ initialMode: 'node', title: 'Insert Page Link' });
    } else if (commandId === 'blocklink') {
      setCreateLinkModalState({ initialMode: 'block', title: 'Insert Block Link' });
    } else {
      onSlashCommand?.(commandId, blockServerId);
    }
  }, [onSlashCommand]);

  const handlePillEdit = useCallback((linkId: string, refType: InlineLinkRefType, url?: string, label?: string) => {
    setLinkEditState({ linkId, refType, url, label });
  }, []);

  const handleLinkEditClose = useCallback(() => {
    setLinkEditState(null);
  }, []);

  const handleLinkEditSave = useCallback(async (result: LinkEditResult) => {
    if (result.mode === 'url') {
      // URL mode: replace the InlineLinkNode with a URL link
      setPendingPillUpdate({
        oldLinkId: result.originalLinkId,
        newLinkId: result.label || result.url || result.originalLinkId,
        newRefType: 'url',
        newUrl: result.url,
      });
    } else {
      // Node mode
      const { nodeUuid: origNodeUuid, linkUuid } = parseLinkId(result.originalLinkId);
      const isInlineClassLink = linkEditState?.refType === 'class';

      const targetChanged = result.targetNode && result.targetNode.uuid !== origNodeUuid;
      const labelChanged = result.label !== (linkEditState?.label ?? null);

      if (targetChanged || labelChanged) {
        const newNodeUuid = targetChanged ? result.targetNode!.uuid : origNodeUuid;
        const newLinkId = linkUuid
          ? buildLinkId(newNodeUuid, linkUuid)
          : newNodeUuid;

        setPendingPillUpdate({
          oldLinkId: result.originalLinkId,
          newLinkId: targetChanged ? newLinkId : result.originalLinkId,
          newRefType: isInlineClassLink ? 'class' : 'node',
          newLabel: result.label,
        });
      }

      // If this is an inline class link and target changed, sync the block's class_ids
      if (targetChanged && isInlineClassLink && result.targetNode) {
        if (pageId != null) {
          const origNode = nodes?.find(n => n.uuid === origNodeUuid);
          if (origNode) {
            removeClassMutation.mutate({ nodeId: pageId, classId: origNode.id });
          }
          addClassMutation.mutate({ nodeId: pageId, classId: result.targetNode.id });
          if (classClassId && !result.targetNode.classes?.includes(classClassId)) {
            addClassMutation.mutate({ nodeId: result.targetNode.id, classId: classClassId });
          }
        }
      }
    }

    setLinkEditState(null);
  }, [linkEditState, pageId, nodes, addClassMutation, removeClassMutation, classClassId]);

  // Pending pill update (applied by a useEffect that has editor access)
  const [pendingPillUpdate, setPendingPillUpdate] = useState<{
    oldLinkId: string;
    newLinkId: string;
    newRefType: InlineLinkRefType;
    newUrl?: string;
    newLabel?: string | null;
  } | null>(null);

  // ─── Render ────────────────────────────────────────────────

  const editorClassName = [
    'notees-editor',
    `notees-editor--${mode}`,
    readOnly ? 'notees-editor--readonly' : '',
    className || '',
  ].filter(Boolean).join(' ');

  return (
    <div className={editorClassName} data-editor-id={editorId}>
      <LexicalComposer initialConfig={initialConfig}>
        <RichTextPlugin
          contentEditable={
            <ContentEditable
              className="notees-editor-content"
              aria-label="Note editor"
              spellCheck={!readOnly}
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
        <AutoWrapPlugin />
        <CollapsePlugin />
        <ThreadLinePlugin mode={mode} />

        {/* Block projection plugin */}
        <BlockPlugin
          editorId={editorId}
          rootBlockId={resolvedRootBlockId}
          onContentChange={handleContentChange}
          onBlockMerge={handleBlockMerge}
          onBlockDelete={handleBlockDelete}
          onIndent={handleIndent}
          onOutdent={handleOutdent}
          onMoveUp={handleMoveUp}
          onMoveDown={handleMoveDown}
          onEscape={onEscape}
          readOnly={readOnly}
          includeRoot={effectiveIncludeRoot}
          maxDepth={maxDepth}
          sliceBlockIds={sliceBlockIds}
          sliceRecursiveLevel={sliceRecursiveLevel}
          sliceShowParent={sliceShowParent}
          onEnterAtRoot={onEnterAtRoot}
          onNavigateUpFromTop={onNavigateUpFromTop}
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

        {/* Triggers (/, +, @, #) */}
        <TriggerPlugin
          onLinkSelect={handlePillClick}
          onAddClass={onAddClass}
          onSlashCommand={handleSlashCommand}
          onTemplateInstantiate={onTemplateInstantiate}
          templateClassFilters={templateClassFilters}
        />

        {/* Paste image handler */}
        <PasteImagePlugin onPasteImage={onPasteImage} />

        {/* Multi-line paste handler — creates hierarchical blocks with [[link]] and #tag resolution */}
        <PasteBlocksPlugin onContentChange={handleContentChange} />

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

        {/* Virtualization — provides viewport awareness to portal plugins.
            Automatically activates for pages with 80+ blocks. */}
        <VirtualizationPlugin>
          {/* Block class pills — renders class badges on each block */}
          <BlockClassPillsPlugin onNavigateToNode={onNavigateToNode} />

          {/* Property icons on blocks (page-level index, zero per-block queries) */}
          <BlockPropertyIconsPlugin />

          {/* Inline property rows below blocks that have properties */}
          {!hideProperties && <BlockPropertiesPlugin />}

          {/* Asset previews — renders image/audio/file previews on asset blocks */}
          <AssetBlockPlugin />

          {/* Inline asset link previews — renders images below blocks that link to asset nodes */}
          <AssetLinkImagePlugin />

          {/* Table previews — renders table element on table-class blocks */}
          <TableBlockPlugin />

          {/* Query previews — renders query results on query-class blocks */}
          <QueryBlockPlugin />

          {/* Code block line numbers — renders gutter with line numbers on code-type blocks */}
          <BlockCodePlugin />

          {/* Embed previews — renders embedded node card below embed-link blocks */}
          <EmbedBlockPlugin />
        </VirtualizationPlugin>

        {/* Ctrl+Enter cycles task status: (none) → Pending → Doing → Done → (remove) */}
        <TaskCyclePlugin />

        {/* Ctrl+L / Ctrl+Shift+L / Ctrl+Alt+L open the link-creation modal */}
        <CreateLinkPlugin
          readOnly={readOnly}
          onOpenPageSearch={handleOpenPageSearch}
          onOpenPageLabel={handleOpenPageLabel}
          onOpenUrlLink={handleOpenUrlLink}
          pendingNewLink={pendingNewLink}
          onNewLinkApplied={handleNewLinkApplied}
        />

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
          currentLabel={linkEditState.label}
          onSave={handleLinkEditSave}
          onClose={handleLinkEditClose}
        />
      )}

      {/* Create link modal (Ctrl+L / Ctrl+Shift+L / Ctrl+Alt+L, or /link, /blocklink) */}
      {createLinkModalState && (
        <LinkEditModal
          isOpen={true}
          linkId=""
          refType={createLinkModalState.initialMode === 'url' ? 'url' : 'node'}
          currentUrl={createLinkModalState.initialUrl}
          currentLabel={createLinkModalState.initialLabel}
          initialMode={createLinkModalState.initialMode}
          initialSearchQuery={createLinkModalState.initialSearchQuery}
          title={createLinkModalState.title ?? 'Insert Link'}
          onSave={handleCreateLinkModalSave}
          onClose={handleCreateLinkModalClose}
        />
      )}
    </div>
  );
}
