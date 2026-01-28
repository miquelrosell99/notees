/**
 * React Query client configuration
 */
import { QueryClient } from '@tanstack/react-query';
import type { AxiosError } from 'axios';
import { useNotificationStore } from '@/stores/notificationStore';

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

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      retry: (failureCount, error) => {
        // Don't retry on 401 (authentication) or 403 (forbidden)
        if ((error as AxiosError)?.response?.status === 401 || 
            (error as AxiosError)?.response?.status === 403) {
          return false;
        }
        // Retry once for other errors
        return failureCount < 1;
      },
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 0,
      onError: onMutationError,
    },
  },
});
