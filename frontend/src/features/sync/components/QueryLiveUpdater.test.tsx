/**
 * Tests for QueryLiveUpdater runtime-event-driven invalidation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { QueryLiveUpdater } from './QueryLiveUpdater';
import { getRuntimeEventBus, resetRuntimeEventBus } from '@/runtime/eventBus';
import { OperationRuntime, setOperationRuntime, getOperationRuntime } from '@/runtime';
import type { CoreNode } from '@/runtime/operation';
import { nodeViewKeys } from '@/features/content/hooks/useNodeViews';

let fetchCount = 0;

function TestQuery() {
  const { data } = useQuery({
    queryKey: nodeViewKeys.queryResult('live-view-1', {}),
    queryFn: () => {
      fetchCount += 1;
      return `result-${fetchCount}`;
    },
    staleTime: 0,
  });
  return <span data-testid="result">{data}</span>;
}

describe('QueryLiveUpdater', () => {
  beforeEach(() => {
    const runtime = new OperationRuntime();
    setOperationRuntime(runtime);
    resetRuntimeEventBus(runtime);
    fetchCount = 0;
  });

  afterEach(() => {
    setOperationRuntime(null);
  });

  it('refetches active node-view queries after a runtime change', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const { findByText } = render(<TestQuery />, {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>
          <QueryLiveUpdater />
          {children}
        </QueryClientProvider>
      ),
    });

    expect(fetchCount).toBe(1);

    const runtime = getOperationRuntime();
    const node: CoreNode = {
      blockId: 'node-1',
      parentId: null,
      orderIndex: 0,
      nodeType: 'block',
      contentAST: [{ type: 'paragraph', children: [{ type: 'text', text: 'hello' }] }],
      collapsed: false,
      isDeleted: false,
      isPage: false,
      name: 'hello',
      icon: null,
      color: null,
      classIds: [],
      tagIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    };
    act(() => {
      runtime.upsertBaseNodes([node]);
      getRuntimeEventBus().flushEvents();
    });

    // The updater debounces invalidation by 300ms.
    await findByText('result-2');

    expect(fetchCount).toBe(2);
  });
});
