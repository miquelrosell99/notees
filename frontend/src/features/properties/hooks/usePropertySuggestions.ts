/**
 * React Query hook for property suggestions.
 */
import { useQuery } from '@tanstack/react-query';
import { getPropertySuggestions } from '@/api/properties';
import { propertyKeys } from '@/hooks/queryKeys';
import { resolveNodeUuid } from '@/utils/resolveNodeUuid';

export function usePropertySuggestions(contextNodeId?: string | number, options?: { enabled?: boolean }) {
  const contextNodeUuid = contextNodeId == null ? undefined : typeof contextNodeId === 'string' ? contextNodeId : resolveNodeUuid(contextNodeId);
  return useQuery({
    queryKey: propertyKeys.suggestions(contextNodeUuid),
    queryFn: () => getPropertySuggestions(contextNodeUuid),
    enabled: options?.enabled ?? true,
    staleTime: 30_000,
  });
}
