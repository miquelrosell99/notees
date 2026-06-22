/**
 * Tests for the API client's auth/refresh behaviour.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getTokenExpiry,
  scheduleProactiveRefresh,
  cancelProactiveRefresh,
} from './client';

describe('getTokenExpiry', () => {
  it('decodes the exp claim from a JWT', () => {
    const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const exp = Math.floor(Date.now() / 1000) + 900;
    const payload = btoa(JSON.stringify({ sub: 'user', exp }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
    const token = `${header}.${payload}.signature`;

    expect(getTokenExpiry(token)).toBe(exp);
  });

  it('returns null for malformed tokens', () => {
    expect(getTokenExpiry('not-a-jwt')).toBeNull();
    expect(getTokenExpiry('only.one')).toBeNull();
  });
});

describe('scheduleProactiveRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'new-token' }),
    } as Response);
  });

  afterEach(() => {
    cancelProactiveRefresh();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeToken(expiresInSeconds: number): string {
    const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const payload = btoa(JSON.stringify({ sub: 'user', exp }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
    return `${header}.${payload}.signature`;
  }

  it('refreshes one minute before the token expires', async () => {
    const token = makeToken(3600); // 1 hour
    scheduleProactiveRefresh(token);

    expect(global.fetch).not.toHaveBeenCalled();

    vi.advanceTimersByTime(58 * 60 * 1000); // 58 minutes
    await vi.runOnlyPendingTimersAsync();

    expect(global.fetch).toHaveBeenCalledWith('/api/auth/refresh', {
      method: 'POST',
      credentials: 'same-origin',
    });
  });

  it('cancels a pending refresh when asked', () => {
    const token = makeToken(3600);
    scheduleProactiveRefresh(token);
    cancelProactiveRefresh();

    vi.advanceTimersByTime(59 * 60 * 1000);

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('refreshes immediately when the token is already near expiry', async () => {
    const token = makeToken(30); // 30 seconds
    scheduleProactiveRefresh(token);

    await vi.runOnlyPendingTimersAsync();

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
