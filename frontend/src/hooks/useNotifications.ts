/**
 * Hooks for notification operations
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listNotifications, markNotificationRead, markAllNotificationsRead } from '@/api/notifications';

const notificationKeys = {
  all: ['notifications'] as const,
  list: (includeRead: boolean) => [...notificationKeys.all, 'list', includeRead] as const,
};

export function useNotifications(includeRead = false) {
  return useQuery({
    queryKey: notificationKeys.list(includeRead),
    queryFn: () => listNotifications(includeRead),
  });
}

export function useMarkNotificationRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => markNotificationRead(id),
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
