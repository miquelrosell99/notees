import { describe, it, expect, beforeEach } from 'vitest';
import { useSyncStatusStore } from './syncStatusStore';

beforeEach(() => {
  useSyncStatusStore.setState({
    status: 'synced',
    pendingCount: 0,
    failedCount: 0,
    lastError: null,
  });
});

describe('syncStatusStore', () => {
  it('defaults to synced with empty counts', () => {
    const state = useSyncStatusStore.getState();
    expect(state.status).toBe('synced');
    expect(state.pendingCount).toBe(0);
    expect(state.failedCount).toBe(0);
    expect(state.lastError).toBeNull();
  });

  it('shows syncing when set to syncing with pending entries', () => {
    useSyncStatusStore.getState().setStatus('syncing', { pendingCount: 1 });
    const state = useSyncStatusStore.getState();
    expect(state.status).toBe('syncing');
    expect(state.pendingCount).toBe(1);
    expect(state.failedCount).toBe(0);
  });

  it('shows error when set to error with failed entries', () => {
    useSyncStatusStore
      .getState()
      .setStatus('error', { failedCount: 1, lastError: 'boom' });
    const state = useSyncStatusStore.getState();
    expect(state.status).toBe('error');
    expect(state.pendingCount).toBe(0);
    expect(state.failedCount).toBe(1);
    expect(state.lastError).toBe('boom');
  });

  it('returns to synced when set to synced', () => {
    useSyncStatusStore
      .getState()
      .setStatus('error', { failedCount: 2, lastError: 'x' });
    useSyncStatusStore
      .getState()
      .setStatus('synced', { pendingCount: 0, failedCount: 0, lastError: null });
    const state = useSyncStatusStore.getState();
    expect(state.status).toBe('synced');
    expect(state.pendingCount).toBe(0);
    expect(state.failedCount).toBe(0);
    expect(state.lastError).toBeNull();
  });
});
