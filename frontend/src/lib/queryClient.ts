/**
 * React Query client configuration
 */
import { QueryClient, QueryCache } from '@tanstack/react-query';
import type { AxiosError } from 'axios';

import { useNotificationStore } from '@/stores/notificationStore';
import { useUndoStore } from '@/stores/undoStore';

/**
 * Extract user-friendly error message from various error types
 */
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    // Check for Axios error with response
    const axiosError = error as AxiosError<{ detail?: string; message?: string }>;
    if (axiosError.response?.data) {
      return axiosError.response.data.detail || 
             axiosError.response.data.message || 
             axiosError.message;
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
  
  // Show error notification
  useNotificationStore.getState().error(
    'Operation failed',
    message
  );
}

/**
 * Global query error handler — only surfaces non-auth errors so routine
 * 401/403 responses (handled by the auth flow) don't spam the user.
 */
function onQueryError(error: Error, query: unknown) {
  const status = (error as AxiosError)?.response?.status;
  if (status && (status === 401 || status === 403)) return; // handled by auth flow
  if ((query as { meta?: { skipGlobalError?: boolean } })?.meta?.skipGlobalError) return; // suppressed by caller
  const message = getErrorMessage(error);
  useNotificationStore.getState().error('Failed to load data', message);
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: onQueryError,
  }),
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      retry: (failureCount, error) => {
        // Don't retry on client errors (4xx)
        const status = (error as AxiosError)?.response?.status;
        if (status && status >= 400 && status < 500) {
          return false;
        }
        // Retry once for other errors
        return failureCount < 1;
      },
      refetchOnWindowFocus: false,
      throwOnError: false,
    },
    mutations: {
      retry: 0,
      onError: onMutationError,
      onSuccess: () => {
        // Refresh undo stack after any mutation so buttons stay in sync
        useUndoStore.getState().refreshStack();
      },
    },
  },
});

// Expose globally so non-React code (e.g. URL helpers) can read the cache
(window as any).__queryClient = queryClient;
