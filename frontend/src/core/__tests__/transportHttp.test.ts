import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHttpTransport } from '../transportHttp';
import { uuidv7 } from '../uuid';

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

    await transport.send(envelope);

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
      workspaceId,
      actorId,
      affectedNodeIds: ['node-2'],
      opType: 'node.create',
      hlc: { physical: 2000, logical: 0 },
      payload: { nodeId: 'node-2', kind: 'page' },
    };

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ envelopes: [returnedEnvelope] }), { status: 200 })
    );
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const result = await transport.catchUp({ physical: 1000, logical: 0 });

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(returnedEnvelope);

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/relay/catch-up');
    const body = JSON.parse((init?.body as string) ?? '{}');
    expect(body.workspace_id).toBe(workspaceId);
    expect(body.hlc).toEqual({ physical: 1000, logical: 0 });
  });

  it('throws a clear error on 403 during catchUp', async () => {
    const transport = createHttpTransport('ws-1', 'actor-1');
    const mockFetch = vi.fn().mockResolvedValue(new Response('Forbidden', { status: 403 }));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    await expect(transport.catchUp({ physical: 0, logical: 0 })).rejects.toThrow(
      'Relay read denied'
    );
  });
});
