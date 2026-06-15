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
import { getNodeGraphRuntime } from '@/runtime/NodeGraphRuntime';
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
      page_id: null,
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
  runtime: ReturnType<typeof getNodeGraphRuntime>,
  expandAll = false,
  readOnly = false,
  rootUuid?: string,
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
    const graphNode = runtime.getNode(node.uuid);
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
  for (const gn of runtime.getAllNodes()) {
    if (nodeMap.has(gn.blockId)) continue;
    if (!gn.parentId || !nodeMap.has(gn.parentId)) continue;
    const syntheticNode: Node = {
      id: gn.serverId ?? -1,
      uuid: gn.blockId,
      name: JSON.stringify(gn.contentAST),
      icon: gn.icon ?? null,
      color: gn.color ?? null,
      parent_id: null,
      page_id: null,
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
      const ga = runtime.getNode(a.uuid);
      const gb = runtime.getNode(b.uuid);
      const orderA = ga?.orderIndex ?? a.sequence ?? 0;
      const orderB = gb?.orderIndex ?? b.sequence ?? 0;
      if (orderA !== orderB) return orderA - orderB;
      const seqA = a.sequence ?? 0;
      const seqB = b.sequence ?? 0;
      return seqA - seqB;
    });
  }

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
        const children = byParent.get(uuid) || [];
        result.push(...flatten(children.map(c => c.uuid), depth + 1));
        // Trailing pseudo-block for creating children of this parent.
        // Skip nested ghosts when page filtering is active to avoid orphan rows.
        if (!readOnly && !pagesOnly && !skipPages) {
          result.push(createGhostFlatNode(uuid, depth + 1));
        }
      }
    }
    return result;
  };

  const topLevel: string[] = [];
  for (const [uuid, node] of nodeMap) {
    const parentId = resolveParentId(node);
    if (!nodeMap.has(parentId)) topLevel.push(uuid);
  }

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

  const result = flatten(topLevel, 0);
  // Trailing pseudo-block for the root list.
  if (!readOnly && rootUuid) {
    result.push(createGhostFlatNode(rootUuid, 0));
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
  } = options;

  // Sync prop nodes into the runtime so structural ops have graph data.
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
      runtime.upsertNodes(graphNodes, { preserveCollapsed: nodeUuid != null });
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
  }, [nodes, nodeId, nodeUuid, expandAll]);

  // Subscribe to runtime structural changes
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
    const hasRuntimeData = nodeUuid != null || nodes.some((n) => runtime.getNode(n.uuid) != null);
    if (!hasRuntimeData) {
      return flattenNodes(nodes, maxDepth, pagesOnly, skipPages, 0, expandAll);
    }
    return flattenNodesFromRuntime(nodes, maxDepth, pagesOnly, skipPages, runtime, expandAll, readOnly, nodeUuid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, maxDepth, pagesOnly, skipPages, expandAll, readOnly, nodeUuid, structureVersion]);

  return { flatNodes, structureVersion };
}
