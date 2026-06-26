import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getOperationRuntime, setOperationRuntime, OperationRuntime } from '@/runtime';
import type { Operation } from '@/runtime';
import { localSyncEngine } from './localSyncEngine';

function makeCreateOp(id: string, blockId: string): Operation {
  return {
    id,
    type: 'create',
    blockId,
    state: 'pending',
    dependsOn: [],
    retryCount: 0,
    maxRetries: 3,
    createdAt: Date.now(),
    payload: {
      parentId: null,
      afterBlockId: null,
      contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: 'hello' }] }],
    },
  };
}

describe('LocalSyncEngine', () => {
  beforeEach(() => {
    setOperationRuntime(new OperationRuntime());
    void localSyncEngine.clear();
  });

  afterEach(() => {
    setOperationRuntime(null);
  });

  it('applies an operation to the runtime and stages it in the outbox', async () => {
    const op = makeCreateOp('op-1', 'block-1');
    await localSyncEngine.apply(op);

    expect(getOperationRuntime().getOperations()).toHaveLength(1);
    expect(getOperationRuntime().getOperations()[0].id).toBe('op-1');

    const pending = localSyncEngine.getPendingEntries();
    expect(pending).toHaveLength(1);
    expect(pending[0].op.id).toBe('op-1');
    expect(pending[0].attemptCount).toBe(0);
    expect(pending[0].lastError).toBeNull();
  });

  it('stages operations without re-applying them to the runtime', async () => {
    const op = makeCreateOp('op-2', 'block-2');
    getOperationRuntime().applyOperation(op);

    await localSyncEngine.stageOperations([op]);

    expect(getOperationRuntime().getOperations()).toHaveLength(1);
    expect(localSyncEngine.getPendingEntries()).toHaveLength(1);
  });

  it('acknowledging an entry removes it from the outbox', async () => {
    const op = makeCreateOp('op-3', 'block-3');
    await localSyncEngine.apply(op);
    await localSyncEngine.acknowledge('op-3');

    expect(localSyncEngine.getPendingEntries()).toHaveLength(0);
  });

  it('records failures with retry metadata', async () => {
    const op = makeCreateOp('op-4', 'block-4');
    await localSyncEngine.apply(op);

    const nextRetry = Date.now() + 5000;
    await localSyncEngine.fail('op-4', 'network error', nextRetry);

    const entry = localSyncEngine.getEntry('op-4');
    expect(entry).toBeDefined();
    expect(entry!.attemptCount).toBe(1);
    expect(entry!.lastError).toBe('network error');
    expect(entry!.nextRetryAt).toBe(nextRetry);
  });

  it('creates a failure entry for a missing operation when it exists in the runtime', async () => {
    const op = makeCreateOp('op-5', 'block-5');
    getOperationRuntime().applyOperation(op);

    await localSyncEngine.fail('op-5', 'timeout', null);

    const entry = localSyncEngine.getEntry('op-5');
    expect(entry).toBeDefined();
    expect(entry!.attemptCount).toBe(1);
  });

  it('removes an entry explicitly', async () => {
    const op = makeCreateOp('op-6', 'block-6');
    await localSyncEngine.apply(op);
    await localSyncEngine.remove('op-6');

    expect(localSyncEngine.getPendingEntries()).toHaveLength(0);
  });

  it('manages the acked vector and next sequence number', async () => {
    localSyncEngine.setAckedVector({ nodeA: { clientA: 5 } });
    await localSyncEngine.flush();

    expect(localSyncEngine.getAckedVector()).toEqual({ nodeA: { clientA: 5 } });

    const seq = localSyncEngine.consumeSeq();
    expect(seq).toBeGreaterThan(0);
    expect(localSyncEngine.getNextSeq()).toBe(seq);
  });

  it('clears all state', async () => {
    await localSyncEngine.apply(makeCreateOp('op-7', 'block-7'));
    localSyncEngine.setAckedVector({ nodeA: { clientA: 2 } });
    localSyncEngine.consumeSeq();

    await localSyncEngine.clear();

    expect(localSyncEngine.getPendingEntries()).toHaveLength(0);
    expect(localSyncEngine.getAckedVector()).toEqual({});
    expect(localSyncEngine.getNextSeq()).toBe(0);
  });

  it('survives a simulated reload by re-initialising from storage', async () => {
    const op = makeCreateOp('op-8', 'block-8');
    await localSyncEngine.apply(op);
    await localSyncEngine.flush();

    // Simulate a new engine instance reading the same backing store.
    const reloaded = new (localSyncEngine.constructor as new () => typeof localSyncEngine)();
    await reloaded.init();

    expect(reloaded.getPendingEntries()).toHaveLength(1);
    expect(reloaded.getPendingEntries()[0].op.id).toBe('op-8');
  });
});
