/**
 * Recents local-first state backed by a persisted Zustand store.
 *
 * Provides a query-shaped hook for components and an imperative helper for
 * non-component code that needs to drop a node from the cached list.
 */
import { useRecentsStore } from '@/stores/recentsStore';
import type { RecentItem } from '@/stores/recentsStore';

export type { RecentItem };

export function useRecents(limit = 10) {
  const recents = useRecentsStore((state) => state.recents);
  const data = recents.slice(0, limit);
  return { data, isLoading: false, error: null };
}

export function addRecent(nodeUuid: string): void {
  useRecentsStore.getState().addRecent(nodeUuid);
}

export function removeRecent(nodeUuid: string): void {
  useRecentsStore.getState().removeRecent(nodeUuid);
}

export function clearRecents(): void {
  useRecentsStore.getState().clearRecents();
}
