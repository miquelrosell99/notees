/**
 * useTaskActions tests — Ctrl/Cmd+Enter three-state task toggle.
 *
 * Covers reading task membership and status from the local-first core store
 * and resolving status option IDs from the propertyKeys.lists() cache.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { queryClient } from '@/lib/queryClient';
import { propertyKeys } from '@/hooks/queryKeys';
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from '@/constants/systemProperties';
import { useTaskActions } from './useTaskActions';
import type { Node } from '@/types/api';

type UseNodeResult = { node: { classIds: string[] } | undefined; isLoading: boolean; error: Error | null };
type UsePropertyResult = { value: unknown; isLoading: boolean; error: Error | null };
type UseParamsResult = { workspaceId?: string };

const mocks = vi.hoisted(() => ({
  setPropertyMutate: vi.fn(),
  addClassMutate: vi.fn(),
  removeClassMutate: vi.fn(),
  useNode: vi.fn(() => ({ node: undefined, isLoading: false, error: null } as UseNodeResult)),
  useProperty: vi.fn(() => ({ value: undefined, isLoading: false, error: null } as UsePropertyResult)),
  useParams: vi.fn(() => ({ workspaceId: 'ws-1' } as UseParamsResult)),
}));

vi.mock('@/features/properties', () => ({
  useProperties: () => ({ data: [] }),
  useSetNodeProperty: () => ({ mutate: mocks.setPropertyMutate }),
}));

vi.mock('@/features/content', () => ({
  useAddClass: () => ({ mutate: mocks.addClassMutate }),
  useRemoveClass: () => ({ mutate: mocks.removeClassMutate }),
}));

vi.mock('@/core/hooks/useNode', () => ({
  useNode: mocks.useNode,
}));

vi.mock('@/core/hooks/useProperty', () => ({
  useProperty: mocks.useProperty,
}));

vi.mock('react-router-dom', () => ({
  useParams: mocks.useParams,
}));

const TASK_STATUS_PROPERTY = {
  uuid: SYSTEM_PROPERTY_UUIDS.task_status,
  name: 'Status',
  type: 'selection',
  options: [
    { uuid: 'opt-pending', name: 'Pending' },
    { uuid: 'opt-done', name: 'Done' },
  ],
};

const blockNode = {
  uuid: 'block-1',
  name: '[]',
  properties_uuid: {},
} as unknown as Node;

function setCoreTaskState(taskClass: boolean, statusOptionUuid?: string) {
  mocks.useNode.mockReturnValue({
    node: taskClass ? { classIds: [SYSTEM_CLASS_UUIDS.task] } : { classIds: [] },
    isLoading: false,
    error: null,
  });
  mocks.useProperty.mockReturnValue({
    value: statusOptionUuid,
    isLoading: false,
    error: null,
  });
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client }, children);
}

describe('useTaskActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useParams.mockReturnValue({ workspaceId: 'ws-1' });
    queryClient.setQueryData(propertyKeys.lists(), [TASK_STATUS_PROPERTY]);
  });

  afterEach(() => {
    queryClient.clear();
  });

  it('opens a task (task class + Pending status) when the node is not a task', () => {
    setCoreTaskState(false);
    const { result } = renderHook(() => useTaskActions(blockNode), { wrapper });

    act(() => result.current.cycleTaskStatus());

    expect(mocks.addClassMutate).toHaveBeenCalledWith({
      nodeUuid: 'block-1',
      classId: SYSTEM_CLASS_UUIDS.task,
    });
    expect(mocks.setPropertyMutate).toHaveBeenCalledWith({
      nodeUuid: 'block-1',
      propertyId: SYSTEM_PROPERTY_UUIDS.task_status,
      value: 'opt-pending',
    });
  });

  it('advances Pending -> Done from the core store, even with a stale node prop', () => {
    setCoreTaskState(true, 'opt-pending');
    const { result } = renderHook(() => useTaskActions(blockNode), { wrapper });

    act(() => result.current.cycleTaskStatus());

    expect(mocks.addClassMutate).not.toHaveBeenCalled();
    expect(mocks.setPropertyMutate).toHaveBeenCalledWith({
      nodeUuid: 'block-1',
      propertyId: SYSTEM_PROPERTY_UUIDS.task_status,
      value: 'opt-done',
    });
  });

  it('clears status and task class when cycling from Done', () => {
    setCoreTaskState(true, 'opt-done');
    const { result } = renderHook(() => useTaskActions(blockNode), { wrapper });

    act(() => result.current.cycleTaskStatus());

    expect(mocks.setPropertyMutate).toHaveBeenCalledWith({
      nodeUuid: 'block-1',
      propertyId: SYSTEM_PROPERTY_UUIDS.task_status,
      value: null,
    });
    expect(mocks.removeClassMutate).toHaveBeenCalledWith({
      nodeUuid: 'block-1',
      classId: SYSTEM_CLASS_UUIDS.task,
    });
  });

  it('reads status option ids from propertyKeys.lists() (the useProperties cache key)', () => {
    queryClient.clear();
    queryClient.setQueryData(propertyKeys.list(), [TASK_STATUS_PROPERTY]);
    setCoreTaskState(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderHook(() => useTaskActions(blockNode), { wrapper });

    act(() => result.current.cycleTaskStatus());

    expect(mocks.setPropertyMutate).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('falls back to treating the node as non-task when no workspace id is available', () => {
    mocks.useParams.mockReturnValue({});
    setCoreTaskState(false);
    const { result } = renderHook(() => useTaskActions(blockNode), { wrapper });

    act(() => result.current.cycleTaskStatus());

    expect(mocks.addClassMutate).toHaveBeenCalledWith({
      nodeUuid: 'block-1',
      classId: SYSTEM_CLASS_UUIDS.task,
    });
  });
});
