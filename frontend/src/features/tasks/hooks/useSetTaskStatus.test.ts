/**
 * useSetTaskStatus tests — node-agnostic task status setter.
 *
 * Mirrors the mock pattern of useTaskActions.test.ts: fresh OperationRuntime
 * per test, event bus rebound to it, `@/features/properties` mocked, and the
 * task Status property seeded into the shared queryClient at
 * propertyKeys.lists().
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { getOperationRuntime, setOperationRuntime, OperationRuntime } from '@/runtime';
import type { CoreNode } from '@/runtime';
import { getNode } from '@/runtime/graphHelpers';
import { resetRuntimeEventBus } from '@/runtime/eventBus';
import { queryClient } from '@/lib/queryClient';
import { propertyKeys, taskKeys } from '@/hooks/queryKeys';
import { SYSTEM_PROPERTY_UUIDS } from '@/constants/systemProperties';
import { getTodayDayUuid } from '@/utils/dateUuid';
import { useSetTaskStatus } from './useSetTaskStatus';

const mocks = vi.hoisted(() => ({
  setPropertyMutate: vi.fn(),
}));
const setPropertyMutate = mocks.setPropertyMutate;

vi.mock('@/features/properties', () => ({
  useProperties: () => ({ data: [] }),
  useSetNodeProperty: () => ({ mutate: mocks.setPropertyMutate }),
}));

const TASK_STATUS_PROPERTY = {
  uuid: SYSTEM_PROPERTY_UUIDS.task_status,
  name: 'Status',
  type: 'selection',
  options: [
    { uuid: 'opt-pending-uuid', name: 'Pending' },
    { uuid: 'opt-done-uuid', name: 'Done' },
  ],
};

function loadRuntimeNode(taskStatus: string | null) {
  getOperationRuntime().loadBaseNodes([
    {
      blockId: 'task-1',
      parentId: null,
      orderIndex: 0,
      nodeType: 'block',
      contentAST: [],
      collapsed: false,
      isDeleted: false,
      isPage: false,
      name: 'node',
      icon: null,
      color: null,
      classIds: [],
      tagIds: [],
      taskStatus,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    } as CoreNode,
  ]);
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client }, children);
}

describe('useSetTaskStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const runtime = new OperationRuntime();
    setOperationRuntime(runtime);
    // The event bus is a singleton: rebind it to the fresh runtime so the
    // hook's optimistic upsertNodes() calls land in this test's runtime.
    resetRuntimeEventBus(runtime);
    queryClient.setQueryData(propertyKeys.lists(), [TASK_STATUS_PROPERTY]);
    loadRuntimeNode('Pending');
  });

  afterEach(() => {
    queryClient.clear();
    setOperationRuntime(null);
  });

  it('sets a task status via the resolved property/option ids and mirrors it to the runtime', () => {
    const { result } = renderHook(() => useSetTaskStatus(), { wrapper });
    act(() => result.current('task-1', 'Done'));
    expect(setPropertyMutate).toHaveBeenCalledWith(
      { nodeUuid: 'task-1', propertyId: TASK_STATUS_PROPERTY.uuid, value: 'opt-done-uuid' },
      expect.objectContaining({ onSettled: expect.any(Function) }),
    );
    expect(getNode(getOperationRuntime(), 'task-1')?.taskStatus).toBe('Done');
  });

  it('clears a task status with value null', () => {
    const { result } = renderHook(() => useSetTaskStatus(), { wrapper });
    act(() => result.current('task-1', null));
    expect(setPropertyMutate).toHaveBeenCalledWith(
      { nodeUuid: 'task-1', propertyId: SYSTEM_PROPERTY_UUIDS.task_status, value: null },
      expect.objectContaining({ onSettled: expect.any(Function) }),
    );
    expect(getNode(getOperationRuntime(), 'task-1')?.taskStatus).toBeNull();
  });

  it('invalidates the tasks popup queries on settle', () => {
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useSetTaskStatus(), { wrapper });
    act(() => result.current('task-1', 'Done'));
    const onSettled = setPropertyMutate.mock.calls[0][1].onSettled as () => void;
    act(() => onSettled());
    expect(spy).toHaveBeenCalledWith({ queryKey: ['tasks', 'popup'] });
  });

  it('optimistically moves a completed task from its open section into the completed section', () => {
    const node = { uuid: 'task-1', name: 'Task' };
    queryClient.setQueryData(taskKeys.popup('today'), { nodes: [node], total_count: 1 });
    queryClient.setQueryData(taskKeys.popup('completed'), { nodes: [], total_count: 0 });

    const { result } = renderHook(() => useSetTaskStatus(), { wrapper });
    act(() => result.current('task-1', 'Done'));

    expect(queryClient.getQueryData(taskKeys.popup('today'))).toEqual({ nodes: [], total_count: 0 });
    expect(queryClient.getQueryData(taskKeys.popup('completed'))).toEqual({ nodes: [node], total_count: 1 });
  });

  it('moves an un-completed task back into the open section matching its date', () => {
    const node = {
      uuid: 'task-1',
      name: 'Task',
      properties_uuid: { [SYSTEM_PROPERTY_UUIDS.task_scheduled]: getTodayDayUuid() },
    };
    queryClient.setQueryData(taskKeys.popup('completed'), { nodes: [node], total_count: 1 });
    queryClient.setQueryData(taskKeys.popup('today'), { nodes: [], total_count: 0 });

    const { result } = renderHook(() => useSetTaskStatus(), { wrapper });
    act(() => result.current('task-1', 'Pending'));

    expect(queryClient.getQueryData(taskKeys.popup('completed'))).toEqual({ nodes: [], total_count: 0 });
    expect(queryClient.getQueryData(taskKeys.popup('today'))).toEqual({ nodes: [node], total_count: 1 });
  });

  it('rolls the popup sections back when the mutation errors', () => {
    const node = { uuid: 'task-1', name: 'Task' };
    queryClient.setQueryData(taskKeys.popup('today'), { nodes: [node], total_count: 1 });
    queryClient.setQueryData(taskKeys.popup('completed'), { nodes: [], total_count: 0 });

    const { result } = renderHook(() => useSetTaskStatus(), { wrapper });
    act(() => result.current('task-1', 'Done'));

    const onError = setPropertyMutate.mock.calls[0][1].onError as () => void;
    act(() => onError());

    expect(queryClient.getQueryData(taskKeys.popup('today'))).toEqual({ nodes: [node], total_count: 1 });
    expect(queryClient.getQueryData(taskKeys.popup('completed'))).toEqual({ nodes: [], total_count: 0 });
  });
});
