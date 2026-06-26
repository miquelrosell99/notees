/**
 * React Query hook for property suggestions.
 */
import { useQuery } from '@tanstack/react-query';
import { getPropertySuggestions } from '@/api/properties';
import { propertyKeys } from '@/hooks/queryKeys';

export function usePropertySuggestions(contextNodeUuid?: string, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: propertyKeys.suggestions(contextNodeUuid),
    queryFn: () => getPropertySuggestions(contextNodeUuid),
    enabled: options?.enabled ?? true,
    staleTime: 30_000,
  });
}
