import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHttpTransport } from '../transportHttp';
import { uuidv7 } from '../uuid';
import { PROTOCOL_VERSION } from '../types/operation';

describe('HttpTransport', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends a batch with the correct body and headers', async () => {
    const workspaceId = uuidv7();
    const actorId = uuidv7();
    const transport = createHttpTransport(workspaceId, actorId, 'http://localhost:8000');

    const envelope = {
      id: uuidv7(),
      protocolVersion: PROTOCOL_VERSION,
      workspaceId,
      actorId,
      affectedNodeIds: ['node-1'],
      opType: 'node.create',
      hlc: { physical: 1000, logical: 0 },
      payload: { nodeId: 'node-1', kind: 'page' },
    };

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ saved_count: 1, saved_ids: [envelope.id] }), { status: 200 })
    );
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const result = await transport.send(envelope);

    expect(result.savedIds).toEqual([envelope.id]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8000/api/relay/batch');
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('include');
    expect((init?.headers as Record<string, string>)['X-Actor-Id']).toBe(actorId);
    const body = JSON.parse((init?.body as string) ?? '{}');
    expect(body.envelopes).toHaveLength(1);
    expect(body.envelopes[0]).toEqual(envelope);
  });

  it('throws a clear error on 403 during send', async () => {
    const transport = createHttpTransport('ws-1', 'actor-1');
    const mockFetch = vi.fn().mockResolvedValue(new Response('Forbidden', { status: 403 }));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    await expect(
      transport.send({
        id: uuidv7(),
        protocolVersion: PROTOCOL_VERSION,
        workspaceId: 'ws-1',
        actorId: 'actor-1',
        affectedNodeIds: [],
        opType: 'node.create',
        hlc: { physical: 1, logical: 0 },
        payload: {},
      })
    ).rejects.toThrow('Relay write denied');
  });

  it('parses catch-up response envelopes', async () => {
    const workspaceId = uuidv7();
    const actorId = uuidv7();
    const transport = createHttpTransport(workspaceId, actorId);

    const returnedEnvelope = {
      id: uuidv7(),
      protocolVersion: PROTOCOL_VERSION,
      workspaceId,
      actorId,
      affectedNodeIds: ['node-2'],
      opType: 'node.create',
      hlc: { physical: 2000, logical: 0 },
      payload: { nodeId: 'node-2', kind: 'page' },
    };

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          envelopes: [returnedEnvelope],
          next_after_seq: 43,
          has_more: true,
        }),
        { status: 200 }
      )
    );
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const result = await transport.catchUp(42);

    expect(result.envelopes).toHaveLength(1);
    expect(result.envelopes[0]).toEqual(returnedEnvelope);
    expect(result.nextAfterSeq).toBe(43);
    expect(result.hasMore).toBe(true);

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/relay/catch-up');
    const body = JSON.parse((init?.body as string) ?? '{}');
    expect(body.workspace_id).toBe(workspaceId);
    expect(body.after_seq).toBe(42);
    expect(body.hlc).toBeUndefined();
    expect(body.after_id).toBeUndefined();
  });

  it('throws a clear error on 403 during catchUp', async () => {
    const transport = createHttpTransport('ws-1', 'actor-1');
    const mockFetch = vi.fn().mockResolvedValue(new Response('Forbidden', { status: 403 }));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    await expect(transport.catchUp(0)).rejects.toThrow('Relay read denied');
  });

  it('skips snapshot upload when data exceeds the client size limit', async () => {
    const transport = createHttpTransport('ws-1', 'actor-1');
    const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ snapshot_id: 'snap-1' }), { status: 200 }));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    await transport.uploadSnapshot({
      snapshotId: '',
      workspaceId: 'ws-1',
      hlc: { physical: 1, logical: 0 },
      data: new Uint8Array(11 * 1024 * 1024),
      restoreEpoch: 0,
      hasSnapshot: true,
      upToSeq: null,
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('uploads snapshots below the client size limit', async () => {
    const transport = createHttpTransport('ws-1', 'actor-1');
    const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ snapshot_id: 'snap-1' }), { status: 200 }));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    await transport.uploadSnapshot({
      snapshotId: '',
      workspaceId: 'ws-1',
      hlc: { physical: 1, logical: 0 },
      data: new Uint8Array(1024),
      restoreEpoch: 0,
      hasSnapshot: true,
      upToSeq: null,
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/relay/snapshot');
    expect(init?.method).toBe('POST');
  });
});
