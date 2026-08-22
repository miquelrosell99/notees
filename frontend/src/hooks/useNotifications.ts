/**
 * Hooks for notification operations
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { notificationKeys } from '@/hooks/queryKeys';
import { listNotifications, markNotificationRead, markAllNotificationsRead } from '@/features/layout';
import { useCapabilities } from '@/config/capabilities';

export function useNotifications(includeRead = false) {
  // Notifications are server-side; never fire the query in local mode, even
  // if a hidden entry point still mounts the hook.
  const capabilities = useCapabilities();
  return useQuery({
    queryKey: notificationKeys.list(includeRead),
    queryFn: () => listNotifications(includeRead),
    enabled: capabilities.notifications,
  });
}

export function useMarkNotificationRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (notificationUuid: string) => markNotificationRead(notificationUuid),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: notificationKeys.all });
    },
  });
}

export function useMarkAllNotificationsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => markAllNotificationsRead(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: notificationKeys.all });
    },
  });
}
