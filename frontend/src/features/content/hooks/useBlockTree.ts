/**
 * useBlockTree — Project a node tree from the local-first core store.
 *
 * This hook is the single source of truth for block tree projection.
 * It:
 * 1. Resolves the core WorkspaceStore for the current workspace.
 * 2. Subscribes to structural/content changes on all node IDs in the prop tree.
 * 3. Computes a flat list by walking the store's node + child_order tables.
 *
 * When the core store is not available, it falls back to the static prop tree
 * so read-only / test / legacy callers keep working.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { useWorkspaceStore } from '@/core/hooks';
import { projectNode } from '@/core/adapters/nodeProjection';
import { useUIStateStore } from '@/features/sync';
import type { Node } from '@/types/api';
import type { NodeUIState } from '@/features/sync/stores/uiStateStore';
import type { WorkspaceStore } from '@/core/store';

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

export function isValidServerNodeId(uuid: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid);
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

/** Flatten a node tree statically (no core store). */
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

function collectNodeIds(nodes: Node[]): string[] {
  const ids: string[] = [];
  const walk = (n: Node) => {
    ids.push(n.uuid);
    n.children?.forEach(walk);
  };
  nodes.forEach(walk);
  return ids;
}

/** @internal Exported for unit testing. */
export function buildFlatNodesFromStore(
  store: WorkspaceStore,
  nodes: Node[],
  options: UseBlockTreeOptions,
  collapsedLookup: (nodeUuid: string) => boolean | undefined,
): FlatNode[] {
  const {
    maxDepth = -1,
    pagesOnly = false,
    skipPages = false,
    expandAll = false,
    nodeUuid,
    readOnly = false,
    showNewBlock = true,
    rootIsBlock = false,
  } = options;

  const result: FlatNode[] = [];
  const visited = new Set<string>();
  const duplicateUuids: string[] = [];

  const flatten = (nodeUuids: string[], depth: number): void => {
    if (maxDepth >= 0 && depth > maxDepth) return;

    for (const nodeUuid of nodeUuids) {
      if (visited.has(nodeUuid)) {
        if (!duplicateUuids.includes(nodeUuid)) duplicateUuids.push(nodeUuid);
        continue;
      }
      visited.add(nodeUuid);

      const node = projectNode(store, nodeUuid, 0);
      if (!node) continue;
      if (node.is_deleted) continue;
      if (node.is_comment) continue;
      if (pagesOnly && !node.is_page) continue;
      if (skipPages && node.is_page) continue;

      const effectiveCollapsed = expandAll ? false : (collapsedLookup(nodeUuid) ?? false);
      result.push({ node, depth, effectiveCollapsed });

      if (!effectiveCollapsed && (maxDepth < 0 || depth < maxDepth)) {
        const children = store.getChildren(nodeUuid);
        flatten(children, depth + 1);

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
  };

  let rootUuids: string[];
  if (nodeUuid) {
    if (rootIsBlock && nodes.some((n) => n.uuid === nodeUuid)) {
      rootUuids = [nodeUuid];
    } else {
      rootUuids = store.getChildren(nodeUuid);
    }
  } else {
    const nodeMap = new Map(nodes.map((n) => [n.uuid, n]));
    rootUuids = nodes
      .filter((n) => !n.parent_uuid || !nodeMap.has(n.parent_uuid))
      .map((n) => n.uuid);
  }

  flatten(rootUuids, 0);

  if (!readOnly && showNewBlock && nodeUuid && isValidServerNodeId(nodeUuid)) {
    const rootGhostDepth = rootIsBlock ? 1 : 0;
    result.push(createGhostFlatNode(nodeUuid, rootGhostDepth));
  }

  if (duplicateUuids.length > 0 && process.env.NODE_ENV === 'development') {
    console.warn(
      '[useBlockTree] Skipped duplicate node UUID(s) in core projection:',
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
    rootIsBlock = false,
  } = options;
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { store, isLoading } = useWorkspaceStore(workspaceId ?? '');
  const workspaceStates = useUIStateStore(
    useMemo(() => (s) => (workspaceId ? s.states[workspaceId] ?? EMPTY_STATES : EMPTY_STATES), [workspaceId])
  );
  const collapsedLookup = useCallback(
    (nodeUuid: string) => workspaceStates[nodeUuid]?.collapsed,
    [workspaceStates]
  );

  const [structureVersion, setStructureVersion] = useState(0);
  const nodeIds = useMemo(() => collectNodeIds(nodes), [nodes]);

  useEffect(() => {
    if (!store) return;
    const update = (): void => setStructureVersion((v) => v + 1);
    const unsubscribes = nodeIds.map((id) => store.subscribe(id, update));
    return () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    };
  }, [store, nodeIds]);

  const flatNodes = useMemo(() => {
    if (!store || isLoading) {
      return flattenNodes(nodes, maxDepth, pagesOnly, skipPages, collapsedLookup, 0, expandAll);
    }
    return buildFlatNodesFromStore(store, nodes, options, collapsedLookup);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    store,
    isLoading,
    nodes,
    maxDepth,
    pagesOnly,
    skipPages,
    expandAll,
    readOnly,
    showNewBlock,
    nodeUuid,
    rootIsBlock,
    structureVersion,
    collapsedLookup,
  ]);

  return { flatNodes, structureVersion };
}
