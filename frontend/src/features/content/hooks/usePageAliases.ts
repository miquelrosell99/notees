/**
 * React Query hook for fetching page aliases from the local-first core store.
 */
import { useQuery } from '@tanstack/react-query';
import { nodeKeys } from '@/hooks/queryKeys';
import { useCurrentWorkspaceUuid } from '@/hooks/useCurrentWorkspaceUuid';
import { useWorkspaceStore } from '@/core/hooks/useWorkspaceStore';
import { queryAll } from '@/core/db/sqlite';
import { projectNode } from '@/core/adapters/nodeProjection';
import type { Node } from '@/types/api';

export function usePageAliases(nodeUuid: string | null | undefined, options?: { enabled?: boolean }) {
  const workspaceUuid = useCurrentWorkspaceUuid();
  const { store } = useWorkspaceStore(workspaceUuid ?? '');

  return useQuery<Node[], Error>({
    queryKey: nodeKeys.aliases(nodeUuid ?? ''),
    queryFn: () => {
      if (!nodeUuid || !store) throw new Error('Node UUID or workspace store not found');
      const rows = queryAll<{ alias_node_id: string }>(
        store.getDb(),
        'SELECT alias_node_id FROM node_alias WHERE canonical_node_id = ?',
        [nodeUuid]
      );
      return rows
        .map((row) => projectNode(store, row.alias_node_id))
        .filter((n): n is Node => n !== undefined && n.uuid !== nodeUuid);
    },
    enabled: !!nodeUuid && !!store && (options?.enabled ?? true),
  });
}
