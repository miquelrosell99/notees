/**
 * Notifications API functions
 */
import api from '@/api/client';
import type { NotificationResponse } from '@/types';

export interface NotificationsListResponse {
  notifications: NotificationResponse[];
  unread_count: number;
}

export async function listNotifications(includeRead = false): Promise<NotificationsListResponse> {
  const response = await api.get<NotificationsListResponse>('/notifications', {
    params: { include_read: includeRead },
  });
  return response.data;
}

export async function markNotificationRead(notificationUuid: string): Promise<{ status: string }> {
  const response = await api.post<{ status: string }>(`/notifications/${notificationUuid}/read`);
  return response.data;
}

export async function markAllNotificationsRead(): Promise<{ status: string }> {
  const response = await api.post<{ status: string }>('/notifications/read-all');
  return response.data;
}
