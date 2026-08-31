import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { useAddClassExtends, useRemoveClassExtends } from './useClassPropertyMutations';

const queryMock = vi.hoisted(() => vi.fn());
const mutateMock = vi.hoisted(() => vi.fn());

vi.mock('react-router-dom', () => ({
  useParams: () => ({ workspaceId: 'ws-1' }),
}));
vi.mock('@/core/hooks/useWorkspaceStoreClient', () => ({
  useWorkspaceStoreClient: () => ({
    client: { query: queryMock, mutate: mutateMock },
    isLoading: false,
    error: null,
  }),
}));

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client: qc }, children);
}

describe('useAddClassExtends', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('adds the class to the direct extends list via setClassExtends', async () => {
    queryMock.mockResolvedValue({ id: 'class-1', extendsClassIds: ['parent-a'] });
    const { result } = renderHook(() => useAddClassExtends(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ classId: 'class-1', extendsClassId: 'parent-b' });
    });
    expect(queryMock).toHaveBeenCalledWith('getClass', ['class-1']);
    expect(mutateMock).toHaveBeenCalledWith('setClassExtends', [
      { classId: 'class-1', extendsClassIds: ['parent-a', 'parent-b'] },
    ]);
  });

  it('starts from an empty extends list when the class row is missing', async () => {
    queryMock.mockResolvedValue(undefined);
    const { result } = renderHook(() => useAddClassExtends(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ classId: 'class-1', extendsClassId: 'parent-b' });
    });
    expect(mutateMock).toHaveBeenCalledWith('setClassExtends', [
      { classId: 'class-1', extendsClassIds: ['parent-b'] },
    ]);
  });
});

describe('useRemoveClassExtends', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('removes the class from the direct extends list via setClassExtends', async () => {
    queryMock.mockResolvedValue({ id: 'class-1', extendsClassIds: ['parent-a', 'parent-b'] });
    const { result } = renderHook(() => useRemoveClassExtends(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ classId: 'class-1', extendsClassId: 'parent-a' });
    });
    expect(mutateMock).toHaveBeenCalledWith('setClassExtends', [
      { classId: 'class-1', extendsClassIds: ['parent-b'] },
    ]);
  });
});
