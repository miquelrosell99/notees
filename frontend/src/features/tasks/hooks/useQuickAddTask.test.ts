import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { useQuickAddTask } from './useQuickAddTask';

const mutateAsyncMock = vi.fn();
const setPropertyMutateMock = vi.fn();
const getOrCreateDailyNoteMock = vi.hoisted(() => vi.fn());

vi.mock('@/features/content', () => ({
  useCreateNode: () => ({ mutateAsync: mutateAsyncMock }),
  getOrCreateDailyNoteClient: getOrCreateDailyNoteMock,
}));
vi.mock('@/features/properties', () => ({
  useSetNodeProperty: () => ({ mutate: setPropertyMutateMock }),
}));
vi.mock('@/hooks/useCurrentWorkspaceUuid', () => ({
  useCurrentWorkspaceUuid: () => 'ws-1',
}));
vi.mock('@/core/hooks/useWorkspaceStoreClient', () => ({
  useWorkspaceStoreClient: () => ({ client: {}, isLoading: false, error: null }),
}));


function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client: qc }, children);
}

describe('useQuickAddTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getOrCreateDailyNoteMock.mockResolvedValue({ uuid: 'daily-uuid' });
    mutateAsyncMock.mockResolvedValue({ uuid: 'new-task-uuid' });
  });

  it('creates a task block on today\'s daily page and schedules it for today', async () => {
    const { result } = renderHook(() => useQuickAddTask(), { wrapper });
    await act(async () => { await result.current.quickAdd('Buy milk'); });
    expect(mutateAsyncMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Buy milk', parent_uuid: 'daily-uuid' }),
    );
    expect(setPropertyMutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ nodeUuid: 'new-task-uuid', value: expect.stringMatching(/^00000000-0000-0000-00dd-/) }),
      expect.objectContaining({ onSettled: expect.any(Function) }),
    );
  });

  it('ignores empty names', async () => {
    const { result } = renderHook(() => useQuickAddTask(), { wrapper });
    await act(async () => { await result.current.quickAdd('   '); });
    expect(mutateAsyncMock).not.toHaveBeenCalled();
  });

  it('reports failures via toast and rethrows', async () => {
    mutateAsyncMock.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useQuickAddTask(), { wrapper });
    await expect(act(async () => { await result.current.quickAdd('X'); })).rejects.toThrow('boom');
    const { useNotificationStore } = await import('@/stores/notificationStore');
    expect(useNotificationStore.getState().notifications.some((n) => n.type === 'error')).toBe(true);
  });
});
