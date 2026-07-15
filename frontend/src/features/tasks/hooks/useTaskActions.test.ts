/**
 * useTaskActions tests — Ctrl/Cmd+Enter three-state task toggle.
 *
 * Covers two regressions:
 *  1. cycleTaskStatus must read task status LIVE from the runtime at call time.
 *     BlockRow does not re-render when the runtime changes, so deciding on
 *     render-time memos kept a mounted editor stuck re-running openTask().
 *  2. resolveTaskStatusIds must read the property list from
 *     propertyKeys.lists() — the key useProperties() writes to.
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
import { propertyKeys } from '@/hooks/queryKeys';
import { SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS } from '@/constants/systemProperties';
import { useTaskActions } from './useTaskActions';
import type { Node } from '@/types/api';

const mocks = vi.hoisted(() => ({
  setPropertyMutate: vi.fn(),
  addClassMutate: vi.fn(),
  removeClassMutate: vi.fn(),
}));

vi.mock('@/features/properties', () => ({
  useProperties: () => ({ data: [] }),
  useSetNodeProperty: () => ({ mutate: mocks.setPropertyMutate }),
}));

vi.mock('@/features/content', () => ({
  useAddClass: () => ({ mutate: mocks.addClassMutate }),
  useRemoveClass: () => ({ mutate: mocks.removeClassMutate }),
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
  // Deliberately NO properties on the API node — simulates a list view that
  // has not refetched yet, while the runtime already knows the status.
  properties_uuid: {},
} as unknown as Node;

function loadRuntimeNode(taskStatus: string | null) {
  getOperationRuntime().loadBaseNodes([
    {
      blockId: 'block-1',
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

describe('useTaskActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const runtime = new OperationRuntime();
    setOperationRuntime(runtime);
    // The event bus is a singleton: rebind it to the fresh runtime so the
    // hook's optimistic upsertNodes() calls land in this test's runtime.
    resetRuntimeEventBus(runtime);
    queryClient.setQueryData(propertyKeys.lists(), [TASK_STATUS_PROPERTY]);
  });

  afterEach(() => {
    queryClient.clear();
    setOperationRuntime(null);
  });

  it('opens a task (task class + Pending status) when the node is not a task', () => {
    loadRuntimeNode(null);
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

  it('advances Pending -> Done from live runtime state, even with a stale node prop', () => {
    loadRuntimeNode('Pending');
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
    loadRuntimeNode('Done');
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
    // The old bug: the resolver read propertyKeys.lists() while useProperties
    // cached under propertyKeys.list(). Data under list() must NOT leak into
    // the resolver — the hook writes/reads lists() exclusively.
    queryClient.clear();
    queryClient.setQueryData(propertyKeys.list(), [TASK_STATUS_PROPERTY]);
    loadRuntimeNode(null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderHook(() => useTaskActions(blockNode), { wrapper });

    act(() => result.current.cycleTaskStatus());

    // Without data at lists(), the Pending status write cannot resolve and
    // must not fire (addClass still runs — it does not need the property).
    expect(mocks.setPropertyMutate).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('optimistically upserts taskStatus into the runtime when applying a status', () => {
    loadRuntimeNode('Pending');
    const { result } = renderHook(() => useTaskActions(blockNode), { wrapper });

    act(() => result.current.cycleTaskStatus());

    // The badge reads taskStatus from the runtime — it must update without
    // waiting for a server refetch.
    expect(getNode(getOperationRuntime(), 'block-1')?.taskStatus).toBe('Done');
  });

  it('sets taskStatus in the runtime when opening a task', () => {
    loadRuntimeNode(null);
    const { result } = renderHook(() => useTaskActions(blockNode), { wrapper });

    act(() => result.current.cycleTaskStatus());

    expect(getNode(getOperationRuntime(), 'block-1')?.taskStatus).toBe('Pending');
  });

  it('clears taskStatus in the runtime when clearing a task', () => {
    loadRuntimeNode('Done');
    const { result } = renderHook(() => useTaskActions(blockNode), { wrapper });

    act(() => result.current.cycleTaskStatus());

    expect(getNode(getOperationRuntime(), 'block-1')?.taskStatus).toBeNull();
  });
});
