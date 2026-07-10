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

import { useState, useEffect, useMemo, useLayoutEffect, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { getOperationRuntime } from '@/runtime';
import type { OperationRuntime } from '@/runtime';
import { getNode, getAllNodes, isValidServerNodeId } from '@/runtime/graphHelpers';
import { upsertNodes } from '@/runtime/eventBus';

import { getRuntimeEventBus } from '@/runtime/eventBus';
import { apiNodesToGraphNodes } from './useRuntimeSync';
import { overlayRuntimeContent } from './runtimeContentOverlay';
import { useUIStateStore } from '@/features/sync';
import { useEditorFocusStore } from '@/stores/editorFocusStore';
import type { Node } from '@/types/api';
import type { NodeUIState } from '@/features/sync/stores/uiStateStore';

const EMPTY_STATES: Record<string, NodeUIState> = {};

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
export function flattenNodes(
  nodes: Node[],
  maxDepth: number,
  pagesOnly: boolean,
  skipPages: boolean,
  collapsedLookup: (nodeUuid: string) => boolean | undefined,
  currentDepth = 0,
  expandAll = false,
  visited = new Set<string>(),
): FlatNode[] {
  const result: FlatNode[] = [];
  for (const node of nodes) {
    if (node.is_comment) continue;
    if (pagesOnly && !node.is_page) continue;
    if (skipPages && node.is_page) continue;
    if (visited.has(node.uuid)) continue;
    visited.add(node.uuid);

    const effectiveCollapsed = expandAll ? false : (collapsedLookup(node.uuid) ?? false);
    result.push({ node, depth: currentDepth, effectiveCollapsed });
    if (
      node.children &&
      node.children.length > 0 &&
      !effectiveCollapsed &&
      (maxDepth < 0 || currentDepth < maxDepth)
    ) {
      result.push(...flattenNodes(node.children, maxDepth, pagesOnly, skipPages, collapsedLookup, currentDepth + 1, expandAll, visited));
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
      uuid: buildGhostId(parentUuid),
      name: '',
      icon: null,
      color: null,
      parent_uuid: null,
      page_uuid: null,
      sequence: Number.MAX_SAFE_INTEGER,
      active: true,
      is_page: false,
      is_deleted: false,
      has_children: false,
      children: [],
      create_date: '',
      write_date: '',
      classes_uuid: [],
      tags_uuid: [],
      properties_uuid: {},
    },
    depth,
    effectiveCollapsed: false,
    isGhost: true,
  };
}

export function flattenNodesFromRuntime(
  nodes: Node[],
  maxDepth: number,
  pagesOnly: boolean,
  skipPages: boolean,
  runtime: OperationRuntime,
  collapsedLookup: (nodeUuid: string) => boolean | undefined,
  expandAll = false,
  readOnly = false,
  showNewBlock = true,
  rootUuid?: string,
  rootIsBlock = false,
): FlatNode[] {
  const nodeMap = new Map<string, Node>();
  const collect = (n: Node) => {
    nodeMap.set(n.uuid, n);
    if (n.children) for (const c of n.children) collect(c);
  };
  for (const n of nodes) collect(n);

  function resolveParentId(node: Node): string {
    const graphNode = getNode(runtime, node.uuid);
    const propParentUuid = node.parent_uuid || '__root__';
    const runtimeParentUuid = graphNode?.parentId;
    return (runtimeParentUuid && nodeMap.has(runtimeParentUuid))
      ? runtimeParentUuid
      : propParentUuid;
  }

  const byParent = new Map<string, Node[]>();
  for (const [, node] of nodeMap) {
    const parentId = resolveParentId(node);
    if (!byParent.has(parentId)) byParent.set(parentId, []);
    byParent.get(parentId)!.push(node);
  }

  // Include runtime-only nodes whose parent is in the prop tree, or whose
  // parent is the root page/rootBlockId (which is never part of the prop tree).
  // This makes newly-created top-level blocks visible immediately instead of
  // disappearing until the next server fetch.
  for (const gn of getAllNodes(runtime)) {
    if (nodeMap.has(gn.blockId)) continue;
    if (gn.isDeleted) continue;
    if (!gn.parentId || (!nodeMap.has(gn.parentId) && gn.parentId !== rootUuid)) continue;
    const syntheticNode: Node = {
      uuid: gn.blockId,
      name: JSON.stringify(gn.contentAST),
      icon: gn.icon ?? null,
      color: gn.color ?? null,
      // Keep the real parent UUID so resolveParentId can place runtime-only
      // top-level nodes under the root correctly.
      parent_uuid: gn.parentId,
      page_uuid: null,
      sequence: gn.orderIndex,
      active: true,
      is_page: false,
      is_deleted: false,
      has_children: false,
      children: [],
      create_date: gn.createdAt,
      write_date: gn.updatedAt,
      classes_uuid: gn.classIds,
      tags_uuid: gn.tagIds,
      properties_uuid: {},
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

  const visited = new Set<string>();
  const duplicateUuids: string[] = [];

  const flatten = (nodeUuids: string[], depth: number): FlatNode[] => {
    if (maxDepth >= 0 && depth > maxDepth) return [];
    const result: FlatNode[] = [];
    for (const nodeUuid of nodeUuids) {
      const node = nodeMap.get(nodeUuid);
      if (!node) continue;
      const projected = getNode(runtime, node.uuid);
      if (projected?.isDeleted) continue;
      if (node.is_comment) continue;
      if (pagesOnly && !node.is_page) continue;
      if (skipPages && node.is_page) continue;
      if (visited.has(node.uuid)) {
        if (!duplicateUuids.includes(node.uuid)) duplicateUuids.push(node.uuid);
        continue;
      }
      visited.add(node.uuid);
      const effectiveCollapsed = expandAll ? false : (collapsedLookup(nodeUuid) ?? false);
      // Overlay the runtime's live content onto the prop node. The prop node
      // carries the stale TanStack Query cache (e.g. empty after a fresh edit),
      // while the runtime projection already holds the just-typed contentAST.
      // Without this overlay, the read-only static view rendered empty/stale
      // content after exiting edit mode until the next refetch (full reload).
      // Mirrors how runtime-only nodes derive their `name` from contentAST above.
      const displayNode = overlayRuntimeContent(runtime, node);
      result.push({ node: displayNode, depth, effectiveCollapsed });

      if (!effectiveCollapsed && (maxDepth < 0 || depth < maxDepth)) {
        const children = byParent.get(nodeUuid) || [];
        result.push(...flatten(children.map(c => c.uuid), depth + 1));
        // Trailing pseudo-block for creating children of this parent.
        // Skip nested ghosts when page filtering is active to avoid orphan rows.
        // In focused block view the root node is the focused block itself; its
        // child ghost is suppressed because the root ghost (at depth 1) already
        // serves as the "new child of the focused block" placeholder.
        const isRootLevel = depth === 0;
        if (
          !readOnly &&
          showNewBlock &&
          !pagesOnly &&
          !skipPages &&
          !(rootIsBlock && isRootLevel) &&
          isValidServerNodeId(nodeUuid)
        ) {
          result.push(createGhostFlatNode(nodeUuid, depth + 1));
        }
      }
    }
    return result;
  };

  const topLevel: string[] = [];
  for (const [nodeUuid, node] of nodeMap) {
    const parentId = resolveParentId(node);
    // Treat the root page/rootBlockId as a top-level parent even though it is
    // never included in the prop-node map.
    if (!nodeMap.has(parentId) || parentId === rootUuid) {
      topLevel.push(nodeUuid);
    }
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
  if (!readOnly && showNewBlock && rootUuid && isValidServerNodeId(rootUuid)) {
    // In focused block view the root is the focused block; new blocks created
    // from the root ghost are children of that block, so indent one level deeper.
    const rootGhostDepth = rootIsBlock ? 1 : 0;
    result.push(createGhostFlatNode(rootUuid, rootGhostDepth));
  }

  if (duplicateUuids.length > 0 && process.env.NODE_ENV === 'development') {
    console.warn(
      '[flattenNodesFromRuntime] Skipped duplicate node UUID(s) in runtime projection:',
      duplicateUuids,
    );
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
          nodeUuid,
          readOnly = false,
          showNewBlock = true,
          rootIsBlock = false } = options;
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const workspaceStates = useUIStateStore(
    useMemo(() => (s) => (workspaceId ? s.states[workspaceId] ?? EMPTY_STATES : EMPTY_STATES), [workspaceId])
  );
  const collapsedLookup = useCallback(
    (nodeUuid: string) => workspaceStates[nodeUuid]?.collapsed,
    [workspaceStates]
  );
  const activeBlockId = useEditorFocusStore((s) => s.activeBlockId);

  // Sync prop nodes into the runtime so structural ops have graph data.
  useLayoutEffect(() => {
    const allNodes: Node[] = [];
    const collect = (n: Node) => {
      allNodes.push(n);
      if (n.children) for (const child of n.children) collect(child);
    };
    for (const n of nodes) collect(n);

    if (allNodes.length > 0) {
      const { graphNodes } = apiNodesToGraphNodes(allNodes, nodeUuid);
      upsertNodes(graphNodes);
    }
  }, [nodes, nodeUuid]);

  // Subscribe to runtime structural changes only. Content edits (name,
  // contentAST, icon, etc.) emit `nodes_changed`; we intentionally do NOT
  // rebuild the flat tree for those because the tree shape is unchanged and
  // rebuilding invalidates BlockRow memoization, causing every visible row to
  // re-render on every keystroke.
  //
  // We DO rebuild when the active block changes (focus/blur). Runtime-only
  // nodes (e.g. newly created blocks) derive their displayed `name` from the
  // runtime's current `contentAST`; without a rebuild on blur, the static
  // view would render the stale empty content after the editor unmounts.
  const [structureVersion, setStructureVersion] = useState(0);
  useEffect(() => {
    const unsubscribe = getRuntimeEventBus().subscribe((event) => {
      if (event.type === 'structure_changed') {
        setStructureVersion((v) => v + 1);
      }
    });
    return unsubscribe;
  }, []);

  const flatNodes = useMemo(() => {
    const runtime = getOperationRuntime();
    const hasRuntimeData = nodeUuid != null || nodes.some((n) => getNode(runtime, n.uuid) != null);
    if (!hasRuntimeData) {
      return flattenNodes(nodes, maxDepth, pagesOnly, skipPages, collapsedLookup, 0, expandAll);
    }
    return flattenNodesFromRuntime(
      nodes,
      maxDepth,
      pagesOnly,
      skipPages,
      runtime,
      collapsedLookup,
      expandAll,
      readOnly,
      showNewBlock,
      nodeUuid,
      rootIsBlock,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, maxDepth, pagesOnly, skipPages, expandAll, readOnly, showNewBlock, nodeUuid, rootIsBlock, structureVersion, collapsedLookup, activeBlockId]);

  return { flatNodes, structureVersion };
}
