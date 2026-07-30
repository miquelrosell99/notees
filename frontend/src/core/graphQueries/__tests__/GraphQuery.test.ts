import { describe, it, expect } from 'vitest';
import type { GraphQuery } from '../GraphQuery';

describe('GraphQuery contract', () => {
  it('can be implemented', () => {
    const q: GraphQuery<{ nodeUuid: string }, { ids: string[] }> = {
      name: 'TestQuery',
      cacheKey: (i) => `test:${i.nodeUuid}`,
      execute: (_store, _i) => ({ ids: [] }),
      shouldInvalidate: () => false,
    };
    expect(q.name).toBe('TestQuery');
    expect(q.cacheKey({ nodeUuid: 'x' })).toBe('test:x');
  });
});
