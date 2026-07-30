import type { WorkspaceStore } from '../../store';
import type { GraphQuery } from '../GraphQuery';
import type { NodeInput } from '../QueryInput';
import type { IdPageOutput } from '../QueryOutput';

export const GetChildrenQuery: GraphQuery<NodeInput, IdPageOutput> = {
  name: 'GetChildrenQuery',
  cacheKey: (i) => `children:${i.nodeUuid}`,
  execute(store, i) {
    const ids = store.getChildren(i.nodeUuid);
    return { ids, totalCount: ids.length, hasMore: false };
  },
  shouldInvalidate(i, n) {
    const scope = (n as { scope?: string }).scope;
    return scope === 'tree' || scope === 'all' || n.nodeId === i.nodeUuid;
  },
};
