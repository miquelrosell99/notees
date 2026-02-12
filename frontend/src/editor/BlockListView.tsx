/**
 * BlockListView — Universal projection-based block renderer for arbitrary node slices.
 *
 * Renders an arbitrary set of nodes as a flat block list using a single
 * Lexical editor instance. Nodes are grouped by parent, optionally with
 * parents shown as locked projection roots. Structural operations respect
 * page boundaries and projection root locking.
 *
 * Usage:
 *   <BlockListView
 *     nodes={nodes}
 *     recursiveLevel={-1}
 *     showParent={true}
 *   />
 */

import { useCallback, useMemo, useId, useEffect } from 'react';
import type { JSX } from 'react';
import type { Node } from '@/types';
import { NoteesEditor } from './NoteesEditor';
import { getNodeGraphRuntime } from '../runtime/NodeGraphRuntime';
import { getDragCoordinator } from '../runtime/DragCoordinator';
import { apiNodeToGraphNode } from '../hooks/useRuntimeSync';
import { queueContentSave } from '../hooks/useBlockPersist';
import { createSliceGuards } from './sliceGuards';
import type { GraphNode } from '../runtime/types';

// ─── Props ────────────────────────────────────────────────────────

export interface BlockListViewProps {
  /** Arbitrary slice of nodes to render */
  nodes: Node[];
  /** How many levels of children to expand (-1 = unlimited, 0 = none, >0 = depth). Default: -1 */
  recursiveLevel?: number;
  /** Whether to render parent nodes as locked projection roots. Default: false */
  showParent?: boolean;
  /** Whether content is editable. Default: true */
  editable?: boolean;
  /** Navigation callback when a node link is clicked */
  onNodeClick?: (node: Node) => void;
  /** Content change callback (called with server ID and serialized content) */
  onContentChange?: (nodeId: number, content: string) => void;
  /** Additional CSS class */
  className?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Flatten a Node tree recursively into a flat array.
 * Returns all nodes and their descendants.
 */
function flattenNodes(nodes: Node[]): Node[] {
  const result: Node[] = [];
  const collect = (n: Node) => {
    result.push(n);
    if (n.children) {
      for (const child of n.children) collect(child);
    }
  };
  for (const n of nodes) collect(n);
  return result;
}

/**
 * Convert API nodes to GraphNodes, resolving parent UUIDs from both
 * the input array and the runtime (for parents not in the array).
 */
function prepareGraphNodes(allNodes: Node[]): {
  graphNodes: GraphNode[];
  idToUuidMap: Map<number, string>;
} {
  const runtime = getNodeGraphRuntime();

  // Build ID → UUID map from all input nodes
  const idToUuidMap = new Map<number, string>();
  for (const n of allNodes) {
    idToUuidMap.set(n.id, n.uuid);
  }

  // Resolve missing parents from the runtime
  for (const n of allNodes) {
    if (n.parent_id && !idToUuidMap.has(n.parent_id)) {
      const parentInRuntime = runtime.getNodeByServerId(n.parent_id);
      if (parentInRuntime) {
        idToUuidMap.set(n.parent_id, parentInRuntime.blockId);
      }
    }
  }

  const graphNodes = allNodes.map(n => apiNodeToGraphNode(n, idToUuidMap));
  return { graphNodes, idToUuidMap };
}

// ─── Component ────────────────────────────────────────────────────

export function BlockListView({
  nodes,
  recursiveLevel = -1,
  showParent = false,
  editable = true,
  onNodeClick,
  onContentChange,
  className = '',
}: BlockListViewProps): JSX.Element {
  const viewId = useId();

  // ─── Load nodes into runtime & compute slice IDs ───────────

  const { sliceBlockIds, projectionRootIds } = useMemo(() => {
    if (!nodes || nodes.length === 0) {
      return { sliceBlockIds: [] as string[], projectionRootIds: new Set<string>() };
    }

    const runtime = getNodeGraphRuntime();

    // Flatten all nodes (including children from nested arrays)
    const allNodes = flattenNodes(nodes);

    // Convert to GraphNodes with parent UUID resolution
    const { graphNodes, idToUuidMap } = prepareGraphNodes(allNodes);

    // Register parent serverIds for persistence (parents NOT in the input)
    const inputIdSet = new Set(allNodes.map(n => n.id));
    for (const n of allNodes) {
      if (n.parent_id && !inputIdSet.has(n.parent_id)) {
        const parentUuid = idToUuidMap.get(n.parent_id);
        if (parentUuid) {
          runtime.registerParentServerId(parentUuid, n.parent_id);
        }
      }
    }

    // Upsert into runtime
    runtime.upsertNodes(graphNodes);

    // Slice IDs = the top-level input nodes (not recursively expanded children)
    const sliceIds = nodes.map(n => n.uuid);

    // Compute projection root IDs (parents that will be shown as locked roots)
    const rootIds = new Set<string>();
    if (showParent) {
      for (const n of nodes) {
        if (n.parent_id) {
          const parentUuid = idToUuidMap.get(n.parent_id);
          if (parentUuid) {
            // Verify the parent exists in the runtime
            const parentNode = runtime.getNode(parentUuid);
            if (parentNode) rootIds.add(parentUuid);
          }
        }
      }
    }

    return { sliceBlockIds: sliceIds, projectionRootIds: rootIds };
  }, [nodes, showParent]);

  // ─── Structural guards ─────────────────────────────────────

  const guards = useMemo(
    () => createSliceGuards(projectionRootIds),
    [projectionRootIds],
  );

  // ─── Drag guard ────────────────────────────────────────────
  // Register the move guard on the DragCoordinator while this view is mounted

  useEffect(() => {
    const coordinator = getDragCoordinator();
    coordinator.setMoveGuard(guards.canMove);
    return () => {
      coordinator.setMoveGuard(null);
    };
  }, [guards.canMove]);

  // ─── Callback bridges ─────────────────────────────────────

  const handleNavigateToNode = useCallback((blockId: string) => {
    if (!onNodeClick) return;
    const runtime = getNodeGraphRuntime();
    const graphNode = runtime.getNode(blockId);
    if (!graphNode?.serverId) return;

    onNodeClick({ id: graphNode.serverId, is_page: graphNode.isPage } as Node);
  }, [onNodeClick]);

  const handleContentChange = useCallback((blockId: string, content: string) => {
    const runtime = getNodeGraphRuntime();
    const graphNode = runtime.getNode(blockId);
    const serverId = graphNode?.serverId;
    if (serverId != null) {
      onContentChange?.(serverId, content);
    } else if (graphNode) {
      // Block not yet persisted — queue for when serverId arrives
      queueContentSave(blockId, content);
    }
  }, [onContentChange]);

  // ─── Empty state ───────────────────────────────────────────

  if (!nodes || nodes.length === 0) {
    return (
      <div className={`block-list-view block-list-view--empty ${className}`}>
        <span className="block-list-view__empty-message">No items</span>
      </div>
    );
  }

  // ─── Render ────────────────────────────────────────────────

  return (
    <div className={`block-list-view ${editable ? 'block-list-view--editable' : 'block-list-view--readonly'} ${className}`}>
      <NoteesEditor
        editorId={`block-list-${viewId}`}
        mode="list"
        readOnly={!editable}
        onNavigateToNode={handleNavigateToNode}
        onContentChange={handleContentChange}
        sliceBlockIds={sliceBlockIds}
        sliceRecursiveLevel={recursiveLevel}
        sliceShowParent={showParent}
        canIndent={guards.canIndent}
        canOutdent={guards.canOutdent}
        canMerge={guards.canMerge}
        canDelete={guards.canDelete}
        className="block-list-view__editor"
      />
    </div>
  );
}
