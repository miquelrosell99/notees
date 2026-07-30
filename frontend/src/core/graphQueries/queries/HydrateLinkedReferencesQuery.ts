import type { LinkedReference } from '@/types/api';
import { hydrateLinkedReferences } from '../../projections/LinkedReferenceProjection';
import type { GraphQuery } from '../GraphQuery';

export const HydrateLinkedReferencesQuery: GraphQuery<{ nodeUuid: string; sourceIds: string[] }, LinkedReference[]> = {
  name: 'HydrateLinkedReferencesQuery',
  cacheKey: (i) => `hydrate-linked-refs:${i.nodeUuid}:${i.sourceIds.join(',')}`,
  execute(store, i) {
    return hydrateLinkedReferences(store, i.nodeUuid, i.sourceIds);
  },
  shouldInvalidate() {
    // Hydration is cheap; rely on the source ID query for invalidation.
    return false;
  },
};
