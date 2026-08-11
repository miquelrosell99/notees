import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSaveQueryAsView } from './useSaveQueryAsView';
import { createEmptyQueryAST } from '@/types/queryAST';

const mutateAsyncMock = vi.fn();
const openNodeMock = vi.fn();
const closeNodeCollectionMock = vi.fn();
const notifyErrorMock = vi.fn();

vi.mock('@/features/content', () => ({
  useCreateNode: () => ({ mutateAsync: mutateAsyncMock }),
  useSystemClasses: () => ({
    systemClassUuids: { query: 'query-class-uuid' },
  }),
}));

vi.mock('@/stores', () => ({
  useNavigationStore: (selector: (s: unknown) => unknown) =>
    selector({ openNode: openNodeMock, closeNodeCollection: closeNodeCollectionMock }),
}));

vi.mock('@/stores/notificationStore', () => ({
  useNotificationStore: { getState: () => ({ error: notifyErrorMock }) },
}));

const ast = {
  ...createEmptyQueryAST(),
  root_group: { type: 'group' as const, logic: 'AND' as const, children: [] },
};

describe('useSaveQueryAsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mutateAsyncMock.mockResolvedValueOnce({ uuid: 'new-page-uuid' }).mockResolvedValueOnce({ uuid: 'new-block-uuid' });
  });

  it('creates a page plus a query-class child block, then navigates', async () => {
    const { result } = renderHook(() => useSaveQueryAsView());
    await act(() => result.current.saveAsView('My view', ast));

    expect(mutateAsyncMock).toHaveBeenCalledTimes(2);
    expect(mutateAsyncMock).toHaveBeenNthCalledWith(1, {
      name: 'My view',
      kind: 'page',
    });
    const secondCall = mutateAsyncMock.mock.calls[1][0];
    expect(secondCall.parent_uuid).toBe('new-page-uuid');
    expect(secondCall.class_uuids).toEqual(['query-class-uuid']);
    const nameAST = JSON.parse(secondCall.name);
    expect(nameAST[0]).toEqual({ type: 'paragraph', children: [{ type: 'text', text: 'My view' }] });
    expect(nameAST[1]).toEqual({ type: 'query', data: ast });

    expect(closeNodeCollectionMock).toHaveBeenCalled();
    expect(openNodeMock).toHaveBeenCalledWith('new-page-uuid');
  });

  it('ignores empty titles without creating anything', async () => {
    const { result } = renderHook(() => useSaveQueryAsView());
    await act(() => result.current.saveAsView('   ', ast));
    expect(mutateAsyncMock).not.toHaveBeenCalled();
  });

  it('notifies and rethrows when creation fails', async () => {
    mutateAsyncMock.mockReset();
    mutateAsyncMock.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useSaveQueryAsView());
    await expect(act(() => result.current.saveAsView('My view', ast))).rejects.toThrow('offline');
    expect(notifyErrorMock).toHaveBeenCalled();
    expect(openNodeMock).not.toHaveBeenCalled();
  });
});
