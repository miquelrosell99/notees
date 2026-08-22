/**
 * Tests for the backend health watchdog in the local-first split (Task 2).
 *
 * - Local mode (server URL explicitly cleared): never polls, never locks.
 * - Remote server configured: polls `<serverUrl>/api/health`.
 *
 * `serverUrl.ts` and `useBackendHealth.ts` resolve the setting at module init,
 * so every test resets the module registry and re-imports.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { SERVER_URL_STORAGE_KEY } from '@/config/serverUrl';

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function mockHealthyFetch() {
  const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('useBackendHealth in local mode', () => {
  it('never polls and never touches the banner/lock state', async () => {
    localStorage.setItem(SERVER_URL_STORAGE_KEY, '');
    vi.resetModules();
    const fetchMock = mockHealthyFetch();
    const { useConnectionStore } = await import('@/stores/connectionStore');
    const { useBackendHealth } = await import('../useBackendHealth');

    renderHook(() => useBackendHealth());
    // Run far past the lock threshold and several poll cycles.
    await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));

    expect(fetchMock).not.toHaveBeenCalled();
    const state = useConnectionStore.getState();
    expect(state.healthy).toBeNull();
    expect(state.lockUI).toBe(false);
    expect(state.unhealthySince).toBeNull();
  });
});

describe('useBackendHealth with a configured server', () => {
  it('polls <serverUrl>/api/health', async () => {
    localStorage.setItem(SERVER_URL_STORAGE_KEY, 'https://notes.example.com');
    vi.resetModules();
    const fetchMock = mockHealthyFetch();
    const { useBackendHealth } = await import('../useBackendHealth');

    renderHook(() => useBackendHealth());
    await act(() => vi.advanceTimersByTimeAsync(10));

    expect(fetchMock).toHaveBeenCalledWith(
      'https://notes.example.com/api/health',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('polls same-origin /api/health when no server is configured (unchanged default)', async () => {
    const fetchMock = mockHealthyFetch();
    const { useBackendHealth } = await import('../useBackendHealth');

    renderHook(() => useBackendHealth());
    await act(() => vi.advanceTimersByTimeAsync(10));

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/health',
      expect.objectContaining({ method: 'GET' }),
    );
  });
});
