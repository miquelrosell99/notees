/**
 * useBlockTree — Project a node tree through the runtime's ephemeral overlay.
 *
 * This hook is the single source of truth for block tree projection.
 * It:
 * 1. Syncs prop nodes into the runtime (base state)
 * 2. Subscribes to runtime structural events
 * 3. Computes a flat list by merging prop data with runtime parent/child/order state
 *
 * Previously this logic was duplicated inside BlockList, making it hard to
 * reason about what BlockList actually rendered. Extracting it into a
 * dedicated hook makes the data flow explicit: props → runtime sync →
 * projection → flat list for the renderer.
 */

import { useState, useEffect, useMemo, useLayoutEffect } from 'react';
import { getOperationRuntime } from '@/runtime';
import type { OperationRuntime } from '@/runtime';
import { getNode, getAllNodes } from '@/runtime/graphHelpers';
import { upsertNodes } from '@/runtime/eventBus';
import { registerParentServerId } from '@/runtime/serverIdMap';
import { getUndoEngine } from '@/stores/undoEngine';
import { getRuntimeEventBus } from '@/runtime/eventBus';
import { apiNodesToGraphNodes } from './useRuntimeSync';
import type { Node } from '@/types/api';

export interface FlatNode {
  node: Node;
  depth: number;
  effectiveCollapsed: boolean;
  /** True for the trailing pseudo-block used to create new blocks in place. */
  isGhost?: boolean;
}

interface UseBlockTreeOptions {
  maxDepth?: number;
  pagesOnly?: boolean;
  skipPages?: boolean;
  expandAll?: boolean;
  nodeId?: number;
  nodeUuid?: string;
  /** If false (default), a ghost block is appended as the last sibling. */
  readOnly?: boolean;
  /** If false, no ghost pseudo-blocks are generated regardless of readOnly. */
  showNewBlock?: boolean;
  /** If true, the root container is a block (focused block view), so the trailing
   *  root ghost is indented one level deeper and the per-parent child ghost for the
   *  root node is suppressed to avoid a duplicate placeholder. */
  rootIsBlock?: boolean;
}

/** Flatten a node tree statically (no runtime overlay). */
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
 * The runtime projection is ephemeral. TanStack Query is the single persistent
 * source of truth. The runtime only overlays pending intents on top of the base
 * state received from the query cache.
 */
const GHOST_PREFIX = '__ghost-';

export function isGhostId(uuid: string): boolean {
  return uuid.startsWith(GHOST_PREFIX);
}

export function buildGhostId(parentUuid: string): string {
  return `${GHOST_PREFIX}${parentUuid}`;
}

export function parseGhostParentUuid(ghostUuid: string): string | null {
  if (!isGhostId(ghostUuid)) return null;
  return ghostUuid.slice(GHOST_PREFIX.length);
}

function createGhostFlatNode(parentUuid: string, depth: number): FlatNode {
  return {
    node: {
      id: -1,
      uuid: buildGhostId(parentUuid),
      name: '',
      icon: null,
      color: null,
      parent_id: null,
      parent_uuid: null,
      page_id: null,
      page_uuid: null,
      sequence: Number.MAX_SAFE_INTEGER,
      collapsed: false,
      active: true,
      is_page: false,
      is_deleted: false,
      has_children: false,
      children: [],
      create_date: '',
      write_date: '',
      classes: [],
      tags: [],
      properties: {},
    },
    depth,
    effectiveCollapsed: false,
    isGhost: true,
  };
}

function flattenNodesFromRuntime(
  nodes: Node[],
  maxDepth: number,
  pagesOnly: boolean,
  skipPages: boolean,
  runtime: OperationRuntime,
  expandAll = false,
  readOnly = false,
  showNewBlock = true,
  rootUuid?: string,
  rootIsBlock = false,
): FlatNode[] {
  const nodeMap = new Map<string, Node>();
  const idToUuid = new Map<number, string>();
  const collect = (n: Node) => {
    nodeMap.set(n.uuid, n);
    idToUuid.set(n.id, n.uuid);
    if (n.children) for (const c of n.children) collect(c);
  };
  for (const n of nodes) collect(n);

  function resolveParentId(node: Node): string {
    const graphNode = getNode(runtime, node.uuid);
    const propParentId = node.parent_id?.toString() || '__root__';
    const runtimeParentId = graphNode?.parentId;
    let parentId = (runtimeParentId && nodeMap.has(runtimeParentId))
      ? runtimeParentId
      : propParentId;
    // Fall back from numeric parent_id to UUID when the runtime hasn't synced yet.
    if (!nodeMap.has(parentId) && node.parent_id != null) {
      const parentUuid = idToUuid.get(node.parent_id);
      if (parentUuid) parentId = parentUuid;
    }
    return parentId;
  }

  const byParent = new Map<string, Node[]>();
  for (const [, node] of nodeMap) {
    const parentId = resolveParentId(node);
    if (!byParent.has(parentId)) byParent.set(parentId, []);
    byParent.get(parentId)!.push(node);
  }

  // Include runtime-only nodes whose parent is in the prop tree
  for (const gn of getAllNodes(runtime)) {
    if (nodeMap.has(gn.blockId)) continue;
    if (!gn.parentId || !nodeMap.has(gn.parentId)) continue;
    const syntheticNode: Node = {
      id: gn.serverId ?? -1,
      uuid: gn.blockId,
      name: JSON.stringify(gn.contentAST),
      icon: gn.icon ?? null,
      color: gn.color ?? null,
      parent_id: null,
      parent_uuid: null,
      page_id: null,
      page_uuid: null,
      sequence: gn.orderIndex,
      collapsed: gn.collapsed,
      active: true,
      is_page: false,
      is_deleted: false,
      has_children: false,
      children: [],
      create_date: gn.createdAt,
      write_date: gn.updatedAt,
      classes: gn.classIds.map(id => parseInt(id, 10)).filter(n => !isNaN(n)),
      tags: gn.tagIds.map(id => parseInt(id, 10)).filter(n => !isNaN(n)),
      properties: {},
    };
    nodeMap.set(gn.blockId, syntheticNode);
    if (!byParent.has(gn.parentId)) byParent.set(gn.parentId, []);
    byParent.get(gn.parentId)!.push(syntheticNode);
  }

  for (const [, children] of byParent) {
    children.sort((a, b) => {
      const ga = getNode(runtime, a.uuid);
      const gb = getNode(runtime, b.uuid);
      const orderA = ga?.orderIndex ?? a.sequence ?? 0;
      const orderB = gb?.orderIndex ?? b.sequence ?? 0;
      if (orderA !== orderB) return orderA - orderB;
      const seqA = a.sequence ?? 0;
      const seqB = b.sequence ?? 0;
      return seqA - seqB;
    });
  }

  const flatten = (nodeUuids: string[], depth: number): FlatNode[] => {
    if (maxDepth >= 0 && depth > maxDepth) return [];
    const result: FlatNode[] = [];
    for (const nodeUuid of nodeUuids) {
      const node = nodeMap.get(nodeUuid);
      if (!node) continue;
      if (node.is_comment) continue;
      if (pagesOnly && !node.is_page) continue;
      if (skipPages && node.is_page) continue;
      const graphNode = getNode(runtime, nodeUuid);
      const effectiveCollapsed = expandAll ? false : (graphNode?.collapsed ?? node.collapsed);
      result.push({ node, depth, effectiveCollapsed });

      if (!effectiveCollapsed && (maxDepth < 0 || depth < maxDepth)) {
        const children = byParent.get(nodeUuid) || [];
        result.push(...flatten(children.map(c => c.uuid), depth + 1));
        // Trailing pseudo-block for creating children of this parent.
        // Skip nested ghosts when page filtering is active to avoid orphan rows.
        // In focused block view the root node is the focused block itself; its
        // child ghost is suppressed because the root ghost (at depth 1) already
        // serves as the "new child of the focused block" placeholder.
        const isRootLevel = depth === 0;
        if (!readOnly && showNewBlock && !pagesOnly && !skipPages && !(rootIsBlock && isRootLevel)) {
          result.push(createGhostFlatNode(nodeUuid, depth + 1));
        }
      }
    }
    return result;
  };

  const topLevel: string[] = [];
  for (const [nodeUuid, node] of nodeMap) {
    const parentId = resolveParentId(node);
    if (!nodeMap.has(parentId)) topLevel.push(nodeUuid);
  }

  topLevel.sort((a, b) => {
    const ga = getNode(runtime, a);
    const gb = getNode(runtime, b);
    const na = nodeMap.get(a);
    const nb = nodeMap.get(b);
    const orderA = ga?.orderIndex ?? na?.sequence ?? 0;
    const orderB = gb?.orderIndex ?? nb?.sequence ?? 0;
    if (orderA !== orderB) return orderA - orderB;
    const seqA = na?.sequence ?? 0;
    const seqB = nb?.sequence ?? 0;
    return seqA - seqB;
  });

  const result = flatten(topLevel, 0);
  // Trailing pseudo-block for the root list.
  if (!readOnly && showNewBlock && rootUuid) {
    // In focused block view the root is the focused block; new blocks created
    // from the root ghost are children of that block, so indent one level deeper.
    const rootGhostDepth = rootIsBlock ? 1 : 0;
    result.push(createGhostFlatNode(rootUuid, rootGhostDepth));
  }
  return result;
}

export function useBlockTree(
  nodes: Node[],
  options: UseBlockTreeOptions = {}
): { flatNodes: FlatNode[]; structureVersion: number } {
  const {
    maxDepth = -1,
    pagesOnly = false,
    skipPages = false,
    expandAll = false,
    nodeId,
    nodeUuid,
    readOnly = false,
    showNewBlock = true,
    rootIsBlock = false,
  } = options;

  // Sync prop nodes into the runtime so structural ops have graph data.
  useLayoutEffect(() => {
    const allNodes: Node[] = [];
    const collect = (n: Node) => {
      allNodes.push(n);
      if (n.children) for (const child of n.children) collect(child);
    };
    for (const n of nodes) collect(n);

    if (allNodes.length > 0) {
      const { graphNodes } = apiNodesToGraphNodes(allNodes, nodeId, nodeUuid);
      upsertNodes(graphNodes);
      if (expandAll) {
        for (const gn of graphNodes) {
          getUndoEngine().applyIntent({ type: 'set_collapsed', blockId: gn.blockId, collapsed: false });
        }
        getRuntimeEventBus().flushEvents();
      }
    }

    if (nodeId != null && nodeUuid) {
      registerParentServerId(nodeUuid, nodeId);
    }
  }, [nodes, nodeId, nodeUuid, expandAll]);

  // Subscribe to runtime structural changes
  const [structureVersion, setStructureVersion] = useState(0);
  useEffect(() => {
    const unsubscribe = getRuntimeEventBus().subscribe((event) => {
      if (event.type === 'structure_changed' || event.type === 'nodes_changed') {
        setStructureVersion((v) => v + 1);
      }
    });
    return unsubscribe;
  }, []);

  const flatNodes = useMemo(() => {
    const runtime = getOperationRuntime();
    const hasRuntimeData = nodeUuid != null || nodes.some((n) => getNode(runtime, n.uuid) != null);
    if (!hasRuntimeData) {
      return flattenNodes(nodes, maxDepth, pagesOnly, skipPages, 0, expandAll);
    }
    return flattenNodesFromRuntime(nodes, maxDepth, pagesOnly, skipPages, runtime, expandAll, readOnly, showNewBlock, nodeUuid, rootIsBlock);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, maxDepth, pagesOnly, skipPages, expandAll, readOnly, showNewBlock, nodeUuid, rootIsBlock, structureVersion]);

  return { flatNodes, structureVersion };
}
