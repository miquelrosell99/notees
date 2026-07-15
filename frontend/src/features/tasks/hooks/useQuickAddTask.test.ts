import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { useQuickAddTask } from './useQuickAddTask';
import * as nodesApi from '@/api/nodes';

const mutateAsyncMock = vi.fn();
const setPropertyMutateMock = vi.fn();

// The real module exposes named function exports (no `nodesApi` object);
// the hook consumes it via a namespace import, like CalendarPopup does.
vi.mock('@/api/nodes', () => ({
  getOrCreateDaily: vi.fn(),
}));
vi.mock('@/features/content', () => ({
  useCreateNode: () => ({ mutateAsync: mutateAsyncMock }),
}));
vi.mock('@/features/properties', () => ({
  useSetNodeProperty: () => ({ mutate: setPropertyMutateMock }),
}));

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client: qc }, children);
}

describe('useQuickAddTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(nodesApi.getOrCreateDaily).mockResolvedValue({ uuid: 'daily-uuid' } as never);
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
