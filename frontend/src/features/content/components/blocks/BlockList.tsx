/* eslint-disable jsx-a11y/no-noninteractive-element-interactions */
/**
 * BlockList — List container for the block-level editor.
 *
 * Renders BlockRow components for each visible block.
 * Handles list-level keyboard navigation (Enter, Backspace, Tab, Arrows).
 * Large lists (>50 items) are window-virtualized with @tanstack/react-virtual.
 *
 * Data projection is delegated to useBlockTree. This component is a pure
 * renderer: it receives a flat list of nodes and focuses on rendering,
 * virtualization, and keyboard handlers.
 */

import {
  useRef,
  useCallback,
  useMemo,
  useEffect,
  useLayoutEffect,
  useState,
  type KeyboardEvent,
  type JSX,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useBlockTree, parseGhostParentUuid } from '@/hooks/useBlockTree';
import { BlockRow, type BlockRowHandle } from './BlockRow';
import { BulletLineOverlay } from './BulletLineOverlay';
import { useEditorFocusStore } from '@/stores/editorFocusStore';
import { generateUUID } from '@/utils/uuid';
import type { Node } from '@/types/api';
import { useBlockDragDrop } from '@/hooks/useBlockDragDrop';
import { useBlockSelection } from '@/hooks/useBlockSelection';
import { useBlockSelectionStore } from '@/stores/blockSelectionStore';
import { useTouchIndent } from '@/hooks/useTouchIndent';
import { BlockFindReplacePlugin } from '@/features/content/editor/plugins/BlockFindReplacePlugin';
import { flushAllContentSaves } from '@/hooks/useContentSave';
import './BlockList.css';
import { getOperationRuntime } from '@/runtime';
import { getNode, getChildren } from '@/runtime/graphHelpers';
import { getRuntimeEventBus } from '@/runtime/eventBus';
import { getUndoEngine } from '@/stores/undoEngine';
import type { MutationIntent } from '@/runtime/types';

function applyRuntimeIntent(intent: MutationIntent): void {
  getUndoEngine().applyIntent(intent, intent.type === 'update_content' ? { sourceEditorId: intent.sourceEditorId } : undefined);
}

interface BlockListProps {
  /** Tree of nodes (will be projected through useBlockTree). */
  nodes: Node[];
  /** Whether the list is read-only. */
  readOnly?: boolean;
  /** Placeholder for empty blocks. */
  placeholder?: string;
  /** Called when any block's content changes. */
  onContentChange?: (blockId: string, content: string) => void;
  /** Called when a pill is clicked. */
  onPillClick?: (linkId: string, refType: 'node' | 'class' | 'url' | 'embed' | 'broken' | 'user') => void;
  /** Called when a pill is removed. */
  onPillRemove?: (linkId: string) => void;
  /** Called when a node is navigated to (page click). Receives block UUID. */
  onNavigateToNode?: (blockId: string) => void;
  /** Called when shift+clicking a bullet (open in sidebar). Receives block UUID. */
  onOpenInSidebar?: (blockId: string) => void;
  /** Maximum depth to render (-1 = unlimited). */
  maxDepth?: number;
  /** Show only pages (ListView pages-only mode). */
  pagesOnly?: boolean;
  /** Skip pages (DocumentView mode). */
  skipPages?: boolean;
  /** Called when a class should be added via + trigger. */
  onAddClass?: (blockServerId: number, classId: number) => void;
  /** Called when a slash command is selected. */
  onSlashCommand?: (commandId: string, blockServerId: number | undefined) => void;
  /** Called when an image is pasted into a block. */
  onPasteImage?: (blockServerId: number, file: File, hasContent: boolean) => void;
  /** Called when files are dropped from outside the browser. */
  onDropFiles?: (files: File[]) => void;
  /** Called when a template is selected. */
  onTemplateInstantiate?: (templateNodeId: number, blockServerId: number | undefined) => void;
  /** Class IDs to pre-filter template picker. */
  templateClassFilters?: number[];
  /** UUID of the containing page (enables live sync lock indicators). */
  nodeUuid?: string;
  /** Server ID of the containing node (for runtime parent resolution). */
  nodeId?: number;
  /** Whether to show class pills below each block's content. */
  showClasses?: boolean;
  /** Force all nodes to be expanded, ignoring stored collapsed state. */
  expandAll?: boolean;
}

export function BlockList({
  nodes,
  readOnly = false,
  placeholder,
  onContentChange,
  onPillClick,
  onPillRemove,
  onNavigateToNode,
  onOpenInSidebar,
  maxDepth = -1,
  pagesOnly = false,
  skipPages = false,
  onAddClass,
  onSlashCommand,
  onPasteImage,
  onDropFiles,
  onTemplateInstantiate,
  templateClassFilters,
  nodeUuid,
  nodeId,
  showClasses = false,
  expandAll = false,
}: BlockListProps): JSX.Element {
  const { flatNodes, structureVersion } = useBlockTree(nodes, {
    maxDepth,
    pagesOnly,
    skipPages,
    expandAll,
    nodeId,
    nodeUuid,
    readOnly,
  });

  const blockIds = useMemo(() => flatNodes.filter((n) => !n.isGhost).map((n) => n.node.uuid), [flatNodes]);
  const ghostIds = useMemo(() => flatNodes.filter((n) => n.isGhost).map((n) => n.node.uuid), [flatNodes]);
  const blockIdsRef = useRef(blockIds);
  useLayoutEffect(() => {
    blockIdsRef.current = blockIds;
  }, [blockIds]);
  const rowRefs = useRef<Map<string, BlockRowHandle>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);


  useBlockDragDrop({ containerRef, editorId: 'block-list', readOnly, excludedIds: ghostIds });
  useBlockSelection({ containerRef, blockIds, readOnly });
  useTouchIndent({
    containerRef,
    readOnly,
    onIndent: (blockId) => {
      applyRuntimeIntent({ type: 'indent_block', blockId });
      getRuntimeEventBus().flushEvents();
    },
    onOutdent: (blockId) => {
      applyRuntimeIntent({ type: 'outdent_block', blockId });
      getRuntimeEventBus().flushEvents();
    },
  });

  const activeBlockId = useEditorFocusStore((s) => s.activeBlockId);

  // Compute ancestor UUIDs of the active block so each row can know whether it
  // sits on the active editing path. This replaces the imperative DOM class
  // toggling that the old thread-line system used.
  const activeTrailIds = useMemo(() => {
    if (!activeBlockId) return new Set<string>();
    // structureVersion is intentionally unused inside the callback; it acts as
    // a signal that the runtime tree structure changed, so we must re-walk the
    // active block's ancestors.
    void structureVersion;
    const runtime = getOperationRuntime();
    const trail = new Set<string>();
    let current = getNode(runtime, activeBlockId);
    while (current?.parentId) {
      const parent = getNode(runtime, current.parentId);
      if (!parent) break;
      trail.add(parent.blockId);
      current = parent;
    }
    return trail;
  }, [activeBlockId, structureVersion]);

  const focusPreviousBlock = useEditorFocusStore((s) => s.focusPreviousBlock);
  const focusNextBlock = useEditorFocusStore((s) => s.focusNextBlock);
  const setPendingFocus = useEditorFocusStore((s) => s.setPendingFocus);

  const setRowRef = useCallback((uuid: string, ref: BlockRowHandle | null) => {
    if (ref) {
      rowRefs.current.set(uuid, ref);
    } else {
      rowRefs.current.delete(uuid);
    }
  }, []);

  const canMergeInHierarchy = useCallback(
    (sourceBlockId: string, targetBlockId: string): boolean => {
      const runtime = getOperationRuntime();
      const source = getNode(runtime, sourceBlockId);
      const target = getNode(runtime, targetBlockId);
      if (!source || !target) return false;

      const sourceChildren = getChildren(runtime, sourceBlockId);

      if (source.parentId === target.parentId && sourceChildren.length === 0) {
        return true;
      }

      if (source.parentId === targetBlockId) {
        const targetChildren = getChildren(runtime, targetBlockId);
        if (targetChildren.length === 1) {
          return true;
        }
      }

      return false;
    },
    [],
  );

  const handleEnter = useCallback(
    (blockId: string) => {
      flushAllContentSaves();
      const runtime = getOperationRuntime();
      const row = rowRefs.current.get(blockId);
      const cursor = row?.getCursorPosition() ?? 'empty';

      if (cursor === 'empty' || cursor === 'end') {
        const newBlockId = generateUUID();
        const currentRuntimeNode = getNode(runtime, blockId);
        let parentId = currentRuntimeNode?.parentId ?? '';
        if (!parentId && nodeUuid) {
          parentId = nodeUuid;
        }
        applyRuntimeIntent({
          type: 'create_block',
          parentId,
          afterBlockId: blockId,
          blockId: newBlockId,
          contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: '' }] }],
        });
        getRuntimeEventBus().flushEvents();
        setPendingFocus(newBlockId);
      } else if (cursor === 'start') {
        const currentNode = getNode(runtime, blockId);
        if (!currentNode) return;
        const parentId = currentNode.parentId ?? '';
        const siblings = getChildren(runtime, parentId);
        const currentIndex = siblings.findIndex((s) => s.blockId === blockId);
        const afterBlockId = currentIndex > 0 ? siblings[currentIndex - 1].blockId : null;
        const newBlockId = generateUUID();
        applyRuntimeIntent({
          type: 'create_block',
          parentId,
          afterBlockId,
          blockId: newBlockId,
          contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: '' }] }],
        });
        getRuntimeEventBus().flushEvents();
        setPendingFocus(newBlockId);
      } else {
        const offset = row?.getCursorOffset() ?? 0;
        const newBlockId = generateUUID();
        applyRuntimeIntent({
          type: 'split_block',
          blockId,
          atOffset: offset,
          newBlockId,
        });
        getRuntimeEventBus().flushEvents();
        setPendingFocus(newBlockId);
      }
    },
    [setPendingFocus, nodeUuid],
  );

  const handleBackspaceAtStart = useCallback(
    (blockId: string) => {
      const idx = blockIdsRef.current.indexOf(blockId);
      if (idx <= 0) return;
      const prevBlockId = blockIdsRef.current[idx - 1];

      if (!canMergeInHierarchy(blockId, prevBlockId)) {
        return;
      }

      flushAllContentSaves();
      applyRuntimeIntent({
        type: 'merge_blocks',
        sourceBlockId: blockId,
        targetBlockId: prevBlockId,
      });
      getRuntimeEventBus().flushEvents();
      setPendingFocus(prevBlockId);
    },
    [setPendingFocus, canMergeInHierarchy],
  );

  const handleDeleteAtEnd = useCallback(
    (blockId: string) => {
      const idx = blockIdsRef.current.indexOf(blockId);
      if (idx < 0 || idx >= blockIdsRef.current.length - 1) return;
      const nextBlockId = blockIdsRef.current[idx + 1];

      if (!canMergeInHierarchy(nextBlockId, blockId)) {
        return;
      }

      flushAllContentSaves();
      applyRuntimeIntent({
        type: 'merge_blocks',
        sourceBlockId: nextBlockId,
        targetBlockId: blockId,
      });
      getRuntimeEventBus().flushEvents();
      setPendingFocus(blockId);
    },
    [setPendingFocus, canMergeInHierarchy],
  );

  const handleEscape = useCallback((blockId: string) => {
    useEditorFocusStore.getState().blurBlock(blockId);
    const container = containerRef.current;
    if (container) {
      const blockEl = container.querySelector(`.node-block[data-block-id="${blockId}"]`) as HTMLElement | null;
      if (blockEl) {
        const blockDepth = parseInt(blockEl.getAttribute('data-depth') || '0', 10);
        const allBlocks = Array.from(container.querySelectorAll('.node-block[data-block-id]')) as HTMLElement[];
        const blockIndex = allBlocks.indexOf(blockEl);
        const ids = [blockId];
        for (let i = blockIndex + 1; i < allBlocks.length; i++) {
          const next = allBlocks[i];
          const nextDepth = parseInt(next.getAttribute('data-depth') || '0', 10);
          if (nextDepth <= blockDepth) break;
          const nextId = next.getAttribute('data-block-id');
          if (nextId) ids.push(nextId);
        }
        useBlockSelectionStore.getState().setSelectedIds(ids);
        return;
      }
    }
    useBlockSelectionStore.getState().selectSingle(blockId);
  }, []);

  const handleCollapseToggle = useCallback((blockId: string) => {
    const runtime = getOperationRuntime();
    const node = getNode(runtime, blockId);
    if (!node) return;
    applyRuntimeIntent({
      type: 'set_collapsed',
      blockId,
      collapsed: !node.collapsed,
    });
    getRuntimeEventBus().flushEvents();
  }, []);

  const handleOverlayLineClick = useCallback((blockId: string) => {
    if (readOnly) return;
    handleCollapseToggle(blockId);
  }, [readOnly, handleCollapseToggle]);

  const handleGhostRealize = useCallback((ghostUuid: string) => {
    const parentUuid = parseGhostParentUuid(ghostUuid);
    if (!parentUuid) return;

    flushAllContentSaves();
    const runtime = getOperationRuntime();
    const runtimeChildren = getChildren(runtime, parentUuid);
    const lastRealChild = runtimeChildren.length > 0 ? runtimeChildren[runtimeChildren.length - 1] : null;

    const newBlockId = generateUUID();
    applyRuntimeIntent({
      type: 'create_block',
      parentId: parentUuid,
      afterBlockId: lastRealChild?.blockId ?? null,
      blockId: newBlockId,
      contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: '' }] }],
    });
    getRuntimeEventBus().flushEvents();
    setPendingFocus(newBlockId);
  }, [setPendingFocus]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (!activeBlockId) return;
      const idx = blockIds.indexOf(activeBlockId);
      if (idx < 0) return;

      switch (e.key) {
        case 'Tab': {
          e.preventDefault();
          flushAllContentSaves();
          applyRuntimeIntent({
            type: e.shiftKey ? 'outdent_block' : 'indent_block',
            blockId: activeBlockId,
          });
          getRuntimeEventBus().flushEvents();
          break;
        }
        case 'ArrowUp': {
          e.preventDefault();
          focusPreviousBlock(blockIds);
          break;
        }
        case 'ArrowDown': {
          e.preventDefault();
          focusNextBlock(blockIds);
          break;
        }
      }
    },
    [activeBlockId, blockIds, focusPreviousBlock, focusNextBlock],
  );

  // ─── Virtualization ─────────────────────────────────────────────

  const enableVirtualization = flatNodes.length > 30;

  const scrollElementRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!containerRef.current) return;
    let el: HTMLElement | null = containerRef.current;
    while (el) {
      const style = window.getComputedStyle(el);
      if (/(auto|scroll)/.test(style.overflow + style.overflowY + style.overflowX)) {
        scrollElementRef.current = el;
        return;
      }
      el = el.parentElement;
    }
    scrollElementRef.current = null;
  }, []);

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual's `useVirtualizer()` API returns non-memoized functions by design.
  const virtualizer = useVirtualizer({
    count: flatNodes.length,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: () => 32,
    overscan: 10,
    scrollPaddingEnd: 80,
    enabled: enableVirtualization,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  useEffect(() => {
    const pending = useEditorFocusStore.getState().pendingFocusBlockId;
    if (!pending) return;
    const row = rowRefs.current.get(pending);
    if (row) {
      row.focus();
      useEditorFocusStore.getState().setPendingFocus(null);
    } else if (enableVirtualization) {
      const idx = blockIds.indexOf(pending);
      if (idx >= 0) {
        virtualizer.scrollToIndex(idx, { align: 'center' });
      }
    }
  });

  // ─── Render ─────────────────────────────────────────────────────

  const [isDragOver, setIsDragOver] = useState(false);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (readOnly || !onDropFiles) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setIsDragOver(true);
  }, [readOnly, onDropFiles]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (readOnly || !onDropFiles) return;
    e.preventDefault();
    setIsDragOver(false);
  }, [readOnly, onDropFiles]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    if (readOnly || !onDropFiles) return;
    e.preventDefault();
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      onDropFiles(files);
    }
  }, [readOnly, onDropFiles]);

  return (
    <div
      ref={containerRef}
      className={`block-list notees-editor ${isDragOver ? 'drag-over' : ''}`}
      onKeyDown={handleKeyDown}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      role="application"
      aria-label="Block editor"
      tabIndex={-1}
    >
      {enableVirtualization ? (
        <>
          <BulletLineOverlay
            containerRef={containerRef}
            flatNodes={flatNodes}
            virtualized
            virtualItems={virtualItems.map((vi) => ({ index: vi.index, start: vi.start, end: vi.end }))}
            onLineClick={handleOverlayLineClick}
          />
          <div style={{ position: 'relative', height: `${totalSize}px` }}>
          {virtualItems.map((virtualRow) => {
            const { node, depth, effectiveCollapsed, isGhost } = flatNodes[virtualRow.index];
            return (
              <div
                key={node.uuid}
                ref={virtualizer.measureElement}
                data-index={virtualRow.index}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <BlockRow
                  ref={(ref) => setRowRef(node.uuid, ref)}
                  node={node}
                  depth={depth}
                  effectiveCollapsed={effectiveCollapsed}
                  isGhost={isGhost}
                  isOnActiveTrail={activeTrailIds.has(node.uuid)}
                  useOverlayForGuides
                  onGhostRealize={handleGhostRealize}
                  readOnly={readOnly}
                  placeholder={placeholder}
                  onContentChange={onContentChange}
                  onPillClick={onPillClick}
                  onPillRemove={onPillRemove}
                  onNavigate={onNavigateToNode}
                  onOpenInSidebar={onOpenInSidebar}
                  onAddClass={onAddClass}
                  onSlashCommand={onSlashCommand}
                  onPasteImage={onPasteImage}
                  onTemplateInstantiate={onTemplateInstantiate}
                  templateClassFilters={templateClassFilters}
                  nodeUuid={nodeUuid}
                  showClasses={showClasses}
                  onEnter={handleEnter}
                  onBackspaceAtStart={handleBackspaceAtStart}
                  onDeleteAtEnd={handleDeleteAtEnd}
                  onEscape={handleEscape}
                  onCollapseToggle={handleCollapseToggle}
                />
              </div>
            );
          })}
        </div>
      </>
      ) : (
        <>
          <BulletLineOverlay
            containerRef={containerRef}
            flatNodes={flatNodes}
            virtualized={false}
            onLineClick={handleOverlayLineClick}
          />
          {flatNodes.map(({ node, depth, effectiveCollapsed, isGhost }) => (
            <BlockRow
              key={node.uuid}
              ref={(ref) => setRowRef(node.uuid, ref)}
              node={node}
              depth={depth}
              effectiveCollapsed={effectiveCollapsed}
              isGhost={isGhost}
              isOnActiveTrail={activeTrailIds.has(node.uuid)}
              useOverlayForGuides
              onGhostRealize={handleGhostRealize}
            readOnly={readOnly}
            placeholder={placeholder}
            onContentChange={onContentChange}
            onPillClick={onPillClick}
            onPillRemove={onPillRemove}
            onNavigate={onNavigateToNode}
            onOpenInSidebar={onOpenInSidebar}
            onAddClass={onAddClass}
            onSlashCommand={onSlashCommand}
            onPasteImage={onPasteImage}
            onTemplateInstantiate={onTemplateInstantiate}
            templateClassFilters={templateClassFilters}
            nodeUuid={nodeUuid}
            showClasses={showClasses}
            onEnter={handleEnter}
            onBackspaceAtStart={handleBackspaceAtStart}
            onDeleteAtEnd={handleDeleteAtEnd}
            onEscape={handleEscape}
            onCollapseToggle={handleCollapseToggle}
          />
        ))}
      </>
      )}
      {!readOnly && <BlockFindReplacePlugin />}
    </div>
  );
}