/**
 * runtimeContentOverlay — compatibility shim over the core store.
 *
 * Previously this module overlaid live runtime content onto stale TanStack Query
 * nodes. In the local-first core, nodes are already projected from the SQLite
 * derived tables, so the non-hook helpers are now pass-throughs.
 *
 * `useRuntimeDisplayName` still subscribes to live content changes via the core
 * store so observer surfaces (breadcrumbs, cells, cards) stay fresh.
 */

import { useState, useEffect, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { useWorkspaceStore } from '@/core/hooks';
import { projectNode } from '@/core/adapters/nodeProjection';
import type { OperationRuntime } from '@/runtime';
import type { Node } from '@/types/api';

/**
 * Read a node's live content name from the core store, falling back to
 * `fallbackName` when the node is not available locally.
 *
 * The `runtime` parameter is kept for signature compatibility but is no longer
 * used; the core store is the source of truth.
 */
export function readRuntimeName(
  _runtime: OperationRuntime | null | undefined,
  nodeUuid: string | null | undefined,
  fallbackName: string,
): string {
  if (!nodeUuid) return fallbackName;
  // Core-projected nodes are already live; without workspace context we cannot
  // do better than the fallback name here. React callers should use
  // useRuntimeDisplayName for live subscriptions.
  return fallbackName;
}

/**
 * Return `node` unchanged. Core-projected nodes already carry live content.
 */
export function overlayRuntimeContent(_runtime: OperationRuntime, node: Node): Node {
  return node;
}

/**
 * Read the live display name for a node. Core-projected nodes are already live,
 * so this returns `node.name` directly.
 */
export function getRuntimeDisplayName(
  node: Node,
  _runtime: OperationRuntime = null as unknown as OperationRuntime,
): string {
  return node.name;
}

/**
 * Subscribe to a node's live content and return its current display name.
 * Re-renders the consumer when that specific block's content changes.
 */
export function useRuntimeDisplayName(
  nodeUuid: string | null | undefined,
  fallbackName: string,
  _runtime: OperationRuntime = null as unknown as OperationRuntime,
): string {
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const { store } = useWorkspaceStore(workspaceId ?? '');

  const read = useMemo(() => {
    if (!store || !nodeUuid) return fallbackName;
    return projectNode(store, nodeUuid, 0)?.name ?? fallbackName;
  }, [store, nodeUuid, fallbackName]);

  const [name, setName] = useState<string>(read);

  useEffect(() => {
    setName(read);
    if (!store || !nodeUuid) return;
    const update = (): void => {
      setName(projectNode(store, nodeUuid, 0)?.name ?? fallbackName);
    };
    return store.subscribe(nodeUuid, update);
  }, [store, nodeUuid, fallbackName, read]);

  return name;
}
