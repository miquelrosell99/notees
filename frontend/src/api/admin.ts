/**
 * Admin API functions
 */
import api from './client';
import type { AdminUser, AdminMetrics, AdminUserCreate, AdminUserUpdate } from '@/types';

export async function listUsers(): Promise<{ users: AdminUser[] }> {
  const response = await api.get<{ users: AdminUser[] }>('/admin/users');
  return response.data;
}

export async function createAdminUser(data: AdminUserCreate): Promise<AdminUser> {
  const response = await api.post<AdminUser>('/admin/users', data);
  return response.data;
}

export async function updateAdminUser(userId: string, data: AdminUserUpdate): Promise<AdminUser> {
  const response = await api.put<AdminUser>(`/admin/users/${userId}`, data);
  return response.data;
}

export async function deactivateAdminUser(userId: string): Promise<{ success: boolean }> {
  const response = await api.delete<{ success: boolean }>(`/admin/users/${userId}`);
  return response.data;
}

export async function getAdminMetrics(): Promise<AdminMetrics> {
  const response = await api.get<AdminMetrics>('/admin/metrics');
  return response.data;
}
