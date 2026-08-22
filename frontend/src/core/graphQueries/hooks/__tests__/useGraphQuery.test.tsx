import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useGraphQuery } from '../useGraphQuery';
import type { IWorkspaceStoreClient, NotifyChangeMessage } from '@/core/worker/workerProtocol';
import type { GraphQuery } from '../../GraphQuery';

vi.mock('@/core/hooks/useWorkspaceStoreClient', () => ({
  useWorkspaceStoreClient: vi.fn(),
}));

import { useWorkspaceStoreClient } from '@/core/hooks/useWorkspaceStoreClient';

const TestQuery: GraphQuery<{ nodeUuid: string }, { value: string }> = {
  name: 'TestQuery',
  cacheKey: (i) => `test:${i.nodeUuid}`,
  execute: (_store, i) => ({ value: i.nodeUuid }),
  shouldInvalidate: (i, n) => n.nodeId === i.nodeUuid,
};

function createMockClient(): IWorkspaceStoreClient & { emit: (n?: NotifyChangeMessage) => void } {
  const listeners = new Set<(notification?: NotifyChangeMessage) => void>();
  return {
    init: vi.fn().mockResolvedValue(undefined),
    export: vi.fn().mockResolvedValue(new Uint8Array()),
    mutate: vi.fn(),
    query: vi.fn().mockResolvedValue({ value: 'result' }),
    subscribe: (_nodeId, callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    subscribeProgress: () => () => {},
    close: vi.fn(),
    isClosed: () => false,
    emit: (notification) => {
      for (const cb of listeners) cb(notification);
    },
  };
}

describe('useGraphQuery', () => {
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    mockClient = createMockClient();
    vi.mocked(useWorkspaceStoreClient).mockReturnValue({
      client: mockClient,
      isLoading: false,
      error: null,
    });
  });

  it('calls executeGraphQuery with the query name and input', async () => {
    const { result } = renderHook(() => useGraphQuery(TestQuery, { nodeUuid: 'node-1' }));
    await waitFor(() => expect(result.current.data).toEqual({ value: 'result' }));
    expect(mockClient.query).toHaveBeenCalledWith('executeGraphQuery', ['TestQuery', { nodeUuid: 'node-1' }]);
  });

  it('exposes a refetch function', async () => {
    const { result } = renderHook(() => useGraphQuery(TestQuery, { nodeUuid: 'node-1' }));
    await waitFor(() => expect(result.current.data).toEqual({ value: 'result' }));
    expect(mockClient.query).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.refetch();
    });
    expect(mockClient.query).toHaveBeenCalledTimes(2);
  });

  it('refetches when shouldInvalidate returns true', async () => {
    const { result } = renderHook(() => useGraphQuery(TestQuery, { nodeUuid: 'node-1' }));
    await waitFor(() => expect(result.current.data).toEqual({ value: 'result' }));
    expect(mockClient.query).toHaveBeenCalledTimes(1);

    act(() => {
      mockClient.emit({ type: 'notify', nodeId: 'node-1' });
    });
    await waitFor(() => expect(mockClient.query).toHaveBeenCalledTimes(2));
  });

  it('does not refetch when shouldInvalidate returns false', async () => {
    const { result } = renderHook(() => useGraphQuery(TestQuery, { nodeUuid: 'node-1' }));
    await waitFor(() => expect(result.current.data).toEqual({ value: 'result' }));
    expect(mockClient.query).toHaveBeenCalledTimes(1);

    act(() => {
      mockClient.emit({ type: 'notify', nodeId: 'node-2' });
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockClient.query).toHaveBeenCalledTimes(1);
  });
});
