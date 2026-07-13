/**
 * useProperties cache-key contract test.
 *
 * Imperative readers (useRuntimeSync.resolveTaskStatus,
 * useTaskActions.resolveTaskStatusIds) read the property list via
 * queryClient.getQueryData(propertyKeys.lists()). useProperties must publish
 * under that exact key — caching under propertyKeys.list() hashes differently
 * ({ type: undefined } is part of the key) and silently broke task-status
 * resolution and the task badge.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { propertyKeys } from '@/hooks/queryKeys';
import { useProperties } from './usePropertyQueries';
import { listProperties } from '@/api/properties';

vi.mock('@/api/properties', () => ({
  listProperties: vi.fn(),
}));

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

describe('useProperties', () => {
  it('caches the property list under propertyKeys.lists()', async () => {
    vi.mocked(listProperties).mockResolvedValue([
      { uuid: 'prop-1', name: 'Status', type: 'selection', options: [] },
    ] as never);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    renderHook(() => useProperties(), { wrapper: makeWrapper(client) });

    await waitFor(() => {
      expect(client.getQueryData(propertyKeys.lists())).toEqual([
        { uuid: 'prop-1', name: 'Status', type: 'selection', options: [] },
      ]);
    });
    // ...and NOT under the old mismatched key.
    expect(client.getQueryData(propertyKeys.list())).toBeUndefined();
  });
});
