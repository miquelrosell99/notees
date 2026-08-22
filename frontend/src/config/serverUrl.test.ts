/**
 * Tests for the runtime server configuration (local-first split, Task 1).
 *
 * `serverUrl.ts` reads localStorage once at module init, so every test that
 * needs a different stored setting resets the module registry and re-imports.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { SERVER_URL_STORAGE_KEY } from './serverUrl';
import type { OperationEnvelope } from '@/core/crypto';

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getServerUrl / setServerUrl', () => {
  it('returns null when no setting exists (same-origin default)', async () => {
    const { getServerUrl } = await import('./serverUrl');
    expect(getServerUrl()).toBeNull();
  });

  it('normalizes whitespace and trailing slashes', async () => {
    const { getServerUrl, setServerUrl } = await import('./serverUrl');
    setServerUrl('  https://notes.example.com/  ');
    expect(getServerUrl()).toBe('https://notes.example.com');
  });

  it('persists the normalized URL and round-trips through localStorage', async () => {
    const { setServerUrl } = await import('./serverUrl');
    setServerUrl('http://localhost:8000/');
    expect(localStorage.getItem(SERVER_URL_STORAGE_KEY)).toBe('http://localhost:8000');

    // A fresh module instance (post-reload) sees the persisted value.
    vi.resetModules();
    const reloaded = await import('./serverUrl');
    expect(reloaded.getServerUrl()).toBe('http://localhost:8000');
  });

  it('rejects non-http(s) URLs without persisting them', async () => {
    const { setServerUrl } = await import('./serverUrl');
    expect(() => setServerUrl('ftp://notes.example.com')).toThrow(/http\(s\)/);
    expect(() => setServerUrl('not a url')).toThrow();
    expect(localStorage.getItem(SERVER_URL_STORAGE_KEY)).toBeNull();
  });

  it('treats setServerUrl(null) as an explicit opt into local mode', async () => {
    const { getServerUrl, setServerUrl } = await import('./serverUrl');
    setServerUrl('https://notes.example.com');
    setServerUrl(null);
    expect(getServerUrl()).toBeNull();
    expect(localStorage.getItem(SERVER_URL_STORAGE_KEY)).toBe('');
  });

  it('treats a corrupted stored value as absent (same-origin default)', async () => {
    localStorage.setItem(SERVER_URL_STORAGE_KEY, '%%not-a-url%%');
    vi.resetModules();
    const { getServerUrl, getConnectionMode } = await import('./serverUrl');
    expect(getServerUrl()).toBeNull();
    expect(getConnectionMode(null)).toBe('connected');
  });
});

describe('getApiBaseUrl', () => {
  it("is '/api' when no server is configured (byte-identical default)", async () => {
    const { getApiBaseUrl } = await import('./serverUrl');
    expect(getApiBaseUrl()).toBe('/api');
  });

  it('prefixes /api with the configured server origin', async () => {
    const { getApiBaseUrl, setServerUrl } = await import('./serverUrl');
    setServerUrl('https://notes.example.com');
    expect(getApiBaseUrl()).toBe('https://notes.example.com/api');
  });
});

describe('getConnectionMode', () => {
  it("is 'local' when the setting was explicitly cleared, regardless of health", async () => {
    const { getConnectionMode, setServerUrl } = await import('./serverUrl');
    setServerUrl(null);
    expect(getConnectionMode(true)).toBe('local');
    expect(getConnectionMode(false)).toBe('local');
    expect(getConnectionMode(null)).toBe('local');
  });

  it('follows the health state when a server is configured', async () => {
    const { getConnectionMode, setServerUrl } = await import('./serverUrl');
    setServerUrl('https://notes.example.com');
    expect(getConnectionMode(true)).toBe('connected');
    expect(getConnectionMode(false)).toBe('unreachable');
    expect(getConnectionMode(null)).toBe('connected');
  });

  it('follows the health state for the same-origin default (no setting)', async () => {
    const { getConnectionMode } = await import('./serverUrl');
    expect(getConnectionMode(true)).toBe('connected');
    expect(getConnectionMode(false)).toBe('unreachable');
  });
});

describe('useConnectionMode', () => {
  it("stays 'local' across health transitions when the setting is cleared", async () => {
    localStorage.setItem(SERVER_URL_STORAGE_KEY, '');
    vi.resetModules();
    const { useConnectionMode, useConnectionStore } = await import('@/stores/connectionStore');

    useConnectionStore.setState({ healthy: false });
    const { result } = renderHook(() => useConnectionMode());
    expect(result.current).toBe('local');

    act(() => useConnectionStore.setState({ healthy: true }));
    expect(result.current).toBe('local');
  });

  it('transitions between connected and unreachable with the health state', async () => {
    const { useConnectionMode, useConnectionStore } = await import('@/stores/connectionStore');

    useConnectionStore.setState({ healthy: true });
    const { result } = renderHook(() => useConnectionMode());
    expect(result.current).toBe('connected');

    act(() => useConnectionStore.setState({ healthy: false }));
    expect(result.current).toBe('unreachable');
  });
});

describe('axios client wiring', () => {
  async function captureAxiosBaseUrl(): Promise<unknown> {
    const axios = await import('axios');
    const createSpy = vi.spyOn(axios.default, 'create');
    await import('@/api/client');
    expect(createSpy).toHaveBeenCalledTimes(1);
    return (createSpy.mock.calls[0] as [{ baseURL?: string }])[0].baseURL;
  }

  it("uses '/api' when no server is configured", async () => {
    expect(await captureAxiosBaseUrl()).toBe('/api');
  });

  it('uses the configured server origin when one is set', async () => {
    localStorage.setItem(SERVER_URL_STORAGE_KEY, 'https://notes.example.com');
    vi.resetModules();
    expect(await captureAxiosBaseUrl()).toBe('https://notes.example.com/api');
  });
});

describe('HttpTransport wiring', () => {
  async function sendOneBatch(
    transport: { sendBatch: (envelopes: OperationEnvelope[]) => Promise<unknown> },
    mockFetch: ReturnType<typeof vi.fn>
  ): Promise<string> {
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    const envelope = {
      id: 'op-1',
      protocolVersion: 1,
      workspaceId: 'ws-1',
      actorId: 'actor-1',
      affectedNodeIds: [],
      opType: 'node.create',
      hlc: { physical: 1, logical: 0 },
      payload: {},
    } as unknown as OperationEnvelope;
    await transport.sendBatch([envelope]);
    return (mockFetch.mock.calls[0] as [string, RequestInit])[0];
  }

  const okResponse = () =>
    new Response(JSON.stringify({ saved_count: 1, saved_ids: ['op-1'] }), { status: 200 });

  it('posts same-origin when no server is configured', async () => {
    const { createHttpTransport } = await import('@/core/transportHttp');
    const transport = createHttpTransport('ws-1', 'actor-1');
    const mockFetch = vi.fn().mockResolvedValue(okResponse());
    const url = await sendOneBatch(transport, mockFetch);
    expect(url).toBe('/api/relay/batch');
  });

  it('posts to the configured server origin when one is set', async () => {
    localStorage.setItem(SERVER_URL_STORAGE_KEY, 'https://notes.example.com/');
    vi.resetModules();
    const { createHttpTransport } = await import('@/core/transportHttp');
    const transport = createHttpTransport('ws-1', 'actor-1');
    const mockFetch = vi.fn().mockResolvedValue(okResponse());
    const url = await sendOneBatch(transport, mockFetch);
    expect(url).toBe('https://notes.example.com/api/relay/batch');
  });

  it('an explicit baseUrl still wins over the configured server URL', async () => {
    localStorage.setItem(SERVER_URL_STORAGE_KEY, 'https://notes.example.com');
    vi.resetModules();
    const { createHttpTransport } = await import('@/core/transportHttp');
    const transport = createHttpTransport('ws-1', 'actor-1', 'http://localhost:9999');
    const mockFetch = vi.fn().mockResolvedValue(okResponse());
    const url = await sendOneBatch(transport, mockFetch);
    expect(url).toBe('http://localhost:9999/api/relay/batch');
  });
});
