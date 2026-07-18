import { describe, it, expect, beforeEach } from 'vitest';
import { uuidv7 } from '../../uuid';
import { clearQueuedOperations, drainQueuedOperations, queueOperation } from '../operationQueue';
import type { Operation } from '../../types/operation';

function makeOp(nodeId: string): Operation {
  return {
    envelope: {
      id: uuidv7(),
      workspaceId: 'ws-test',
      actorId: 'actor',
      hlc: { physical: Date.now(), logical: 0 },
      affectedNodeIds: [nodeId],
      opType: 'node.create',
    },
    payload: { nodeId, kind: 'page', parentId: null, classIds: [] },
  };
}

describe('operationQueue persistence', () => {
  beforeEach(async () => {
    await clearQueuedOperations('ws-test');
  });

  it('queues, drains, and clears operations', async () => {
    const opA = makeOp('node-a');
    const opB = makeOp('node-b');

    await queueOperation('ws-test', opA);
    await queueOperation('ws-test', opB);

    const drained = await drainQueuedOperations('ws-test');
    expect(drained).toHaveLength(2);
    expect(drained[0].envelope.id).toBe(opA.envelope.id);
    expect(drained[1].envelope.id).toBe(opB.envelope.id);

    const secondDrain = await drainQueuedOperations('ws-test');
    expect(secondDrain).toHaveLength(0);
  });

  it('returns an empty array when no operations are queued', async () => {
    const drained = await drainQueuedOperations('ws-empty');
    expect(drained).toEqual([]);
  });

  it('clears queued operations without draining', async () => {
    await queueOperation('ws-test', makeOp('node-c'));
    await clearQueuedOperations('ws-test');
    const drained = await drainQueuedOperations('ws-test');
    expect(drained).toHaveLength(0);
  });
});
