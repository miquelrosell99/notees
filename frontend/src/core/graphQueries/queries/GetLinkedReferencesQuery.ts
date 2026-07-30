import { createEmptyQueryAST } from '@/types/queryAST';
import { autoFixSystemQuery } from '@/lib/systemQueryAutoFix';
import { queryNodes } from '../../query/queryNodes';
import type { WorkspaceStore } from '../../store';
import type { GraphQuery } from '../GraphQuery';
import type { PaginatedInput } from '../QueryInput';
import type { IdPageOutput } from '../QueryOutput';

export const GetLinkedReferencesQuery: GraphQuery<PaginatedInput, IdPageOutput> = {
  name: 'GetLinkedReferencesQuery',
  cacheKey: (i) => `linked-refs:${i.nodeUuid}:${i.limit ?? 'all'}:${i.offset ?? 0}`,
  execute(store, i) {
    const ast = autoFixSystemQuery(createEmptyQueryAST(), 'linked_references', { nodeUuid: i.nodeUuid });
    const allIds = queryNodes(store, {
      ast,
      runtimeParams: { current_node_uuid: i.nodeUuid, current_node_id: i.nodeUuid },
      projectionDepth: 0,
    }).map((n) => n.uuid);
    const offset = i.offset ?? 0;
    const limit = i.limit ?? allIds.length;
    const ids = allIds.slice(offset, offset + limit);
    return { ids, totalCount: allIds.length, hasMore: offset + limit < allIds.length };
  },
  shouldInvalidate(i, n) {
    const scope = (n as { scope?: string }).scope;
    return scope === 'edge' || scope === 'all' || n.nodeId === i.nodeUuid;
  },
};
