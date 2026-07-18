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
import { useParams } from 'react-router-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useUIStateStore } from '@/features/sync';
import { useBlockTree, parseGhostParentUuid, isValidServerNodeId } from '@/features/content/hooks/useBlockTree';
import { BlockRow, type BlockRowHandle } from './BlockRow';
import { BulletLineOverlay } from './BulletLineOverlay';
import { useEditorFocusStore } from '@/stores/editorFocusStore';
import type { Node } from '@/types/api';
import { useBlockDragDrop } from '@/features/content/hooks/useBlockDragDrop';
import type { DropAnchor } from '@/features/content/hooks/useBlockDragDrop.utils';
import { useBlockSelection } from '@/features/content/hooks/useBlockSelection';
import { useBlockSelectionStore } from '@/stores/blockSelectionStore';
import { useTouchIndent } from '@/features/content/hooks/useTouchIndent';
import { BlockFindReplacePlugin } from '@/features/editor';
import { flushAllContentSaves } from '@/features/editor';
import './BlockList.css';
import { useWorkspaceStore } from '@/core/hooks';
import { useCoreBlockMutations } from '@/features/content/hooks/useCoreBlockMutations';

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
  onAddClass?: (blockServerId: string, classId: string) => void;
  /** Called when a slash command is selected. */
  onSlashCommand?: (commandId: string, blockServerId: string | undefined) => void;
  /** Called when an image is pasted into a block. */
  onPasteImage?: (blockServerId: string, file: File, hasContent: boolean) => void;
  /** Called when files are dropped from outside the browser. */
  onDropFiles?: (files: File[]) => void;
  /** Called when a template is selected. */
  onTemplateInstantiate?: (templateNodeId: string, blockServerId: string | undefined) => void;
  /** Class UUIDs to pre-filter template picker. */
  templateClassFilters?: string[];
  /** Server ID of the containing node (for runtime parent resolution). */
  nodeUuid?: string;
  /** Whether to show class pills below each block's content. */
  showClasses?: boolean;
  /** Force all nodes to be expanded, ignoring stored collapsed state. */
  expandAll?: boolean;
  /** Whether this list is rendered inside a card context. */
  inCard?: boolean;
  /** Compact list-view size context (e.g. 'sm' for small list view). */
  listSize?: 'sm' | 'md';
  /** Whether this list is rendered inside a property text block editor. */
  inPropertyEditor?: boolean;
  /** When false, hide the trailing "new block" pseudo block (default: true). */
  showNewBlock?: boolean;
  /** When true, hide the bullet on the root/top-level blocks only. */
  hideRootBullet?: boolean;
  /** Document mode: hide bullets and flatten chrome. */
  documentMode?: boolean;
  /** When true, removes vertical padding so the list sits flush in a container. */
  flush?: boolean;
  /** When true, the root container is a block (focused block view), so the trailing
   *  "new block" pseudo-block is indented one level deeper. */
  rootIsBlock?: boolean;
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
      showClasses = false,
      expandAll = false,
      inCard = false,
      listSize,
      inPropertyEditor = false,
      showNewBlock = true,
      hideRootBullet = false,
      documentMode = false,
      flush = false,
      rootIsBlock = false }: BlockListProps): JSX.Element {
  const { flatNodes, structureVersion } = useBlockTree(nodes, {
    maxDepth,
    pagesOnly,
    skipPages,
    expandAll,
    nodeUuid,
    readOnly,
    showNewBlock,
    rootIsBlock,
  });

  // Debug duplicate flat node UUIDs before React warns about them.
  if (process.env.NODE_ENV === 'development') {
    const seenUuids = new Set<string>();
    const duplicateUuids: string[] = [];
    for (const { node } of flatNodes) {
      if (seenUuids.has(node.uuid)) {
        if (!duplicateUuids.includes(node.uuid)) duplicateUuids.push(node.uuid);
      } else {
        seenUuids.add(node.uuid);
      }
    }
    if (duplicateUuids.length > 0) {
      console.error(
        '[BlockList] Duplicate flat node UUIDs detected (this will cause React key warnings):',
        duplicateUuids,
        new Error().stack
      );
    }
  }

  const blockIds = useMemo(() => flatNodes.filter((n) => !n.isGhost).map((n) => n.node.uuid), [flatNodes]);
  const ghostIds = useMemo(() => flatNodes.filter((n) => n.isGhost).map((n) => n.node.uuid), [flatNodes]);
  const blockIdsRef = useRef(blockIds);
  useLayoutEffect(() => {
    blockIdsRef.current = blockIds;
  }, [blockIds]);
  const rowRefs = useRef<Map<string, BlockRowHandle>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);


  useBlockSelection({ containerRef, blockIds, readOnly });
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { store } = useWorkspaceStore(workspaceId ?? '');
  const mutations = useCoreBlockMutations(workspaceId);
  const activeBlockId = useEditorFocusStore((s) => s.activeBlockId);
  const toggleCollapsed = useUIStateStore((s) => s.toggleCollapsed);

  useTouchIndent({
    containerRef,
    readOnly,
    onIndent: async (blockId) => {
      await mutations.indentBlock({ blockId });
    },
    onOutdent: async (blockId) => {
      await mutations.outdentBlock({ blockId });
    },
  });

  const handleBlockDrop = useCallback(
    async (anchor: DropAnchor, draggedBlockIds: string[]) => {
      if (!store) return;
      let newParentId: string | null = null;
      if (anchor.target.position === 'child') {
        newParentId = anchor.target.blockId;
      } else {
        newParentId = store.getNode(anchor.target.blockId)?.parentId ?? nodeUuid ?? null;
      }
      if (!newParentId) return;

      // Prevent dropping a block onto itself or its descendants.
      const descendantIds = new Set<string>();
      const stack = [newParentId];
      while (stack.length > 0) {
        const current = stack.pop()!;
        for (const childId of store.getChildren(current)) {
          descendantIds.add(childId);
          stack.push(childId);
        }
      }

      for (const blockId of draggedBlockIds) {
        if (blockId === newParentId || descendantIds.has(blockId)) continue;
        await mutations.moveBlock({ blockId, newParentId });
      }
    },
    [store, nodeUuid, mutations],
  );

  useBlockDragDrop({
    containerRef,
    editorId: 'block-list',
    readOnly,
    excludedIds: ghostIds,
    onDrop: handleBlockDrop,
  });

  // Compute ancestor UUIDs of the active block so each row can know whether it
  // sits on the active editing path. This replaces the imperative DOM class
  // toggling that the old thread-line system used.
  const activeTrailIds = useMemo(() => {
    if (!activeBlockId || !store) return new Set<string>();
    // structureVersion is intentionally unused inside the callback; it acts as
    // a signal that the core tree structure changed, so we must re-walk the
    // active block's ancestors.
    void structureVersion;
    const trail = new Set<string>();
    let current = store.getNode(activeBlockId);
    while (current?.parentId) {
      const parent = store.getNode(current.parentId);
      if (!parent) break;
      trail.add(parent.id);
      current = parent;
    }
    return trail;
  }, [activeBlockId, structureVersion, store]);

  const focusPreviousBlock = useEditorFocusStore((s) => s.focusPreviousBlock);
  const focusNextBlock = useEditorFocusStore((s) => s.focusNextBlock);
  const setPendingFocus = useEditorFocusStore((s) => s.setPendingFocus);

  const setRowRef = useCallback((blockUuid: string, ref: BlockRowHandle | null) => {
    if (ref) {
      rowRefs.current.set(blockUuid, ref);
    } else {
      rowRefs.current.delete(blockUuid);
    }
  }, []);

  const canMergeInHierarchy = useCallback(
    (sourceBlockId: string, targetBlockId: string): boolean => {
      if (!store) return false;
      const source = store.getNode(sourceBlockId);
      const target = store.getNode(targetBlockId);
      if (!source || !target) return false;

      const sourceChildren = store.getChildren(sourceBlockId);

      if (source.parentId === target.parentId && sourceChildren.length === 0) {
        return true;
      }

      if (source.parentId === targetBlockId) {
        const targetChildren = store.getChildren(targetBlockId);
        if (targetChildren.length === 1) {
          return true;
        }
      }

      return false;
    },
    [store],
  );

  const handleEnter = useCallback(
    async (blockId: string) => {
      flushAllContentSaves();
      const row = rowRefs.current.get(blockId);
      const cursor = row?.getCursorPosition() ?? 'empty';

      if (cursor === 'empty' || cursor === 'end') {
        const hasChildren = store ? store.getChildren(blockId).length > 0 : false;
        let parentId: string | null = null;
        if (hasChildren) {
          // When a block already has children, create the new block as its first
          // child instead of a sibling after the entire subtree.
          parentId = blockId;
        } else {
          const currentNode = store?.getNode(blockId);
          parentId = currentNode?.parentId ?? null;
          if (!parentId && nodeUuid) {
            parentId = nodeUuid;
          }
        }
        const newBlockId = await mutations.createBlock({
          parentId,
          contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: '' }] }],
        });
        setPendingFocus(newBlockId);
      } else if (cursor === 'start') {
        const currentNode = store?.getNode(blockId);
        if (!currentNode) return;
        const parentId = currentNode.parentId;
        const newBlockId = await mutations.createBlock({
          parentId,
          contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: '' }] }],
        });
        setPendingFocus(newBlockId);
      } else {
        const offset = row?.getCursorOffset() ?? 0;
        const newBlockId = await mutations.splitBlock({ blockId, atOffset: offset });
        setPendingFocus(newBlockId);
      }
    },
    [setPendingFocus, nodeUuid, store, mutations],
  );

  const handleBackspaceAtStart = useCallback(
    async (blockId: string) => {
      const idx = blockIdsRef.current.indexOf(blockId);
      if (idx <= 0) return;
      const prevBlockId = blockIdsRef.current[idx - 1];

      if (!canMergeInHierarchy(blockId, prevBlockId)) {
        return;
      }

      flushAllContentSaves();
      await mutations.mergeBlocks({
        sourceBlockId: blockId,
        targetBlockId: prevBlockId,
      });
      setPendingFocus(prevBlockId);
    },
    [setPendingFocus, canMergeInHierarchy, mutations],
  );

  const handleDeleteAtEnd = useCallback(
    async (blockId: string) => {
      const idx = blockIdsRef.current.indexOf(blockId);
      if (idx < 0 || idx >= blockIdsRef.current.length - 1) return;
      const nextBlockId = blockIdsRef.current[idx + 1];

      if (!canMergeInHierarchy(nextBlockId, blockId)) {
        return;
      }

      flushAllContentSaves();
      await mutations.mergeBlocks({
        sourceBlockId: nextBlockId,
        targetBlockId: blockId,
      });
      setPendingFocus(blockId);
    },
    [setPendingFocus, canMergeInHierarchy, mutations],
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
    if (!workspaceId) return;
    toggleCollapsed(workspaceId, blockId);
  }, [workspaceId, toggleCollapsed]);

  const handleOverlayLineClick = useCallback((blockId: string) => {
    if (readOnly) return;
    handleCollapseToggle(blockId);
  }, [readOnly, handleCollapseToggle]);

  const handleGhostRealize = useCallback(async (ghostUuid: string) => {
    const parentUuid = parseGhostParentUuid(ghostUuid);
    if (!parentUuid) return;

    // Defensive guard: the parent encoded in a ghost ID must be a plausible
    // server-side node UUID. Virtual roots, pseudo UUIDs, and other synthetic
    // IDs cannot own persisted blocks, so creating under them would generate a
    // sync conflict and a subsequent 404 fetch.
    if (!isValidServerNodeId(parentUuid)) {
      if (process.env.NODE_ENV === 'development') {
        console.warn('[BlockList] Ghost realize aborted: parent UUID is not a valid server node ID:', parentUuid);
      }
      return;
    }

    flushAllContentSaves();
    const runtimeChildren = store ? store.getChildren(parentUuid) : [];
    const lastRealChild = runtimeChildren.length > 0 ? runtimeChildren[runtimeChildren.length - 1] : null;

    const newBlockId = await mutations.createBlock({
      parentId: parentUuid,
      afterBlockId: lastRealChild ?? null,
      contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: '' }] }],
    });
    setPendingFocus(newBlockId);
  }, [setPendingFocus, store, mutations]);

  const handleIndentOutdentSelected = useCallback(
    async (shiftKey: boolean) => {
      const selectedSet = useBlockSelectionStore.getState().selectedIds;
      if (selectedSet.size === 0 || !store) return;

      const orderedIds = blockIds.filter((id) => selectedSet.has(id));
      const topLevelIds = orderedIds.filter((id) => {
        const n = store.getNode(id);
        return n && (!n.parentId || !selectedSet.has(n.parentId));
      });
      if (topLevelIds.length === 0) return;

      flushAllContentSaves();

      if (shiftKey) {
        for (const blockId of topLevelIds) {
          await mutations.outdentBlock({ blockId });
        }
      } else {
        for (const parentId of new Set(topLevelIds.map((id) => store.getNode(id)?.parentId ?? ''))) {
          const siblings = parentId ? store.getChildren(parentId) : [];
          const siblingIds = siblings;
          const runCandidates = topLevelIds.filter((id) => store.getNode(id)?.parentId === parentId);

          let currentRun: string[] = [];
          let lastIndex = -2;

          const flushRun = () => {
            if (currentRun.length === 0) return;
            const firstIndex = siblingIds.indexOf(currentRun[0]!);
            if (firstIndex > 0) {
              const targetParentId = siblingIds[firstIndex - 1]!;
              for (const blockId of currentRun) {
                void mutations.moveBlock({ blockId, newParentId: targetParentId });
              }
            }
            currentRun = [];
          };

          for (const id of runCandidates) {
            const idx = siblingIds.indexOf(id);
            if (idx === lastIndex + 1) {
              currentRun.push(id);
            } else {
              flushRun();
              currentRun = [id];
            }
            lastIndex = idx;
          }
          flushRun();
        }
      }
    },
    [blockIds, store, mutations],
  );

  const handleKeyDown = useCallback(
    async (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Tab') {
        const activeEl = document.activeElement as HTMLElement | null;
        const focusInEditor = activeEl && containerRef.current?.contains(activeEl) && activeBlockId;

        if (focusInEditor) {
          e.preventDefault();
          flushAllContentSaves();
          if (e.shiftKey) {
            await mutations.outdentBlock({ blockId: activeBlockId });
          } else {
            await mutations.indentBlock({ blockId: activeBlockId });
          }
          return;
        }

        const selectedIds = useBlockSelectionStore.getState().selectedIds;
        if (selectedIds.size > 0) {
          e.preventDefault();
          await handleIndentOutdentSelected(e.shiftKey);
        }
        return;
      }

      if (!activeBlockId) return;
      const idx = blockIds.indexOf(activeBlockId);
      if (idx < 0) return;

      switch (e.key) {
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
    [activeBlockId, blockIds, focusPreviousBlock, focusNextBlock, handleIndentOutdentSelected, mutations],
  );

  // ─── Virtualization ─────────────────────────────────────────────

  const enableVirtualization = flatNodes.length > 30;

  // Locate the nearest scrollable ancestor. This is stored in state (not a ref)
  // so that the virtualizer re-subscribes when the element becomes available.
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!containerRef.current) return;
    let el: HTMLElement | null = containerRef.current;
    while (el) {
      const style = window.getComputedStyle(el);
      if (/(auto|scroll)/.test(style.overflow + style.overflowY + style.overflowX)) {
        setScrollElement(el);
        return;
      }
      el = el.parentElement;
    }
    setScrollElement(null);
  }, []);

  // The virtual list sits inside a scrollable ancestor (e.g. .main-content) that
  // has other content above it. TanStack Virtual assumes the list starts at
  // scrollTop 0 of that ancestor, so we must tell it the real offset of the
  // virtual list container within the scroll element.
  const innerContainerRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  const recomputeScrollMargin = useCallback(() => {
    const scrollEl = scrollElement;
    const innerEl = innerContainerRef.current;
    if (!scrollEl || !innerEl) {
      setScrollMargin(0);
      return;
    }
    const scrollRect = scrollEl.getBoundingClientRect();
    const innerRect = innerEl.getBoundingClientRect();
    const margin = Math.round(innerRect.top - scrollRect.top + scrollEl.scrollTop);
    setScrollMargin(Math.max(0, margin));
  }, [scrollElement]);

  useLayoutEffect(() => {
    recomputeScrollMargin();
  }, [recomputeScrollMargin, flatNodes.length, enableVirtualization]);

  useEffect(() => {
    const handleResize = () => recomputeScrollMargin();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [recomputeScrollMargin]);

  useEffect(() => {
    const innerEl = innerContainerRef.current;
    const scrollEl = scrollElement;
    if (!innerEl || !scrollEl || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(() => recomputeScrollMargin());
    observer.observe(innerEl);
    observer.observe(scrollEl);
    return () => observer.disconnect();
  }, [recomputeScrollMargin, scrollElement]);

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual's `useVirtualizer()` API returns non-memoized functions by design.
  const virtualizer = useVirtualizer({
    count: flatNodes.length,
    getScrollElement: () => scrollElement,
    estimateSize: () => 36,
    overscan: 10,
    scrollMargin,
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
      data-document-mode={documentMode || undefined}
      data-flush={flush || undefined}
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
          <div ref={innerContainerRef} style={{ position: 'relative', height: `${totalSize}px` }}>
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
                  // scrollMargin is the inner list's offset from the scrollable
                  // ancestor; subtract it so items are positioned relative to the
                  // inner container, not the top of the scroll element.
                  transform: `translateY(${virtualRow.start - scrollMargin}px)`,
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
                  inCard={inCard}
                  listSize={listSize}
                  inPropertyEditor={inPropertyEditor}
                  hideBullet={hideRootBullet && depth === 0}
                  documentMode={documentMode}
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
            inCard={inCard}
            listSize={listSize}
            inPropertyEditor={inPropertyEditor}
            hideBullet={hideRootBullet && depth === 0}
            documentMode={documentMode}
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