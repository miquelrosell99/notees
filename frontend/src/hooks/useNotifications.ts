/**
 * Hooks for notification operations
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { notificationKeys } from '@/hooks/queryKeys';
import { listNotifications, markNotificationRead, markAllNotificationsRead } from '@/features/layout';

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
