import { projectNode } from '../../adapters/nodeProjection';
import type { Node } from '@/types/api';
import type { GraphQuery } from '../GraphQuery';
import type { NodeInput } from '../QueryInput';

export const GetPageQuery: GraphQuery<NodeInput, { node: Node | undefined }> = {
  name: 'GetPageQuery',
  cacheKey: (i) => `page:${i.nodeUuid}`,
  execute(store, i) {
    return { node: projectNode(store, i.nodeUuid, 2) };
  },
  shouldInvalidate(i, n) {
    const scope = (n as { scope?: string }).scope;
    return scope === 'node' || scope === 'tree' || scope === 'all' || n.nodeId === i.nodeUuid;
  },
};
