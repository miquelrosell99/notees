/**
 * React Query client configuration with offline persistence
 */
import { QueryClient, QueryCache } from '@tanstack/react-query';
import { get, set, del } from 'idb-keyval';
import { isApiError } from '@/api/client';
import type { Persister, PersistedClient } from '@tanstack/react-query-persist-client';

import { useNotificationStore } from '@/stores/notificationStore';
import { useUndoStore } from '@/stores/undoStore';

/**
 * Extract user-friendly error message from various error types
 */
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const apiError = isApiError(error) ? error : undefined;
    if (apiError?.response?.data && typeof apiError.response.data === 'object') {
      const data = apiError.response.data as { detail?: string; message?: string };
      return data.detail || data.message || error.message;
    }
    return error.message;
  }
  return 'An unexpected error occurred';
}

/**
 * Global mutation error handler
 */
function onMutationError(error: Error) {
  const message = getErrorMessage(error);
  useNotificationStore.getState().error('Operation failed', message);
}

/**
 * Global query error handler — only surfaces non-auth errors so routine
 * 401/403 responses (handled by the auth flow) don't spam the user.
 */
function onQueryError(error: Error, query: unknown) {
  const status = isApiError(error) ? error.response?.status : undefined;
  if (status && (status === 401 || status === 403)) return;
  if ((query as { meta?: { skipGlobalError?: boolean } })?.meta?.skipGlobalError) return;
  const message = getErrorMessage(error);
  useNotificationStore.getState().error('Failed to load data', message);
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: onQueryError,
  }),
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5,
      retry: (failureCount, error) => {
        const status = isApiError(error) ? error.response?.status : undefined;
        if (status && status >= 400 && status < 500) {
          return false;
        }
        return failureCount < 1;
      },
      refetchOnWindowFocus: false,
      throwOnError: false,
    },
    mutations: {
      retry: 0,
      onError: onMutationError,
      onSuccess: () => {
        debouncedRefreshStack();
      },
    },
  },
});

// ─── Debounced undo-stack refresh ─────────────────────────────────

let refreshStackTimer: ReturnType<typeof setTimeout> | null = null;
const REFRESH_STACK_DEBOUNCE_MS = 500;

function debouncedRefreshStack(): void {
  if (refreshStackTimer) {
    clearTimeout(refreshStackTimer);
  }
  refreshStackTimer = setTimeout(() => {
    refreshStackTimer = null;
    useUndoStore.getState().refreshStack().catch((error) => {
      console.error('[queryClient] Failed to refresh undo stack:', error);
    });
  }, REFRESH_STACK_DEBOUNCE_MS);
}

// ─── Offline Persistence ─────────────────────────────────────────

const PERSIST_KEY = 'notees-query-cache';
const MAX_PERSIST_SIZE = 5 * 1024 * 1024; // 5 MB
const PERSIST_DEBOUNCE_MS = 2000;

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let pendingClient: PersistedClient | null = null;

export const asyncStoragePersister: Persister = {
  async persistClient(client: PersistedClient): Promise<void> {
    pendingClient = client;
    if (persistTimer) {
      clearTimeout(persistTimer);
    }
    persistTimer = setTimeout(() => {
      persistTimer = null;
      const toPersist = pendingClient;
      pendingClient = null;
      if (!toPersist) return;

      const serialized = JSON.stringify(toPersist);
      if (serialized.length > MAX_PERSIST_SIZE) {
        console.warn('[queryClient] Cache too large to persist (>5 MB), skipping IndexedDB write.');
        return;
      }

      set(PERSIST_KEY, serialized).catch((err) => {
        console.error('[queryClient] Failed to persist query cache:', err);
      });
    }, PERSIST_DEBOUNCE_MS);
  },
  async restoreClient(): Promise<PersistedClient | undefined> {
    const value = await get(PERSIST_KEY);
    if (typeof value === 'string') {
      try {
        return JSON.parse(value) as PersistedClient;
      } catch {
        return undefined;
      }
    }
    return undefined;
  },
  async removeClient(): Promise<void> {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
      pendingClient = null;
    }
    await del(PERSIST_KEY);
  },
};


