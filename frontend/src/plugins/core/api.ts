import api from '@/api/client';
import type { ContributedSetting, PluginStatus } from './manifest';

export interface InstallPluginRequest {
  url: string;
}

export interface InstallPluginResponse {
  job_id: string;
  status: 'pending';
}

export interface InstallJob {
  job_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  git_url: string;
  progress: string | null;
  result: {
    id: string;
    name: string;
    version: string;
    safe_id: string;
    restart_required: boolean;
  } | null;
  error: string | null;
}

export interface PluginSettingValue extends ContributedSetting {
  value: unknown;
}

export interface PluginSettingsResponse {
  plugin_id: string;
  settings: PluginSettingValue[];
}

export function installPlugin(request: InstallPluginRequest): Promise<InstallPluginResponse> {
  return api.post<InstallPluginResponse>('/plugins/install', request).then((r) => r.data);
}

export function listPlugins(): Promise<PluginStatus[]> {
  return api.get<PluginStatus[]>('/plugins').then((r) => r.data);
}

export function getInstallJob(jobId: string): Promise<InstallJob> {
  return api.get<InstallJob>(`/plugins/install/jobs/${jobId}`).then((r) => r.data);
}

export function getPluginSettings(pluginId: string): Promise<PluginSettingValue[]> {
  return api
    .get<PluginSettingsResponse>(`/plugins/${pluginId}/settings`)
    .then((r) => r.data.settings);
}

export function setPluginSetting(pluginId: string, key: string, value: unknown): Promise<void> {
  return api.put(`/plugins/${pluginId}/settings/${encodeURIComponent(key)}`, { value }).then(() => undefined);
}

export function uninstallPlugin(pluginId: string): Promise<{ id: string; uninstalled: boolean }> {
  return api.delete(`/plugins/${pluginId}`).then((r) => r.data);
}

export function updatePlugin(pluginId: string): Promise<PluginStatus> {
  return api.post(`/plugins/${pluginId}/update`).then((r) => r.data);
}

export interface ImporterInfo {
  id: string;
  label: string;
  file_extensions: string[];
}

export interface ImporterRunResult {
  created_node_ids: number[];
  updated_node_ids: number[];
  skipped_count: number;
  error_count: number;
  messages: string[];
}

export function listImporters(): Promise<ImporterInfo[]> {
  return api.get<ImporterInfo[]>('/plugins/importers/list').then((r) => r.data);
}

export function runImporter(
  importerId: string,
  file: File,
  workspaceUuid: string,
): Promise<ImporterRunResult> {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('workspace_uuid', workspaceUuid);
  return api
    .post<ImporterRunResult>(`/plugins/import/${encodeURIComponent(importerId)}`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    .then((r) => r.data);
}
