/**
 * Tests for the local (serverless) session — local-first split, Task 2.
 *
 * `loginLocally` must create and persist a local session without any network
 * traffic, and `logout` must clear it without calling the server.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useAuthStore, getLocalWorkspaceUuid } from '../authStore';
import api from '@/api/client';
import type { User } from '@/types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function resetAuthState() {
  useAuthStore.setState({
    user: null,
    isAuthenticated: false,
    authVerified: false,
    isLoading: false,
    error: null,
    twoFactor: null,
    backupCodes: null,
    setupData: null,
  });
}

beforeEach(() => {
  localStorage.clear();
  resetAuthState();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('loginLocally', () => {
  it('creates a local session matching the contracted shape', () => {
    useAuthStore.getState().loginLocally();

    const { user, isAuthenticated, authVerified, isLoading, error } = useAuthStore.getState();
    expect(user).not.toBeNull();
    expect(user!.uuid).toMatch(UUID_RE);
    // UUIDv7: version nibble is 7.
    expect(user!.uuid.charAt(14)).toBe('7');
    expect(user!.email).toBe('local@local');
    expect(user!.name).toBe('Local user');
    expect(user!.isLocal).toBe(true);
    expect(isAuthenticated).toBe(true);
    // Self-verified: no /auth/me round-trip is needed.
    expect(authVerified).toBe(true);
    expect(isLoading).toBe(false);
    expect(error).toBeNull();
  });

  it('persists the session to both storage layers', () => {
    useAuthStore.getState().loginLocally();
    const user = useAuthStore.getState().user!;

    const storedUser = JSON.parse(localStorage.getItem('user')!) as User;
    expect(storedUser.uuid).toBe(user.uuid);
    expect(storedUser.isLocal).toBe(true);

    const authStorage = JSON.parse(localStorage.getItem('auth-storage')!) as {
      state: { user: User };
    };
    expect(authStorage.state.user.uuid).toBe(user.uuid);
    expect(authStorage.state.user.isLocal).toBe(true);
  });

  it('creates the well-known local workspace UUID and reuses it across logout/login', () => {
    useAuthStore.getState().loginLocally();
    const workspaceUuid = getLocalWorkspaceUuid();
    expect(workspaceUuid).toMatch(UUID_RE);

    useAuthStore.getState().logout();
    useAuthStore.getState().loginLocally();
    expect(getLocalWorkspaceUuid()).toBe(workspaceUuid);
  });

  it('performs no network calls', () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const getSpy = vi.spyOn(api, 'get');
    const postSpy = vi.spyOn(api, 'post');

    useAuthStore.getState().loginLocally();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getSpy).not.toHaveBeenCalled();
    expect(postSpy).not.toHaveBeenCalled();
  });
});

describe('logout', () => {
  it('clears a local session without calling the server', () => {
    const postSpy = vi.spyOn(api, 'post');

    useAuthStore.getState().loginLocally();
    useAuthStore.getState().logout();

    const { user, isAuthenticated, authVerified } = useAuthStore.getState();
    expect(user).toBeNull();
    expect(isAuthenticated).toBe(false);
    expect(authVerified).toBe(false);
    expect(localStorage.getItem('user')).toBeNull();
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('still calls the server logout endpoint for server sessions', () => {
    const postSpy = vi.spyOn(api, 'post').mockResolvedValue({ data: {}, headers: {} });

    const serverUser = {
      nodeUuid: 'n',
      uuid: 'u',
      email: 'a@b.c',
      name: null,
      surnames: null,
      profile_pic: null,
      role: 'user',
      is_active: true,
      totp_enabled: false,
    } satisfies User;
    useAuthStore.getState().setUser(serverUser);
    useAuthStore.getState().logout();

    expect(postSpy).toHaveBeenCalledWith('/auth/logout');
  });
});
