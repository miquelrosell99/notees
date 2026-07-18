/**
 * React Query hook for fetching page aliases.
 *
 * The new local-first architecture does not yet have a dedicated alias relation,
 * so the migration MVP returns an empty list. This keeps dependents from crashing
 * while removing the legacy `@/api/nodes` dependency.
 */
import { useQuery } from '@tanstack/react-query';
import { nodeKeys } from '@/hooks/queryKeys';
import type { Node } from '@/types/api';

export function usePageAliases(
  nodeUuid: string | null | undefined,
  options?: { enabled?: boolean }
) {
  return useQuery<Node[], Error>({
    queryKey: nodeKeys.aliases(nodeUuid ?? ''),
    queryFn: () => [],
    enabled: !!nodeUuid && (options?.enabled ?? true),
  });
}
