/**
 * LoginView local-mode tests — local-first split, Task 2.
 *
 * - Local mode (server URL explicitly cleared): "Continue locally" is the
 *   primary action and the server form is collapsed behind a toggle.
 * - Server mode (default): the form is primary and "Continue locally" is a
 *   secondary action below it.
 *
 * The connection mode is mocked directly (instead of re-importing modules with
 * a seeded localStorage) so the test shares a single React instance and RTL
 * cleanup keeps working under full-suite load.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConnectionMode } from '@/config/serverUrl';
import type * as connectionStore from '@/stores/connectionStore';
import { LoginView } from '../LoginView';
import { useAuthStore } from '../../stores/authStore';
import api from '@/api/client';

const mocks = vi.hoisted(() => ({
  connectionMode: { current: 'connected' as ConnectionMode },
}));

vi.mock('@/stores/connectionStore', async (importOriginal) => ({
  ...(await importOriginal<typeof connectionStore>()),
  useConnectionMode: () => mocks.connectionMode.current,
}));

beforeEach(() => {
  localStorage.clear();
  mocks.connectionMode.current = 'connected';
  useAuthStore.setState({ user: null, isAuthenticated: false, authVerified: false });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderLoginView() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <LoginView />
    </QueryClientProvider>,
  );
}

describe('LoginView in local mode', () => {
  it('presents "Continue locally" as the primary path with the server form collapsed', () => {
    mocks.connectionMode.current = 'local';
    const view = renderLoginView();

    // Primary action, server fields hidden.
    expect(view.getByRole('button', { name: 'Continue locally' })).toBeInTheDocument();
    expect(view.queryByLabelText(/email/i)).not.toBeInTheDocument();

    // The server login is still reachable via the secondary toggle.
    fireEvent.click(view.getByRole('button', { name: 'Sign in to a server' }));
    expect(view.getByLabelText(/email/i)).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Sign In' })).toBeInTheDocument();
  });

  it('clicking "Continue locally" creates a local session without network calls', () => {
    mocks.connectionMode.current = 'local';
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const getSpy = vi.spyOn(api, 'get');
    const postSpy = vi.spyOn(api, 'post');

    const view = renderLoginView();
    fireEvent.click(view.getByRole('button', { name: 'Continue locally' }));

    const { user, isAuthenticated } = useAuthStore.getState();
    expect(user?.isLocal).toBe(true);
    expect(isAuthenticated).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getSpy).not.toHaveBeenCalled();
    expect(postSpy).not.toHaveBeenCalled();
  });
});

describe('LoginView in server mode (default)', () => {
  it('keeps the form primary and offers "Continue locally" below it', () => {
    const view = renderLoginView();

    expect(view.getByLabelText(/email/i)).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Sign In' })).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Continue locally' })).toBeInTheDocument();
  });
});
