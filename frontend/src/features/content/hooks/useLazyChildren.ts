/**
 * useLazyChildren — Lazy-loads children of collapsed blocks on expand.
 *
 * Listens for the 'expand_children_needed' runtime event (emitted when a
 * collapsed block is expanded but its children were pruned from the initial
 * API response). Fetches the node with children from the API and injects
 * the children into the runtime so the projection picks them up immediately.
 */

import { useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { getOperationRuntime } from '@/runtime';
import { getNode } from '@/runtime/graphHelpers';
import { upsertNodes } from '@/runtime/eventBus';
import { useUIStateStore } from '@/features/sync';
import { getRuntimeEventBus } from '@/runtime/eventBus';
import { apiNodesToGraphNodes } from './useRuntimeSync';
import * as nodesApi from '@/api/nodes';
import type { RuntimeEvent } from '@/runtime/types';

/**
 * Hook to lazily load children when a collapsed block is expanded.
 * Should be mounted once per page view (alongside BlockEditor).
 */
export function useLazyChildren(): void {
  // Track in-flight requests to avoid duplicate fetches
  const pendingRef = useRef(new Set<string>());
  const { workspaceId } = useParams<{ workspaceId?: string }>();
  const setCollapsed = useUIStateStore((s) => s.setCollapsed);

  useEffect(() => {
    const runtime = getOperationRuntime();

    const handler = async (event: RuntimeEvent) => {
      if (event.type !== 'expand_children_needed') return;
      const { blockId } = event;

      // Skip if already fetching
      if (pendingRef.current.has(blockId)) return;
      pendingRef.current.add(blockId);

      try {
        // Fetch the expanded node with its children from the API. Properties
        // are included so the runtime upsert does not wipe taskStatus (and
        // other property-derived fields) on lazily-loaded children.
        const nodeData = await nodesApi.getNode(blockId, {
          include_children: true,
          include_properties: true,
        });

        if (!nodeData?.children?.length) {
          // Server says no children after all — clear the flag
          const gn = getNode(runtime, blockId);
          if (gn) gn.hasServerChildren = false;
          return;
        }

        // Convert API children to graph nodes
        const { graphNodes } = apiNodesToGraphNodes(
          nodeData.children,
          nodeData.uuid,
        );

        // Inject into runtime — this triggers projection update
        upsertNodes(graphNodes);

        // Clear hasServerChildren since we've loaded them
        const gn = getNode(runtime, blockId);
        if (gn) gn.hasServerChildren = false;
      } catch (err) {
        console.error(`[useLazyChildren] Failed to load children for block ${blockId}:`, err);
        // Re-collapse on error so user can retry
        if (workspaceId) {
          setCollapsed(workspaceId, blockId, true);
        }
      } finally {
        pendingRef.current.delete(blockId);
      }
    };

    const unsubscribe = getRuntimeEventBus().subscribe(handler);
    return unsubscribe;
  }, [setCollapsed, workspaceId]);
}
