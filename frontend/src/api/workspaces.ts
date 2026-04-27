/**
 * Workspace API functions
 */
import api from './client';

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
export async function listWorkspaces(): Promise<WorkspaceListResponse> {
  const response = await api.get('/workspaces/');
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
export async function switchWorkspace(uuid: string): Promise<{ status: string; active: string }> {
  const response = await api.post(`/workspaces/${encodeURIComponent(uuid)}/switch`);
  return response.data;
}

/**
 * Delete a workspace by UUID
 */
export async function deleteWorkspace(uuid: string): Promise<{ status: string }> {
  const response = await api.delete(`/workspaces/${encodeURIComponent(uuid)}`);
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
  const response = await api.post('/workspaces/import', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return response.data;
}

/**
 * Restore a workspace from a dump file.
 * WARNING: This replaces ALL data in the workspace.
 */
export async function restoreWorkspace(uuid: string, file: File): Promise<{ uuid: string; name: string; stats: Record<string, number> }> {
  const formData = new FormData();
  formData.append('file', file);
  const response = await api.post(`/workspaces/${encodeURIComponent(uuid)}/restore`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
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
 * Downloads the file via the authenticated API client.
 */
export async function exportWorkspaceZip(uuid: string, name: string): Promise<void> {
  const response = await api.get(`/workspaces/${encodeURIComponent(uuid)}/export-zip`, {
    responseType: 'blob',
  });
  const blob = new Blob([response.data], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}_full.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Get all settings for the current workspace
 */
export async function getSettings(): Promise<Record<string, string>> {
  const response = await api.get('/settings');
  return response.data;
}

/**
 * Get a specific setting
 */
export async function getSetting(key: string): Promise<string | null> {
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
export async function getWorkspaceSettings(): Promise<Record<string, string>> {
  const response = await api.get('/workspace-settings');
  return response.data;
}

/**
 * Set a workspace setting value
 */
export async function setWorkspaceSetting(key: string, value: unknown): Promise<void> {
  await api.put(`/workspace-settings/${encodeURIComponent(key)}`, { value });
}
