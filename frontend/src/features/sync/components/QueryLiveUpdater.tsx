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

    const invalidateQueries = () => {
      queryClient.invalidateQueries({
        queryKey: nodeViewKeys.queryResults(),
        refetchType: 'active',
      });
      queryClient.invalidateQueries({
        queryKey: nodeKeys.allLinkedRefs(),
        refetchType: 'active',
      });
      queryClient.invalidateQueries({
        queryKey: nodeKeys.searchAll(),
        refetchType: 'active',
      });
    };

    const scheduleInvalidate = () => {
      if (timeout !== null) return;
      timeout = setTimeout(() => {
        timeout = null;
        invalidateQueries();
      }, INVALIDATION_DEBOUNCE_MS);
    };

    const unsubscribe = bus.subscribe((event) => {
      if (
        event.type === 'nodes_changed' ||
        event.type === 'structure_changed' ||
        event.type === 'block_deleted'
      ) {
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
