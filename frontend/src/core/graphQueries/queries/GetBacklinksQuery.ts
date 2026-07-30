import { getBacklinks } from '../../derived/edge';
import type { GraphQuery } from '../GraphQuery';
import type { NodeInput } from '../QueryInput';
import type { IdPageOutput } from '../QueryOutput';

export const GetBacklinksQuery: GraphQuery<NodeInput, IdPageOutput> = {
  name: 'GetBacklinksQuery',
  cacheKey: (i) => `backlinks:${i.nodeUuid}`,
  execute(store, i) {
    const ids = getBacklinks(store.getDb(), i.nodeUuid);
    return { ids, totalCount: ids.length, hasMore: false };
  },
  shouldInvalidate(i, n) {
    const scope = (n as { scope?: string }).scope;
    return scope === 'edge' || scope === 'all' || n.nodeId === i.nodeUuid;
  },
};
