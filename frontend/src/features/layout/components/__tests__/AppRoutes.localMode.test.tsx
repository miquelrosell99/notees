/**
 * Guard-chain bypass test for local sessions — local-first split, Task 2.
 *
 * With a persisted local session, `AuthenticatedShell` must skip all four boot
 * queries (/auth/status, /auth/me, /workspaces, /settings) and
 * `WorkspaceRedirect` must route to the well-known local workspace without
 * calling listWorkspaces — zero network traffic overall.
 *
 * The auth store rehydrates from localStorage at module init, so the session
 * is seeded before a dynamic import of the route tree.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import type { User } from '@/types';

// The workspace shell is lazy-loaded by AppRoutes; stub it so the test does
// not pull in the entire editor.
vi.mock('../Layout', () => ({
  Layout: () => <div data-testid="layout-shell">Layout</div>,
}));
vi.mock('../QuickAddModal', () => ({
  QuickAddModal: () => null,
}));

const localUser: User = {
  nodeUuid: '0190abcd-1234-7000-8000-0000000000ab',
  uuid: '0190abcd-1234-7000-8000-0000000000cd',
  email: 'local@local',
  name: 'Local user',
  surnames: null,
  profile_pic: null,
  role: 'user',
  is_active: true,
  totp_enabled: false,
  isLocal: true,
};

let lastPathname = '/';

function LocationProbe() {
  const location = useLocation();
  useEffect(() => {
    lastPathname = location.pathname;
  }, [location]);
  return null;
}

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
  lastPathname = '/';
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AuthenticatedShell with a local session', () => {
  it('skips every boot query and routes to the local workspace', async () => {
    localStorage.setItem('notees.serverUrl', '');    localStorage.setItem('user', JSON.stringify(localUser));
    localStorage.setItem(
      'auth-storage',
      JSON.stringify({ state: { user: localUser }, version: 0 }),
    );

    const api = (await import('@/api/client')).default;
    const getSpy = vi.spyOn(api, 'get');
    const postSpy = vi.spyOn(api, 'post');
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { AppRoutes } = await import('../AppRoutes');
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/']}>
          <AppRoutes />
          <LocationProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // The redirect lands on the well-known local workspace UUID.
    await waitFor(
      () => {
        expect(lastPathname).not.toBe('/');
      },
      { timeout: 15000 },
    );
    const localWorkspaceUuid = localStorage.getItem('notees.localWorkspaceUuid');
    expect(localWorkspaceUuid).toBeTruthy();
    expect(lastPathname).toBe(`/${localWorkspaceUuid}`);

    // The workspace shell rendered (no loading screen, no workspace manager).
    expect(await screen.findByTestId('layout-shell', undefined, { timeout: 15000 })).toBeInTheDocument();

    // R2: none of the boot queries (or anything else) hit the network.
    expect(getSpy).not.toHaveBeenCalled();
    expect(postSpy).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  }, 30000);
});
