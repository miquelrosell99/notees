import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import { WorkspaceStore } from '../../store';
import { uuidv7 } from '../../uuid';
import { createTestDatabase } from '../../__tests__/helpers';
import { registerQuery, executeGraphQuery } from '../queryRegistry';

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

async function makeStore() {
  const db = await createTestDatabase();
  const workspaceId = uuidv7();
  const actorId = uuidv7();
  return new WorkspaceStore(db, workspaceId, actorId);
}

registerQuery({
  name: 'EchoQuery',
  cacheKey: (i) => `echo:${(i as { x: string }).x}`,
  execute: (_store, i) => i,
  shouldInvalidate: () => false,
});

describe('queryRegistry', () => {
  it('dispatches a registered query', async () => {
    const store = await makeStore();
    const result = executeGraphQuery(store, 'EchoQuery', { x: 'hi' });
    expect(result).toEqual({ x: 'hi' });
  });

  it('throws for unknown queries', async () => {
    const store = await makeStore();
    expect(() => executeGraphQuery(store, 'Missing', {})).toThrow('Unknown graph query');
  });
});
