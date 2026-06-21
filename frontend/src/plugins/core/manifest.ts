/**
 * Plugin manifest types.
 *
 * Mirrors the backend PluginManifest schema so the frontend can consume
 * manifests from GET /api/plugins without extra translation.
 */

export interface PluginBackendManifest {
  entrypoint?: string;
  dependencies?: string[];
}

export interface PluginFrontendManifest {
  entrypoint?: string;
  css?: string[];
}

export interface ContributedSetting {
  id: string;
  type: 'string' | 'number' | 'boolean' | 'select' | 'multiselect';
  label: string;
  default?: unknown;
  options?: Array<{ value: string; label: string }>;
  description?: string;
  required?: boolean;
}

export interface ContributedCommand {
  id: string;
  label: string;
  icon?: string;
}

export interface ContributedSlashCommand {
  id: string;
  label: string;
  description?: string;
}

export interface ContributedImporter {
  id: string;
  label: string;
  fileExtensions?: string[];
}

export interface ContributedExporter {
  id: string;
  label: string;
  extension: string;
  mimeType?: string;
}

export interface ContributedView {
  id: string;
  label: string;
  icon?: string;
}

export interface ContributedSidebarItem {
  id: string;
  label: string;
  icon?: string;
  viewId: string;
}

export interface PluginContributesManifest {
  settings?: ContributedSetting[];
  commands?: ContributedCommand[];
  slashCommands?: ContributedSlashCommand[];
  importers?: ContributedImporter[];
  exportFormats?: ContributedExporter[];
  views?: ContributedView[];
  sidebarItems?: ContributedSidebarItem[];
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  minAppVersion?: string;
  permissions?: string[];
  backend?: PluginBackendManifest;
  frontend?: PluginFrontendManifest;
  contributes?: PluginContributesManifest;
  builtin?: boolean;
  enabledByDefault?: boolean;
}

export interface PluginStatus extends PluginManifest {
  enabled: boolean;
  backendSetupFailed?: boolean;
  backendError?: string | null;
  frontendSetupFailed?: boolean;
  frontendError?: string | null;
}
