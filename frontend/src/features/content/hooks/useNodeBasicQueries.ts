/**
 * useNodeBasicQueries
 *
 * Fundamental node read hooks. These are thin wrappers around the core SQLite
 * store adapters; the legacy API fallback has been removed.
 */
import { useNodeAdapter, useNodesAdapter, useNodeChildrenAdapter } from '@/core/adapters';

export function useNodes(filters?: { pages_only?: boolean; parent_uuid?: string; tag_uuid?: string; page_size?: number } | null) {
  return useNodesAdapter(filters ?? undefined);
}

export function useNode(
  id: string | null,
  options?: {
    include_children?: boolean;
    include_backlinks?: boolean;
    include_properties?: boolean;
    meta?: Record<string, unknown>;
    staleTime?: number;
  }
) {
  return useNodeAdapter(id, options);
}

export function useNodeChildren(parentId: string | null) {
  return useNodeChildrenAdapter(parentId);
}

/**
 * Fetch a node by UUID. In the local-first architecture this is equivalent to
 * useNode; the separate hook is kept for API compatibility with existing callers.
 */
export function useNodeByUuid(
  uuid: string | null,
  options?: {
    include_children?: boolean;
    include_backlinks?: boolean;
    meta?: Record<string, unknown>;
  }
) {
  return useNodeAdapter(uuid, options);
}
