/**
 * Shared types for the Export Profiles plugin frontend.
 *
 * Mirrors the backend profile JSON stored in workspace settings
 * (`app/plugins/builtin/export_profiles/profiles.py`).
 */

import type { QueryAST } from '@/types/queryAST';

export type ProfileQuery = { ast: QueryAST } | { saved_query_id: string };

export interface AssetFilter {
  roles?: string[] | null;
  mime_types?: string[] | null;
}

export interface ProviderConfig {
  asset_filter?: AssetFilter;
  filename_template?: string;
}

export interface ExportProfile {
  id: string;
  name: string;
  enabled: boolean;
  provider: string;
  query: ProfileQuery;
  destination: string;
  materializer: string;
  reconciliation_policy: string;
  provider_config: ProviderConfig;
}

export interface RunReport {
  profile_id: string;
  profile_slug: string;
  root: string;
  created: string[];
  updated: string[];
  deleted: string[];
  unchanged: number;
  conflicts: Array<{ relative_path: string; asset_uuid: string; reason: string }>;
  invalid: Array<{ relative_path: string; asset_uuid: string; reason: string }>;
  skipped: Array<{ node_uuid: string; title: string; reason: string }>;
  errors: Array<{ relative_path: string; asset_uuid: string; reason: string }>;
  file_count: number;
}

export interface ProfileListItem extends ExportProfile {
  slug: string;
  last_run: string | null;
  report: RunReport | null;
}

export interface ClassOption {
  id: string;
  name: string;
  is_system: boolean;
}

export interface CollectionOption {
  id: string;
  name: string;
}
