import { describe, it, expect } from 'vitest';
import { encryptEnvelope, decryptEnvelope, type OperationEnvelope } from '../crypto';
import { uuidv7 } from '../uuid';

describe('relay envelope helpers', () => {
  it('encryptEnvelope returns a plaintext envelope with the payload', async () => {
    const metadata = {
      id: uuidv7(),
      workspaceId: uuidv7(),
      actorId: uuidv7(),
      affectedNodeIds: ['node-1'],
      opType: 'node.create',
      hlc: { physical: 1000, logical: 0 },
    };
    const payload = { nodeId: 'node-1', kind: 'page' };

    const envelope = await encryptEnvelope(payload, undefined, metadata);

    expect(envelope.id).toBe(metadata.id);
    expect(envelope.workspaceId).toBe(metadata.workspaceId);
    expect(envelope.actorId).toBe(metadata.actorId);
    expect(envelope.affectedNodeIds).toEqual(metadata.affectedNodeIds);
    expect(envelope.opType).toBe(metadata.opType);
    expect(envelope.hlc).toEqual(metadata.hlc);
    expect(envelope.payload).toBe(payload);
  });

  it('decryptEnvelope returns the payload directly', async () => {
    const payload = { value: 42 };
    const envelope: OperationEnvelope = {
      id: uuidv7(),
      workspaceId: uuidv7(),
      actorId: uuidv7(),
      affectedNodeIds: [],
      opType: 'test.op',
      hlc: { physical: 1, logical: 0 },
      payload,
    };

    const decrypted = await decryptEnvelope(envelope);

    expect(decrypted).toBe(payload);
  });
});
