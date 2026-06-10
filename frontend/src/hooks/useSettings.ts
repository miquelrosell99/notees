/**
 * React Query hook for user settings.
 * 
 * Provides cached, deduplicated access to settings via TanStack Query.
 * This prevents multiple components from each firing separate GET /settings
 * requests, and ensures settings are available from cache on navigation.
 */
import { useQuery } from '@tanstack/react-query';
import { getSettings } from '@/features/workspace/api/workspaces';
import { settingsKeys } from './queryKeys';

/**
 * Hook to get all user settings with caching.
 * 
 * Settings are cached for 5 minutes (staleTime) to avoid redundant
 * requests, especially during view transitions. TanStack Query also
 * deduplicates concurrent requests automatically.
 */
export function useSettingsQuery() {
  return useQuery({
    queryKey: settingsKeys.all,
    queryFn: getSettings,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}
