/**
 * listPages — local-first helper to fetch all pages from the core workspace store.
 *
 * Replaces the legacy `listNodes({ pages_only: true })` API call for action-time
 * page lookups (e.g. hierarchical path resolution).
 */

import { getWorkspaceStore } from '@/core/adapters/workspaceStoreAdapter';
import { queryNodes } from './queryNodes';
import type { Node } from '@/types/api';

export function listCorePages(workspaceUuid: string): Node[] {
  const store = getWorkspaceStore(workspaceUuid);
  if (!store) return [];
  return queryNodes(store, { isPage: true });
}
