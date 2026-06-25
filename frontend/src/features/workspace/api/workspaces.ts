/**
 * Workspace API functions
 */
import api from '@/api/client';
import type { PaginatedResponse } from '@/types/api';

export interface WorkspaceInfo {
  uuid: string;
  name: string;
  created_at?: string;
  updated_at?: string;
  node_count?: number;
  page_count?: number;
  asset_count?: number;
  size_bytes?: number;
  is_active?: boolean;
  is_shared?: boolean;
  role?: 'owner' | 'admin' | 'editor' | 'viewer';
}

export interface WorkspaceListResponse {
  workspaces: WorkspaceInfo[];
  active: string | null;
}

export interface WorkspaceCheckResponse {
  available: boolean;
  name: string;
}

/**
 * List all workspaces for the current user
 */
export async function listWorkspaces(
  page: number = 1,
  page_size: number = 50,
): Promise<PaginatedResponse<WorkspaceInfo>> {
  const response = await api.get<PaginatedResponse<WorkspaceInfo>>('/workspaces/', {
    params: { page, page_size },
  });
  return response.data;
}

/**
 * Check if a workspace name is available
 */
export async function checkWorkspaceName(name: string): Promise<WorkspaceCheckResponse> {
  const response = await api.get(`/workspaces/check-name/${encodeURIComponent(name)}`);
  return response.data;
}

/**
 * Create a new workspace
 */
export async function createWorkspace(name: string): Promise<WorkspaceInfo> {
  const response = await api.post('/workspaces/', { name });
  return response.data;
}

/**
 * Switch to a different workspace by UUID
 */
export async function switchWorkspace(workspaceUuid: string): Promise<{ status: string; active: string }> {
  const response = await api.post(`/workspaces/${encodeURIComponent(workspaceUuid)}/switch`);
  return response.data;
}

/**
 * Delete a workspace by UUID
 */
export async function deleteWorkspace(workspaceUuid: string): Promise<{ status: string }> {
  const response = await api.delete(`/workspaces/${encodeURIComponent(workspaceUuid)}`);
  return response.data;
}

/**
 * Rename a workspace
 */
export async function renameWorkspace(oldName: string, newName: string): Promise<WorkspaceInfo> {
  const response = await api.put(`/workspaces/${encodeURIComponent(oldName)}/rename`, { name: newName });
  return response.data;
}

/**
 * Import a workspace from file
 */
export async function importWorkspace(name: string, file: File): Promise<WorkspaceInfo> {
  const formData = new FormData();
  formData.append('name', name);
  formData.append('file', file);
  const response = await api.post('/workspaces/import', formData);
  return response.data;
}

/**
 * Restore a workspace from a dump file.
 * WARNING: This replaces ALL data in the workspace.
 */
export async function restoreWorkspace(workspaceUuid: string, file: File): Promise<{ uuid: string; name: string; stats: Record<string, number> }> {
  const formData = new FormData();
  formData.append('file', file);
  const response = await api.post(`/workspaces/${encodeURIComponent(workspaceUuid)}/restore`, formData);
  return response.data;
}

/**
 * Get export URL for a workspace (JSON only, no assets)
 */
export function getWorkspaceExportUrl(name: string): string {
  return `/api/workspaces/${encodeURIComponent(name)}/export`;
}

/**
 * Export a workspace as a ZIP file (database + assets).
 * Returns a Blob so the caller can trigger the download via UI utilities.
 */
export async function exportWorkspaceZip(workspaceUuid: string): Promise<Blob> {
  const response = await api.get(`/workspaces/${encodeURIComponent(workspaceUuid)}/export-zip`, {
    responseType: 'blob',
    timeout: 0, // no timeout — exports can take arbitrarily long for large workspaces
  });
  return new Blob([response.data], { type: 'application/zip' });
}

/**
 * Export a workspace in a specific format (dump, markdown, text, json).
 * Returns a Blob so the caller can trigger the download.
 */
export async function exportWorkspaceFormat(
  workspaceUuid: string,
  format: 'dump' | 'markdown' | 'text' | 'json',
  includeAssets: boolean = false,
): Promise<Blob> {
  const response = await api.get(
    `/workspaces/${encodeURIComponent(workspaceUuid)}/export-by-uuid`,
    {
      params: { format, include_assets: includeAssets },
      responseType: 'blob',
      timeout: 0, // no timeout — exports can take arbitrarily long for large workspaces
    },
  );
  return new Blob([response.data], { type: 'application/zip' });
}

// ── Export jobs (async with progress) ──────────────────────

export interface ExportJob {
  job_uuid: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  progress: number;
  status_text: string;
  download_url: string | null;
  error: string | null;
}

/**
 * Start an async workspace export job.
 */
export async function createExportJob(
  workspaceUuid: string,
  format: 'dump' | 'markdown' | 'text' | 'json',
  includeAssets: boolean = false,
): Promise<{ job_uuid: string }> {
  const response = await api.post(
    `/workspaces/${encodeURIComponent(workspaceUuid)}/export-job`,
    null,
    { params: { format, include_assets: includeAssets } },
  );
  return response.data;
}

/**
 * Poll an export job for progress.
 */
export async function getExportJob(jobUuid: string): Promise<ExportJob> {
  const response = await api.get(`/workspaces/export-jobs/${encodeURIComponent(jobUuid)}`);
  return response.data;
}

/**
 * Download a completed export job result.
 */
export async function downloadExportJob(jobUuid: string): Promise<Blob> {
  const response = await api.get(
    `/workspaces/export-jobs/${encodeURIComponent(jobUuid)}/download`,
    { responseType: 'blob' },
  );
  return new Blob([response.data], { type: 'application/zip' });
}

/**
 * Get all settings for the current workspace
 */
export async function getSettings(): Promise<Record<string, unknown>> {
  const response = await api.get('/settings');
  return response.data;
}

/**
 * Get a specific setting
 */
export async function getSetting(key: string): Promise<unknown | null> {
  const settings = await getSettings();
  return settings[key] ?? null;
}

/**
 * Set a setting value
 */
export async function setSetting(key: string, value: unknown): Promise<void> {
  await api.put(`/settings/${encodeURIComponent(key)}`, { value });
}

/**
 * Get all settings for the current workspace (graph)
 */
export async function getWorkspaceSettings(): Promise<Record<string, unknown>> {
  const response = await api.get('/workspace-settings');
  return response.data;
}

/**
 * Set a workspace setting value
 */
export async function setWorkspaceSetting(key: string, value: unknown): Promise<void> {
  await api.put(`/workspace-settings/${encodeURIComponent(key)}`, { value });
}
