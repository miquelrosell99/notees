/**
 * Capability-gating tests for AccountMenu (local-first split, Task 4 / R4).
 *
 * The connection mode is resolved from localStorage at module init, so each
 * mode is set up by seeding `notees.serverUrl`, resetting the module registry,
 * and dynamically importing the component and stores.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { User } from '@/types';

// Notifications are server-side; stub the hook so no query fires regardless of
// the mode under test.
vi.mock('@/hooks/useNotifications', () => ({
  useNotifications: () => ({ data: undefined }),
}));

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

async function renderAccountMenu(user: User) {
  const { AccountMenu } = await import('../AccountMenu');
  const { useAuthStore } = await import('@/stores');
  useAuthStore.setState({ user });

  render(
    <AccountMenu
      onOpenUserSettings={() => {}}
      onOpenSystemSettings={() => {}}
      onOpenShares={() => {}}
    />,
  );
  fireEvent.click(screen.getByTitle(user.name ?? 'User'));
}

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AccountMenu in local mode', () => {
  it('hides server-only entries (Notifications, Mentions, Shares, System Settings)', async () => {
    localStorage.setItem('notees.serverUrl', '');
    await renderAccountMenu(localUser);

    expect(screen.queryByText('Notifications')).not.toBeInTheDocument();
    expect(screen.queryByText('Mentions')).not.toBeInTheDocument();
    expect(screen.queryByText('Shares')).not.toBeInTheDocument();
    expect(screen.queryByText('System Settings')).not.toBeInTheDocument();

    // Local-safe entries remain.
    expect(screen.getByText('User Settings')).toBeInTheDocument();
    expect(screen.getByText('Log out')).toBeInTheDocument();
  }, 20000);
});

describe('AccountMenu when connected', () => {
  it('renders every entry', async () => {
    await renderAccountMenu(serverUser);

    expect(screen.getByText('Notifications')).toBeInTheDocument();
    expect(screen.getByText('Mentions')).toBeInTheDocument();
    expect(screen.getByText('Shares')).toBeInTheDocument();
    expect(screen.getByText('System Settings')).toBeInTheDocument();
    expect(screen.getByText('User Settings')).toBeInTheDocument();
    expect(screen.getByText('Log out')).toBeInTheDocument();
  }, 20000);
});
