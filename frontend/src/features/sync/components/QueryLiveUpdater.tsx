/**
 * QueryLiveUpdater
 *
 * Keeps QueryAST-backed results fresh as the local runtime changes. It
 * subscribes to the RuntimeEventBus and invalidates active query result caches
 * after a short debounce. This gives linked references, node views, and search
 * near-live updates without waiting for a server round-trip.
 */

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getRuntimeEventBus } from '@/runtime/eventBus';
import { nodeViewKeys } from '@/features/content/hooks/useNodeViews';
import { nodeKeys } from '@/hooks/queryKeys';

const INVALIDATION_DEBOUNCE_MS = 300;

export function QueryLiveUpdater(): null {
  const queryClient = useQueryClient();

  useEffect(() => {
    const bus = getRuntimeEventBus();
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const invalidateSearch = () => {
      queryClient.invalidateQueries({
        queryKey: nodeKeys.searchAll(),
        refetchType: 'active',
      });
    };

    const invalidateQueryResults = () => {
      queryClient.invalidateQueries({
        queryKey: nodeViewKeys.queryResults(),
        refetchType: 'active',
      });
      queryClient.invalidateQueries({
        queryKey: nodeKeys.allLinkedRefs(),
        refetchType: 'active',
      });
      invalidateSearch();
    };

    let needsSearch = false;
    let needsQueryResults = false;

    const scheduleInvalidate = () => {
      if (timeout !== null) return;
      timeout = setTimeout(() => {
        timeout = null;
        if (needsQueryResults) {
          invalidateQueryResults();
        } else if (needsSearch) {
          invalidateSearch();
        }
        needsSearch = false;
        needsQueryResults = false;
      }, INVALIDATION_DEBOUNCE_MS);
    };

    const unsubscribe = bus.subscribe((event) => {
      if (event.type === 'nodes_changed') {
        // Content-only edits should not reload linked references or query-backed
        // sections while the user is typing. Only the search index needs to stay
        // fresh, and it is debounced separately by the search layer.
        needsSearch = true;
        scheduleInvalidate();
      } else if (event.type === 'structure_changed' || event.type === 'block_deleted') {
        // Structural edits (create, move, delete, collapse) can change query
        // results and backlink graphs, so invalidate everything.
        needsSearch = true;
        needsQueryResults = true;
        scheduleInvalidate();
      }
    });

    return () => {
      unsubscribe();
      if (timeout !== null) {
        clearTimeout(timeout);
      }
    };
  }, [queryClient]);

  return null;
}
