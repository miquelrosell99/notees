/**
 * Capability-gating tests for UserSettingsModal tabs (local-first split,
 * Task 4 / R4): the server-bound Account and Security tabs are hidden in
 * local mode; appearance/editor/general/support/about stay available.
 *
 * The connection mode is resolved from localStorage at module init, so each
 * mode is set up by seeding `notees.serverUrl`, resetting the module registry,
 * and dynamically importing the component and stores.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { User } from '@/types';

const serverUser: User = {
  nodeUuid: 'user-node-1',
  uuid: 'user-1',
  email: 'admin@example.com',
  name: 'Admin',
  surnames: null,
  profile_pic: null,
  role: 'admin',
  is_active: true,
  totp_enabled: false,
};

const localUser: User = { ...serverUser, email: 'local@local', isLocal: true };

async function renderUserSettings(user: User) {
  const { UserSettingsModal } = await import('../Modals/UserSettingsModal');
  const { useAuthStore } = await import('@/stores');
  useAuthStore.setState({ user });

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <UserSettingsModal isOpen={true} onClose={() => {}} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('UserSettingsModal in local mode', () => {
  it('hides the Account and Security tabs', async () => {
    localStorage.setItem('notees.serverUrl', '');
    await renderUserSettings(localUser);

    expect(screen.queryByRole('tab', { name: 'Account' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Security' })).not.toBeInTheDocument();

    // Local-safe tabs remain.
    expect(screen.getByRole('tab', { name: 'Appearance' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'General' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'About' })).toBeInTheDocument();
  }, 20000);
});

describe('UserSettingsModal when connected', () => {
  it('renders the Account and Security tabs', async () => {
    await renderUserSettings(serverUser);

    expect(screen.getByRole('tab', { name: 'Account' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Security' })).toBeInTheDocument();
  }, 20000);
});
