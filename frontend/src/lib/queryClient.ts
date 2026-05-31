/**
 * React Query client configuration with offline persistence
 */
import { QueryClient, QueryCache } from '@tanstack/react-query';
import { get, set, del } from 'idb-keyval';
import type { AxiosError } from 'axios';
import type { Persister, PersistedClient } from '@tanstack/react-query-persist-client';

import { useNotificationStore } from '@/stores/notificationStore';
import { useUndoStore } from '@/stores/undoStore';

/**
 * Extract user-friendly error message from various error types
 */
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const axiosError = error as AxiosError<{ detail?: string; message?: string }>;
    if (axiosError.response?.data) {
      return axiosError.response.data.detail ||
             axiosError.response.data.message ||
             error.message;
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
  const status = (error as AxiosError)?.response?.status;
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
        const status = (error as AxiosError)?.response?.status;
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
        useUndoStore.getState().refreshStack();
      },
    },
  },
});

// ─── Offline Persistence ─────────────────────────────────────────

const PERSIST_KEY = 'notees-query-cache';

export const asyncStoragePersister: Persister = {
  async persistClient(client: PersistedClient): Promise<void> {
    await set(PERSIST_KEY, JSON.stringify(client));
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
    await del(PERSIST_KEY);
  },
};

(window as unknown as Record<string, unknown>).__queryClient = queryClient;
