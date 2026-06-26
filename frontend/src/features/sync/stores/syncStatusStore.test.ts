import { describe, it, expect } from 'vitest';
import { useSyncStatusStore } from './syncStatusStore';
import type { OutboxEntry } from '@/lib/operationStorage';

function makeEntry(patch?: Partial<OutboxEntry>): OutboxEntry {
  return {
    op: {
      id: 'op-1',
      type: 'create',
      blockId: 'block-1',
      state: 'pending',
      dependsOn: [],
      retryCount: 0,
      maxRetries: 3,
      createdAt: Date.now(),
      payload: { parentId: null, afterBlockId: null, contentAST: [] },
    },
    attemptCount: 0,
    lastError: null,
    nextRetryAt: null,
    createdAt: Date.now(),
    ...patch,
  };
}

describe('syncStatusStore', () => {
  it('defaults to synced with empty queue', () => {
    const state = useSyncStatusStore.getState();
    expect(state.status).toBe('synced');
    expect(state.pendingCount).toBe(0);
    expect(state.failedCount).toBe(0);
    expect(state.lastError).toBeNull();
  });

  it('shows syncing when there are pending entries', () => {
    useSyncStatusStore.getState().setQueue([makeEntry()]);
    const state = useSyncStatusStore.getState();
    expect(state.status).toBe('syncing');
    expect(state.pendingCount).toBe(1);
    expect(state.failedCount).toBe(0);
  });

  it('shows error when there are failed entries', () => {
    useSyncStatusStore
      .getState()
      .setQueue([makeEntry({ attemptCount: 1, lastError: 'boom' })]);
    const state = useSyncStatusStore.getState();
    expect(state.status).toBe('error');
    expect(state.pendingCount).toBe(0);
    expect(state.failedCount).toBe(1);
    expect(state.lastError).toBe('boom');
  });

  it('returns to synced when the queue is cleared', () => {
    useSyncStatusStore.getState().setQueue([makeEntry({ attemptCount: 2, lastError: 'x' })]);
    useSyncStatusStore.getState().setQueue([]);
    const state = useSyncStatusStore.getState();
    expect(state.status).toBe('synced');
    expect(state.failedCount).toBe(0);
    expect(state.lastError).toBeNull();
  });
});
