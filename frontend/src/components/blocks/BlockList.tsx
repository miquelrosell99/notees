/* eslint-disable jsx-a11y/no-noninteractive-element-interactions */
/**
 * BlockList — Static list container for the block-level editor (Phase 1).
 *
 * Renders BlockRow components for each visible block.
 * Handles list-level keyboard navigation (Enter, Backspace, Tab, Arrows).
 *
 * In Phase 3 this will be virtualized with @tanstack/react-virtual.
 */

import {
  useRef,
  useCallback,
  useMemo,
  useEffect,
  useState,
  type KeyboardEvent,
  type JSX,
} from 'react';
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
import { BlockFindReplacePlugin } from '@/editor/plugins/BlockFindReplacePlugin';
import './BlockList.css';

// ─── Types ────────────────────────────────────────────────────────

interface FlatNode {
  node: Node;
  depth: number;
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
  onPillClick?: (linkId: string, refType: 'node' | 'class' | 'url' | 'embed' | 'broken') => void;
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
  /** Called when a template is selected. */
  onTemplateInstantiate?: (templateNodeId: number, blockServerId: number | undefined) => void;
  /** Class IDs to pre-filter template picker. */
  templateClassFilters?: number[];
  /** UUID of the containing page (enables live sync lock indicators). */
  pageUuid?: string;
  /** Server ID of the containing node (for runtime parent resolution). */
  nodeId?: number;
}

// ─── Helpers ──────────────────────────────────────────────────────

/** Flatten a node tree into a list with depth, respecting collapsed state and filters. */
function flattenNodes(
  nodes: Node[],
  maxDepth: number,
  pagesOnly: boolean,
  skipPages: boolean,
  currentDepth = 0,
): FlatNode[] {
  const result: FlatNode[] = [];
  for (const node of nodes) {
    // Apply filters
    if (pagesOnly && !node.is_page) continue;
    if (skipPages && node.is_page) continue;

    result.push({ node, depth: currentDepth });
    if (
      node.children &&
      node.children.length > 0 &&
      !node.collapsed &&
      (maxDepth < 0 || currentDepth < maxDepth)
    ) {
      result.push(...flattenNodes(node.children, maxDepth, pagesOnly, skipPages, currentDepth + 1));
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
): FlatNode[] {
  // Build UUID → Node map from the prop
  const nodeMap = new Map<string, Node>();
  const collect = (n: Node) => {
    nodeMap.set(n.uuid, n);
    if (n.children) for (const c of n.children) collect(c);
  };
  for (const n of nodes) collect(n);

  // Group nodes by their runtime parent ID
  const byParent = new Map<string, Node[]>();
  for (const [uuid, node] of nodeMap) {
    const graphNode = runtime.getNode(uuid);
    const parentId = graphNode?.parentId || node.parent_id?.toString() || '__root__';
    if (!byParent.has(parentId)) byParent.set(parentId, []);
    byParent.get(parentId)!.push(node);
  }

  // Sort each parent's children by runtime orderIndex
  for (const [, children] of byParent) {
    children.sort((a, b) => {
      const ga = runtime.getNode(a.uuid);
      const gb = runtime.getNode(b.uuid);
      return (ga?.orderIndex ?? a.sequence ?? 0) - (gb?.orderIndex ?? b.sequence ?? 0);
    });
  }

  // Recursive flattener
  const flatten = (uuids: string[], depth: number): FlatNode[] => {
    if (maxDepth >= 0 && depth > maxDepth) return [];
    const result: FlatNode[] = [];
    for (const uuid of uuids) {
      const node = nodeMap.get(uuid);
      if (!node) continue;
      if (pagesOnly && !node.is_page) continue;
      if (skipPages && node.is_page) continue;
      result.push({ node, depth });

      const graphNode = runtime.getNode(uuid);
      const collapsed = graphNode?.collapsed ?? node.collapsed;
      if (!collapsed && (maxDepth < 0 || depth < maxDepth)) {
        const parentId = graphNode?.parentId || uuid;
        const children = byParent.get(parentId) || [];
        result.push(...flatten(children.map(c => c.uuid), depth + 1));
      }
    }
    return result;
  };

  // Determine top-level nodes (those whose parent is not in our map)
  const topLevel: string[] = [];
  for (const [uuid, node] of nodeMap) {
    const graphNode = runtime.getNode(uuid);
    const parentId = graphNode?.parentId || node.parent_id?.toString() || '__root__';
    if (!nodeMap.has(parentId)) topLevel.push(uuid);
  }

  // Sort top-level by runtime orderIndex
  topLevel.sort((a, b) => {
    const ga = runtime.getNode(a);
    const gb = runtime.getNode(b);
    const na = nodeMap.get(a);
    const nb = nodeMap.get(b);
    return (ga?.orderIndex ?? na?.sequence ?? 0) - (gb?.orderIndex ?? nb?.sequence ?? 0);
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
  onTemplateInstantiate,
  templateClassFilters,
  pageUuid,
  nodeId,
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
      return flattenNodes(nodes, maxDepth, pagesOnly, skipPages);
    }
    return flattenNodesFromRuntime(nodes, maxDepth, pagesOnly, skipPages, runtime);
  }, [nodes, maxDepth, pagesOnly, skipPages, structureVersion]);

  const blockIds = useMemo(() => flatNodes.map((n) => n.node.uuid), [flatNodes]);
  const rowRefs = useRef<Map<string, BlockRowHandle>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);

  // Sync nodes to runtime so structural ops (drag, indent, outdent) and
  // content saves have the graph data they need.
  useEffect(() => {
    const runtime = getNodeGraphRuntime();
    const allNodes: Node[] = [];
    const collect = (n: Node) => {
      allNodes.push(n);
      if (n.children) for (const child of n.children) collect(child);
    };
    for (const n of nodes) collect(n);

    if (allNodes.length > 0) {
      const { graphNodes } = apiNodesToGraphNodes(allNodes, nodeId, pageUuid);
      runtime.upsertNodes(graphNodes);
    }

    if (nodeId != null && pageUuid) {
      runtime.registerParentServerId(pageUuid, nodeId);
    }
  }, [nodes, nodeId, pageUuid]);

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

  const handleEnter = useCallback(
    (blockId: string) => {
      const runtime = getNodeGraphRuntime();
      const row = rowRefs.current.get(blockId);
      const cursor = row?.getCursorPosition() ?? 'empty';

      if (cursor === 'empty' || cursor === 'end') {
        const newBlockId = generateUUID();
        runtime.applyIntent({
          type: 'create_block',
          parentId: runtime.getNode(blockId)?.parentId ?? '',
          afterBlockId: blockId,
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
    [setPendingFocus],
  );

  const handleBackspaceAtStart = useCallback(
    (blockId: string) => {
      const idx = blockIds.indexOf(blockId);
      if (idx <= 0) return;
      const prevBlockId = blockIds[idx - 1];
      const runtime = getNodeGraphRuntime();
      runtime.applyIntent({
        type: 'merge_blocks',
        sourceBlockId: blockId,
        targetBlockId: prevBlockId,
      });
      runtime.flushEvents();
      setPendingFocus(prevBlockId);
    },
    [blockIds, setPendingFocus],
  );

  const handleDeleteAtEnd = useCallback(
    (blockId: string) => {
      const idx = blockIds.indexOf(blockId);
      if (idx < 0 || idx >= blockIds.length - 1) return;
      const nextBlockId = blockIds[idx + 1];
      const runtime = getNodeGraphRuntime();
      runtime.applyIntent({
        type: 'merge_blocks',
        sourceBlockId: nextBlockId,
        targetBlockId: blockId,
      });
      runtime.flushEvents();
      setPendingFocus(blockId);
    },
    [blockIds, setPendingFocus],
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

  // ─── Focus pending block on mount/update ────────────────────────

  useEffect(() => {
    const pending = useEditorFocusStore.getState().pendingFocusBlockId;
    if (pending && rowRefs.current.has(pending)) {
      rowRefs.current.get(pending)?.focus();
      useEditorFocusStore.getState().setPendingFocus(null);
    }
  });

  // ─── Render ─────────────────────────────────────────────────────

  return (
    <div
      ref={containerRef}
      className="block-list notees-editor"
      onKeyDown={handleKeyDown}
      role="application"
      aria-label="Block editor"
      tabIndex={-1}
    >
      {flatNodes.map(({ node, depth }) => (
        <BlockRow
          key={node.uuid}
          ref={(ref) => setRowRef(node.uuid, ref)}
          node={node}
          depth={depth}
          readOnly={readOnly}
          placeholder={placeholder}
          onContentChange={onContentChange}
          onPillClick={onPillClick}
          onPillRemove={onPillRemove}
          onNavigate={onNavigateToNode}
          onOpenInSidebar={onOpenInSidebar}
          onAddClass={onAddClass}
          onSlashCommand={onSlashCommand}
          onTemplateInstantiate={onTemplateInstantiate}
          templateClassFilters={templateClassFilters}
          pageUuid={pageUuid}
          onEnter={() => handleEnter(node.uuid)}
          onBackspaceAtStart={() => handleBackspaceAtStart(node.uuid)}
          onDeleteAtEnd={() => handleDeleteAtEnd(node.uuid)}
          onTab={(shift) => handleTab(node.uuid, shift)}
          onEscape={() => handleEscape(node.uuid)}
          onCollapseToggle={() => handleCollapseToggle(node.uuid)}
        />
      ))}
      {!readOnly && <BlockFindReplacePlugin />}
    </div>
  );
}
