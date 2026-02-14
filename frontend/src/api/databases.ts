/**
 * Database API functions
 */
import api from './client';

export interface DatabaseInfo {
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

export interface DatabaseListResponse {
  databases: DatabaseInfo[];
  active: string | null;
}

export interface DatabaseCheckResponse {
  available: boolean;
  name: string;
}

/**
 * List all databases for the current user
 */
export async function listDatabases(): Promise<DatabaseListResponse> {
  const response = await api.get('/databases');
  return response.data;
}

/**
 * Check if a database name is available
 */
export async function checkDatabaseName(name: string): Promise<DatabaseCheckResponse> {
  const response = await api.get(`/databases/check-name/${encodeURIComponent(name)}`);
  return response.data;
}

/**
 * Create a new database
 */
export async function createDatabase(name: string): Promise<DatabaseInfo> {
  const response = await api.post('/databases', { name });
  return response.data;
}

/**
 * Switch to a different database by workspace UUID
 */
export async function switchDatabase(uuid: string): Promise<{ status: string; active: string }> {
  const response = await api.post(`/databases/${encodeURIComponent(uuid)}/switch`);
  return response.data;
}

/**
 * Delete a database
 */
export async function deleteDatabase(name: string): Promise<{ status: string }> {
  const response = await api.delete(`/databases/${encodeURIComponent(name)}`);
  return response.data;
}

/**
 * Rename a database
 */
export async function renameDatabase(oldName: string, newName: string): Promise<DatabaseInfo> {
  const response = await api.put(`/databases/${encodeURIComponent(oldName)}/rename`, { name: newName });
  return response.data;
}

/**
 * Import a database from file
 */
export async function importDatabase(name: string, file: File): Promise<DatabaseInfo> {
  const formData = new FormData();
  formData.append('name', name);
  formData.append('file', file);
  const response = await api.post('/databases/import', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return response.data;
}

/**
 * Get export URL for a database
 */
export function getDatabaseExportUrl(name: string): string {
  return `/api/databases/${encodeURIComponent(name)}/export`;
}

/**
 * Get all settings for the current database
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
