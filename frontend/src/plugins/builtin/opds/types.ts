/**
 * Shared types for the OPDS plugin frontend.
 *
 * Mirrors the backend responses of `app/plugins/builtin/opds/router.py`.
 */

export type CatalogSelection =
  | { kind: 'all_sources' }
  | { kind: 'saved_query'; saved_query_id: string };

export interface OpdsClassCount {
  name: string;
  count: number;
}

export interface OpdsInfo {
  feed_url: string;
  selection: CatalogSelection;
  workspace_uuid: string;
  publication_count: number;
  classes: OpdsClassCount[];
}

export interface OpdsSettings {
  saved_query_id: string | null;
}
