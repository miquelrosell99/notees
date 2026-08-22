/**
 * Tests for capability gating (local-first split, Task 4).
 *
 * Capabilities derive from the connection mode, which `serverUrl.ts` resolves
 * from localStorage once at module init — so each mode is set up by seeding
 * localStorage, resetting the module registry, and re-importing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { SERVER_URL_STORAGE_KEY } from './serverUrl';
import type { Capabilities } from './capabilities';

const ALL_FALSE: Capabilities = {
  shares: false,
  notifications: false,
  importExport: false,
  admin: false,
  accountSecurity: false,
  workspaceManagement: false,
  activity: false,
  collabPresence: false,
  plugins: false,
};

const ALL_TRUE: Capabilities = {
  shares: true,
  notifications: true,
  importExport: true,
  admin: true,
  accountSecurity: true,
  workspaceManagement: true,
  activity: true,
  collabPresence: true,
  plugins: true,
};

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useCapabilities', () => {
  it('disables every capability in local mode', async () => {
    localStorage.setItem(SERVER_URL_STORAGE_KEY, '');
    const { useCapabilities } = await import('./capabilities');

    const { result } = renderHook(() => useCapabilities());
    expect(result.current).toEqual(ALL_FALSE);
  });

  it('enables every capability when connected (same-origin default)', async () => {
    const { useCapabilities } = await import('./capabilities');

    const { result } = renderHook(() => useCapabilities());
    expect(result.current).toEqual(ALL_TRUE);
  });

  it('enables every capability with a configured remote server', async () => {
    localStorage.setItem(SERVER_URL_STORAGE_KEY, 'https://notes.example.com');
    const { useCapabilities } = await import('./capabilities');

    const { result } = renderHook(() => useCapabilities());
    expect(result.current).toEqual(ALL_TRUE);
  });

  it('keeps capabilities enabled when a configured server is unreachable', async () => {
    localStorage.setItem(SERVER_URL_STORAGE_KEY, 'https://notes.example.com');
    const { useCapabilities } = await import('./capabilities');
    const { useConnectionStore } = await import('@/stores/connectionStore');

    useConnectionStore.setState({ healthy: false });
    const { result } = renderHook(() => useCapabilities());
    expect(result.current).toEqual(ALL_TRUE);
  });

  it('reacts to health transitions without leaving local mode', async () => {
    localStorage.setItem(SERVER_URL_STORAGE_KEY, '');
    const { useCapabilities } = await import('./capabilities');
    const { useConnectionStore } = await import('@/stores/connectionStore');

    const { result } = renderHook(() => useCapabilities());
    expect(result.current).toEqual(ALL_FALSE);

    act(() => useConnectionStore.setState({ healthy: true }));
    expect(result.current).toEqual(ALL_FALSE);
  });
});
