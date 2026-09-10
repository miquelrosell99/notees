/**
 * Regression: a poisoned persisted settings query (status success, data null)
 * must not hang the boot on the fullscreen "Loading…" gate.
 *
 * The TanStack cache is persisted with staleTime: Infinity, so a corrupt
 * settings entry (null is never a valid payload — the backend always returns
 * an object) survived every reload: the layout effect that marks settings as
 * synced treated falsy data as "not loaded yet" and never ran. The fix
 * refetches once on non-object payloads, then falls back to defaults.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { User } from '@/types';

// The workspace shell is lazy-loaded by AppRoutes; stub it so the test does
// not pull in the entire editor.
vi.mock('../Layout', () => ({
  Layout: () => <div data-testid="layout-shell">Layout</div>,
}));
vi.mock('../QuickAddModal', () => ({
  QuickAddModal: () => null,
}));

const serverUser: User = {
  nodeUuid: '0190abcd-1234-7000-8000-0000000000ab',
  uuid: '0190abcd-1234-7000-8000-0000000000cd',
  email: 'user@example.com',
  name: 'Server user',
  surnames: null,
  profile_pic: null,
  role: 'user',
  is_active: true,
  totp_enabled: false,
};

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AuthenticatedShell with a poisoned settings cache', () => {
  it('refetches null settings and renders the shell instead of hanging', async () => {
    localStorage.setItem('user', JSON.stringify(serverUser));
    localStorage.setItem(
      'auth-storage',
      JSON.stringify({ state: { user: serverUser }, version: 0 }),
    );

    const api = (await import('@/api/client')).default;
    const settingsPayload = { enrollment_completed: 'true', theme: 'dark' };
    vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
      if (url.includes('/auth/me/settings')) return { data: settingsPayload, headers: {} };
      if (url.includes('/auth/status')) return { data: { needs_onboarding: false }, headers: {} };
      if (url.includes('/auth/me')) return { data: serverUser, headers: {} };
      if (url.includes('/workspaces')) {
        return { data: { items: [{ uuid: 'ws-1', name: 'W', is_active: true }] }, headers: {} };
      }
      return { data: {}, headers: {} };
    });

    const { AppRoutes } = await import('../AppRoutes');
    const { settingsKeys } = await import('@/hooks/queryKeys');
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    // The poisoned persisted entry: success status, null data.
    queryClient.setQueryData(settingsKeys.all, null);

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/']}>
          <AppRoutes />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Before the fix the boot hung on the settings gate forever; the shell
    // must appear once the refetch returns a real settings document.
    expect(await screen.findByTestId('layout-shell', undefined, { timeout: 15000 })).toBeInTheDocument();
    expect(queryClient.getQueryData(settingsKeys.all)).toEqual(settingsPayload);
  }, 30000);
});
