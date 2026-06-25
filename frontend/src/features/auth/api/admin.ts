/**
 * Admin API functions
 */
import api from '@/api/client';
import type { AdminUser, AdminMetrics, AdminUserCreate, AdminUserUpdate, PaginatedResponse } from '@/types';

export async function listUsers(
  page: number = 1,
  page_size: number = 50,
): Promise<PaginatedResponse<AdminUser>> {
  const response = await api.get<PaginatedResponse<AdminUser>>('/admin/users', {
    params: { page, page_size },
  });
  return response.data;
}

export async function createAdminUser(data: AdminUserCreate): Promise<AdminUser> {
  const response = await api.post<AdminUser>('/admin/users', data);
  return response.data;
}

export async function updateAdminUser(userUuid: string, data: AdminUserUpdate): Promise<AdminUser> {
  const response = await api.put<AdminUser>(`/admin/users/${userUuid}`, data);
  return response.data;
}

export async function deactivateAdminUser(userUuid: string): Promise<{ success: boolean }> {
  const response = await api.delete<{ success: boolean }>(`/admin/users/${userUuid}`);
  return response.data;
}

export async function getAdminMetrics(): Promise<AdminMetrics> {
  const response = await api.get<AdminMetrics>('/admin/metrics');
  return response.data;
}
