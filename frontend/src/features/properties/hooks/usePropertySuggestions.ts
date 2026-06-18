/**
 * React Query hook for property suggestions.
 */
import { useQuery } from '@tanstack/react-query';
import { getPropertySuggestions } from '@/api/properties';
import { propertyKeys } from '@/hooks/queryKeys';

export function usePropertySuggestions(contextNodeId?: number, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: propertyKeys.suggestions(contextNodeId),
    queryFn: () => getPropertySuggestions(contextNodeId ?? undefined),
    enabled: options?.enabled ?? true,
    staleTime: 30_000,
  });
}
