import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { getOperationRuntime, setOperationRuntime, OperationRuntime } from '@/runtime';
import type { CoreNode } from '@/runtime';
import { getUndoEngine } from '@/stores/undoEngine';
import { liveSyncManager } from '@/features/collab';
import { useContentSave } from './useContentSave';

const blockId = 'block-1';
const contentAST = [{ type: 'paragraph', children: [{ type: 'text', text: 'hello' }] }];

function loadNode() {
  getOperationRuntime().loadBaseNodes([
    {
      blockId,
      parentId: null,
      orderIndex: 0,
      nodeType: 'block',
      contentAST,
      collapsed: false,
      isDeleted: false,
      isPage: false,
      name: 'node',
      icon: null,
      color: null,
      classIds: [],
      tagIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    } as CoreNode,
  ]);
}

describe('useContentSave', () => {
  beforeEach(() => {
    setOperationRuntime(new OperationRuntime());
    loadNode();
    vi.spyOn(liveSyncManager, 'sendBlockUpdate').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setOperationRuntime(null);
  });

  it('debounces content changes', async () => {
    const applyIntentSpy = vi.spyOn(getUndoEngine(), 'applyIntent');
    const { result } = renderHook(() => useContentSave({ delay: 100 }));

    result.current.handleContentChange(blockId, JSON.stringify(contentAST));
    expect(applyIntentSpy).not.toHaveBeenCalled();

    await waitFor(() => expect(applyIntentSpy).toHaveBeenCalledTimes(1), { timeout: 300 });
  });

  it('flushes immediately after the keystroke threshold', () => {
    const applyIntentSpy = vi.spyOn(getUndoEngine(), 'applyIntent');
    const { result } = renderHook(() => useContentSave({ delay: 10_000 }));

    for (let i = 0; i < 9; i += 1) {
      result.current.handleContentChange(blockId, JSON.stringify(contentAST));
      expect(applyIntentSpy).not.toHaveBeenCalled();
    }

    result.current.handleContentChange(blockId, JSON.stringify(contentAST));
    expect(applyIntentSpy).toHaveBeenCalledTimes(1);
  });

  it('flushes pending changes on unmount', async () => {
    const applyIntentSpy = vi.spyOn(getUndoEngine(), 'applyIntent');
    const { result, unmount } = renderHook(() => useContentSave({ delay: 10_000 }));

    result.current.handleContentChange(blockId, JSON.stringify(contentAST));
    expect(applyIntentSpy).not.toHaveBeenCalled();

    unmount();
    await waitFor(() => expect(applyIntentSpy).toHaveBeenCalledTimes(1));
  });
});
