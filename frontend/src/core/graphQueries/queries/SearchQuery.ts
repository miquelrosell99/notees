import { queryNodes } from '../../query/queryNodes';
import type { WorkspaceStore } from '../../store';
import type { GraphQuery } from '../GraphQuery';
import type { IdPageOutput } from '../QueryOutput';

export interface SearchInput {
  query: string;
  classIds?: string[];
  isPage?: boolean;
  limit?: number;
  offset?: number;
}

export const SearchQuery: GraphQuery<SearchInput, IdPageOutput> = {
  name: 'SearchQuery',
  cacheKey: (i) => `search:${i.query}:${i.classIds?.join(',') ?? ''}:${i.isPage ?? ''}:${i.limit ?? 'all'}:${i.offset ?? 0}`,
  execute(store, i) {
    const allIds = queryNodes(store, {
      query: i.query,
      classIds: i.classIds,
      isPage: i.isPage,
      projectionDepth: 0,
    }).map((n) => n.uuid);
    const offset = i.offset ?? 0;
    const limit = i.limit ?? allIds.length;
    const ids = allIds.slice(offset, offset + limit);
    return { ids, totalCount: allIds.length, hasMore: offset + limit < allIds.length };
  },
  shouldInvalidate() {
    // Search is cheap enough to refresh on any change; refine later.
    return true;
  },
};
