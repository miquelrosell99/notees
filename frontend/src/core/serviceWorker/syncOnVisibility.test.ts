/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registerVisibilitySync } from './syncOnVisibility';
import type { SyncEngine } from '../sync';

function setVisibilityState(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    value: state,
    configurable: true,
  });
}

function dispatchVisibilityChange(): void {
  document.dispatchEvent(new Event('visibilitychange'));
}

function createMockSyncEngine(status: 'idle' | 'syncing' = 'idle'): SyncEngine {
  return {
    getStatus: vi.fn().mockReturnValue(status),
    sync: vi.fn().mockResolvedValue(undefined),
  } as unknown as SyncEngine;
}

describe('registerVisibilitySync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibilityState('hidden');
  });

  afterEach(() => {
    vi.useRealTimers();
    setVisibilityState('visible');
  });

  it('debounces visibility changes and triggers a sync after the delay', () => {
    const syncEngine = createMockSyncEngine('idle');
    const cleanup = registerVisibilitySync(syncEngine);

    setVisibilityState('visible');
    dispatchVisibilityChange();
    dispatchVisibilityChange();
    dispatchVisibilityChange();

    expect(syncEngine.sync).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);

    expect(syncEngine.sync).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it('does not trigger sync while a sync is already running', () => {
    const syncEngine = createMockSyncEngine('syncing');
    const cleanup = registerVisibilitySync(syncEngine);

    setVisibilityState('visible');
    dispatchVisibilityChange();

    vi.advanceTimersByTime(300);

    expect(syncEngine.sync).not.toHaveBeenCalled();

    cleanup();
  });

  it('triggers sync when the device comes back online', () => {
    const syncEngine = createMockSyncEngine('idle');
    const cleanup = registerVisibilitySync(syncEngine);

    window.dispatchEvent(new Event('online'));

    expect(syncEngine.sync).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);

    expect(syncEngine.sync).toHaveBeenCalledTimes(1);

    cleanup();
  });
});
