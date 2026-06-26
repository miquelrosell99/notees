/**
 * LocalIndexManager — keeps the offline node mirror and MiniSearch index warm.
 *
 * Observes successful TanStack Query responses, extracts nodes, and writes them
 * to localNodeStore + searchIndex. This is the bridge between the server's
 * authoritative state and the local offline fallback.
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useWorkspaces } from '@/features/workspace';
import { addOrUpdateNodes } from '../local/localNodeStore';
import { indexNodes } from '../local/searchIndex';
import type { Node } from '@/types/api';

const FLUSH_DELAY_MS = 250;

function isNode(value: unknown): value is Node {
  return (
    typeof value === 'object' &&
    value !== null &&
    'uuid' in value &&
    typeof (value as { uuid?: unknown }).uuid === 'string' &&
    'name' in value &&
    typeof (value as { name?: unknown }).name === 'string'
  );
}

function extractNodes(data: unknown): Node[] {
  if (!data) return [];

  if (Array.isArray(data)) {
    return data.flatMap((item) => extractNodes(item));
  }

  if (typeof data !== 'object') return [];

  const record = data as Record<string, unknown>;
  const nodes: Node[] = [];

  if (isNode(record)) {
    nodes.push(record);
  }

  if ('nodes' in record && record.nodes) {
    if (Array.isArray(record.nodes)) {
      nodes.push(...record.nodes.filter(isNode));
    } else if (typeof record.nodes === 'object') {
      nodes.push(...Object.values(record.nodes).filter(isNode));
    }
  }

  if ('children' in record && Array.isArray(record.children)) {
    nodes.push(...record.children.flatMap((child) => extractNodes(child)));
  }

  return nodes;
}

export function LocalIndexManager(): ReactNode {
  const queryClient = useQueryClient();
  const { data: workspacesData } = useWorkspaces({ enabled: true });
  const activeWorkspace = workspacesData?.items?.find((ws) => ws.is_active) ?? workspacesData?.items?.[0];
  const workspaceUuid = activeWorkspace?.uuid;

  const pendingRef = useRef<Map<string, Node>>(new Map());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!workspaceUuid) return;

    const flush = async () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      const batch = Array.from(pendingRef.current.values());
      pendingRef.current.clear();
      if (batch.length === 0) return;

      try {
        await Promise.all([
          addOrUpdateNodes(workspaceUuid, batch),
          indexNodes(workspaceUuid, batch),
        ]);
      } catch (err) {
        console.error('[LocalIndexManager] Failed to flush local index', err);
      }
    };

    const scheduleFlush = () => {
      if (timerRef.current) return;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void flush();
      }, FLUSH_DELAY_MS);
    };

    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event?.type !== 'updated' || !event.query) return;
      const query = event.query;
      if (query.state.status !== 'success') return;
      if (!query.state.data) return;

      const queryKey = query.queryKey as string[];
      if (!queryKey || queryKey.length === 0) return;
      // Only index node-related query families.
      if (queryKey[0] !== 'nodes' && queryKey[0] !== 'nodeViews') return;

      const nodes = extractNodes(query.state.data);
      if (nodes.length === 0) return;

      for (const node of nodes) {
        pendingRef.current.set(node.uuid, node);
      }
      scheduleFlush();
    });

    return () => {
      unsubscribe();
      void flush();
    };
  }, [queryClient, workspaceUuid]);

  return null;
}
