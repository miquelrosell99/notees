/* eslint-disable jsx-a11y/no-noninteractive-element-interactions */
/**
 * BlockList — List container for the block-level editor.
 *
 * Renders BlockRow components for each visible block.
 * Handles list-level keyboard navigation (Enter, Backspace, Tab, Arrows).
 * Large lists (>50 items) are window-virtualized with @tanstack/react-virtual.
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
import { apiNodesToGraphNodes } from '@/hooks/useRuntimeSync';
import { useStructureSync } from '@/hooks/useStructureSync';
import { useBlockPersist } from '@/hooks/useBlockPersist';
import { BlockRow, type BlockRowHandle } from './BlockRow';
import { useEditorFocusStore } from '@/stores/editorFocusStore';
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
import { generateUUID } from '@/utils/uuid';
import type { Node } from '@/types/api';
import { useBlockDragDrop } from '@/hooks/useBlockDragDrop';
import { useBlockSelection } from '@/hooks/useBlockSelection';
import { useBlockSelectionStore } from '@/stores/blockSelectionStore';
import { useTouchIndent } from '@/hooks/useTouchIndent';
import { BlockFindReplacePlugin } from '@/features/content/editor/plugins/BlockFindReplacePlugin';
import { flushAllContentSaves } from '@/hooks/useContentSave';
import './BlockList.css';

// ─── Types ────────────────────────────────────────────────────────

interface FlatNode {
  node: Node;
  depth: number;
  effectiveCollapsed: boolean;
}

interface BlockListProps {
  /** Tree of nodes (will be flattened with depth). */
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

// ─── Helpers ──────────────────────────────────────────────────────

/** Flatten a node tree into a list with depth, respecting collapsed state and filters. */
function flattenNodes(
  nodes: Node[],
  maxDepth: number,
  pagesOnly: boolean,
  skipPages: boolean,
  currentDepth = 0,
  expandAll = false,
): FlatNode[] {
  const result: FlatNode[] = [];
  for (const node of nodes) {
    // Apply filters
    if (node.is_comment) continue;
    if (pagesOnly && !node.is_page) continue;
    if (skipPages && node.is_page) continue;

    const effectiveCollapsed = expandAll ? false : node.collapsed;
    result.push({ node, depth: currentDepth, effectiveCollapsed });
    if (
      node.children &&
      node.children.length > 0 &&
      !effectiveCollapsed &&
      (maxDepth < 0 || currentDepth < maxDepth)
    ) {
      result.push(...flattenNodes(node.children, maxDepth, pagesOnly, skipPages, currentDepth + 1, expandAll));
    }
  }
  return result;
}

/**
 * Flatten nodes using the runtime's current structure (parent/child/order).
 * This makes drag-and-drop, indent, and outdent reflect immediately without
 * waiting for a query refetch.
 */
function flattenNodesFromRuntime(
  nodes: Node[],
  maxDepth: number,
  pagesOnly: boolean,
  skipPages: boolean,
  runtime: ReturnType<typeof getNodeGraphRuntime>,
  expandAll = false,
): FlatNode[] {
  // Build UUID → Node map from the prop
  const nodeMap = new Map<string, Node>();
  const collect = (n: Node) => {
    nodeMap.set(n.uuid, n);
    if (n.children) for (const c of n.children) collect(c);
  };
  for (const n of nodes) collect(n);

  // Group nodes by their parent ID.
  // Prefer runtime parentId only when it points to a parent within the
  // current node set (avoids stale parentIds from previous views).
  // Otherwise fall back to the prop's parent_id so server tree data wins.
  const byParent = new Map<string, Node[]>();
  for (const [uuid, node] of nodeMap) {
    const graphNode = runtime.getNode(uuid);
    const propParentId = node.parent_id?.toString() || '__root__';
    const runtimeParentId = graphNode?.parentId;
    const parentId = (runtimeParentId && nodeMap.has(runtimeParentId))
      ? runtimeParentId
      : propParentId;
    if (!byParent.has(parentId)) byParent.set(parentId, []);
    byParent.get(parentId)!.push(node);
  }

  // Sort each parent's children by runtime orderIndex, falling back to API sequence
  for (const [, children] of byParent) {
    children.sort((a, b) => {
      const ga = runtime.getNode(a.uuid);
      const gb = runtime.getNode(b.uuid);
      const orderA = ga?.orderIndex ?? a.sequence ?? 0;
      const orderB = gb?.orderIndex ?? b.sequence ?? 0;
      if (orderA !== orderB) return orderA - orderB;
      // Tie-breaker: use API sequence when runtime orderIndex is equal
      const seqA = a.sequence ?? 0;
      const seqB = b.sequence ?? 0;
      return seqA - seqB;
    });
  }

  // Recursive flattener
  const flatten = (uuids: string[], depth: number): FlatNode[] => {
    if (maxDepth >= 0 && depth > maxDepth) return [];
    const result: FlatNode[] = [];
    for (const uuid of uuids) {
      const node = nodeMap.get(uuid);
      if (!node) continue;
      if (node.is_comment) continue;
      if (pagesOnly && !node.is_page) continue;
      if (skipPages && node.is_page) continue;
      const graphNode = runtime.getNode(uuid);
      const effectiveCollapsed = expandAll ? false : (graphNode?.collapsed ?? node.collapsed);
      result.push({ node, depth, effectiveCollapsed });

      if (!effectiveCollapsed && (maxDepth < 0 || depth < maxDepth)) {
        // Children are indexed by their parent UUID, which is this node's UUID
        const children = byParent.get(uuid) || [];
        result.push(...flatten(children.map(c => c.uuid), depth + 1));
      }
    }
    return result;
  };

  // Determine top-level nodes (those whose parent is not in our map)
  const topLevel: string[] = [];
  for (const [uuid, node] of nodeMap) {
    const graphNode = runtime.getNode(uuid);
    const propParentId = node.parent_id?.toString() || '__root__';
    const runtimeParentId = graphNode?.parentId;
    const parentId = (runtimeParentId && nodeMap.has(runtimeParentId))
      ? runtimeParentId
      : propParentId;
    if (!nodeMap.has(parentId)) topLevel.push(uuid);
  }

  // Sort top-level by runtime orderIndex, falling back to API sequence
  topLevel.sort((a, b) => {
    const ga = runtime.getNode(a);
    const gb = runtime.getNode(b);
    const na = nodeMap.get(a);
    const nb = nodeMap.get(b);
    const orderA = ga?.orderIndex ?? na?.sequence ?? 0;
    const orderB = gb?.orderIndex ?? nb?.sequence ?? 0;
    if (orderA !== orderB) return orderA - orderB;
    const seqA = na?.sequence ?? 0;
    const seqB = nb?.sequence ?? 0;
    return seqA - seqB;
  });

  return flatten(topLevel, 0);
}

// ─── Component ────────────────────────────────────────────────────

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
  // Subscribe to runtime structural changes so the UI updates immediately
  // after drag-and-drop, indent, outdent, etc.
  const [structureVersion, setStructureVersion] = useState(0);
  useEffect(() => {
    const runtime = getNodeGraphRuntime();
    const unsubscribe = runtime.subscribe((event) => {
      if (event.type === 'structure_changed' || event.type === 'nodes_changed') {
        setStructureVersion((v) => v + 1);
      }
    });
    return unsubscribe;
  }, []);

  const flatNodes = useMemo(() => {
    const runtime = getNodeGraphRuntime();
    const hasRuntimeData = nodes.some((n) => runtime.getNode(n.uuid) != null);
    if (!hasRuntimeData) {
      return flattenNodes(nodes, maxDepth, pagesOnly, skipPages, 0, expandAll);
    }
    return flattenNodesFromRuntime(nodes, maxDepth, pagesOnly, skipPages, runtime, expandAll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, maxDepth, pagesOnly, skipPages, structureVersion]);

  const blockIds = useMemo(() => flatNodes.map((n) => n.node.uuid), [flatNodes]);
  const blockIdsRef = useRef(blockIds);
  useLayoutEffect(() => {
    blockIdsRef.current = blockIds;
  }, [blockIds]);
  const rowRefs = useRef<Map<string, BlockRowHandle>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);

  // Sync nodes to runtime so structural ops (drag, indent, outdent) and
  // content saves have the graph data they need.
  // Using useLayoutEffect so the sync happens before paint — eliminating
  // the race where a fast Enter press runs before the runtime is populated.
  useLayoutEffect(() => {
    const runtime = getNodeGraphRuntime();
    const allNodes: Node[] = [];
    const collect = (n: Node) => {
      allNodes.push(n);
      if (n.children) for (const child of n.children) collect(child);
    };
    for (const n of nodes) collect(n);

    if (allNodes.length > 0) {
      const { graphNodes } = apiNodesToGraphNodes(allNodes, nodeId, nodeUuid);
      // In collection views (no containing page), reset collapsed state from
      // server so stale runtime state from previous views doesn't hide children.
      runtime.upsertNodes(graphNodes, { preserveCollapsed: nodeUuid != null });
      // Force-expand all nodes when expandAll is requested (e.g. All Pages view).
      if (expandAll) {
        for (const gn of graphNodes) {
          runtime.applyIntent({ type: 'set_collapsed', blockId: gn.blockId, collapsed: false });
        }
        runtime.flushEvents();
      }
    }

    if (nodeId != null && nodeUuid) {
      runtime.registerParentServerId(nodeUuid, nodeId);
    }
  }, [nodes, nodeId, nodeUuid]);

  useStructureSync({ enabled: !readOnly });
  useBlockPersist({ enabled: !readOnly });

  useBlockDragDrop({ containerRef, editorId: 'block-list', readOnly });
  useBlockSelection({ containerRef, blockIds, readOnly });
  useTouchIndent({
    containerRef,
    readOnly,
    onIndent: (blockId) => {
      const runtime = getNodeGraphRuntime();
      runtime.applyIntent({ type: 'indent_block', blockId });
      runtime.flushEvents();
    },
    onOutdent: (blockId) => {
      const runtime = getNodeGraphRuntime();
      runtime.applyIntent({ type: 'outdent_block', blockId });
      runtime.flushEvents();
    },
  });

  const activeBlockId = useEditorFocusStore((s) => s.activeBlockId);
  const focusPreviousBlock = useEditorFocusStore((s) => s.focusPreviousBlock);
  const focusNextBlock = useEditorFocusStore((s) => s.focusNextBlock);
  const setPendingFocus = useEditorFocusStore((s) => s.setPendingFocus);

  // Keep row refs stable
  const setRowRef = useCallback((uuid: string, ref: BlockRowHandle | null) => {
    if (ref) {
      rowRefs.current.set(uuid, ref);
    } else {
      rowRefs.current.delete(uuid);
    }
  }, []);

  // ─── Per-block keyboard callbacks (passed to InlineEditorKeysPlugin) ─

  // ─── Merge guard (ported from old BlockPlugin) ───────────────────

  const canMergeInHierarchy = useCallback(
    (sourceBlockId: string, targetBlockId: string): boolean => {
      const runtime = getNodeGraphRuntime();
      const source = runtime.getNode(sourceBlockId);
      const target = runtime.getNode(targetBlockId);
      if (!source || !target) return false;

      const sourceChildren = runtime.getChildren(sourceBlockId);

      // Case 1: source is sibling of target (same parent) and has no children
      if (source.parentId === target.parentId && sourceChildren.length === 0) {
        return true;
      }

      // Case 2: source is the only child of target
      if (source.parentId === targetBlockId) {
        const targetChildren = runtime.getChildren(targetBlockId);
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
      const runtime = getNodeGraphRuntime();
      const row = rowRefs.current.get(blockId);
      const cursor = row?.getCursorPosition() ?? 'empty';

      if (cursor === 'empty' || cursor === 'end') {
        const newBlockId = generateUUID();
        const currentRuntimeNode = runtime.getNode(blockId);
        let parentId = currentRuntimeNode?.parentId ?? '';
        // Fallback: if the runtime doesn't have a valid parent (e.g. node was
        // loaded before nodeUuid/nodeId were available), use nodeUuid.
        if (!parentId && nodeUuid) {
          parentId = nodeUuid;
        }
        runtime.applyIntent({
          type: 'create_block',
          parentId,
          afterBlockId: blockId,
          blockId: newBlockId,
          contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: '' }] }],
        });
        runtime.flushEvents();
        setPendingFocus(newBlockId);
      } else if (cursor === 'start') {
        // Old BlockPlugin: Enter at offset 0 creates an empty block BEFORE current
        const currentNode = runtime.getNode(blockId);
        if (!currentNode) return;
        const parentId = currentNode.parentId ?? '';
        const siblings = runtime.getChildren(parentId);
        const currentIndex = siblings.findIndex((s) => s.blockId === blockId);
        const afterBlockId = currentIndex > 0 ? siblings[currentIndex - 1].blockId : null;
        const newBlockId = generateUUID();
        runtime.applyIntent({
          type: 'create_block',
          parentId,
          afterBlockId,
          blockId: newBlockId,
          contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: '' }] }],
        });
        runtime.flushEvents();
        setPendingFocus(newBlockId);
      } else {
        const offset = row?.getCursorOffset() ?? 0;
        const newBlockId = generateUUID();
        runtime.applyIntent({
          type: 'split_block',
          blockId,
          atOffset: offset,
          newBlockId,
        });
        runtime.flushEvents();
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
      const runtime = getNodeGraphRuntime();
      runtime.applyIntent({
        type: 'merge_blocks',
        sourceBlockId: blockId,
        targetBlockId: prevBlockId,
      });
      runtime.flushEvents();
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
      const runtime = getNodeGraphRuntime();
      runtime.applyIntent({
        type: 'merge_blocks',
        sourceBlockId: nextBlockId,
        targetBlockId: blockId,
      });
      runtime.flushEvents();
      setPendingFocus(blockId);
    },
    [setPendingFocus, canMergeInHierarchy],
  );

  const handleTab = useCallback(
    (blockId: string, shift: boolean) => {
      const runtime = getNodeGraphRuntime();
      runtime.applyIntent({
        type: shift ? 'outdent_block' : 'indent_block',
        blockId,
      });
      runtime.flushEvents();
    },
    [],
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
    const runtime = getNodeGraphRuntime();
    const node = runtime.getNode(blockId);
    if (!node) return;
    runtime.applyIntent({
      type: 'set_collapsed',
      blockId,
      collapsed: !node.collapsed,
    });
    runtime.flushEvents();
  }, []);

  // ─── Container keyboard handler (ArrowUp / ArrowDown only) ──────

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
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
    [activeBlockId, blockIds, focusPreviousBlock, focusNextBlock],
  );

  // ─── Virtualization ─────────────────────────────────────────────

  const enableVirtualization = flatNodes.length > 50;

  // Find the nearest scrollable parent so virtualization works in any context
  // (main-content, sidebar, modal, etc.)
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

  // Focus pending block, scrolling into view if virtualized away
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
        <div style={{ position: 'relative', height: `${totalSize}px` }}>
          {virtualItems.map((virtualRow) => {
            const { node, depth, effectiveCollapsed } = flatNodes[virtualRow.index];
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
                  onTab={handleTab}
                  onEscape={handleEscape}
                  onCollapseToggle={handleCollapseToggle}
                />
              </div>
            );
          })}
        </div>
      ) : (
        flatNodes.map(({ node, depth, effectiveCollapsed }) => (
          <BlockRow
            key={node.uuid}
            ref={(ref) => setRowRef(node.uuid, ref)}
            node={node}
            depth={depth}
            effectiveCollapsed={effectiveCollapsed}
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
            onTab={handleTab}
            onEscape={handleEscape}
            onCollapseToggle={handleCollapseToggle}
          />
        ))
      )}
      {!readOnly && <BlockFindReplacePlugin />}
    </div>
  );
}
