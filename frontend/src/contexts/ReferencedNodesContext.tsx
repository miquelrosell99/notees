/**
 * ReferencedNodesContext — Provides pre-fetched node metadata for inline link pills.
 *
 * The page content endpoint returns a `referenced_nodes` map (uuid → lightweight info)
 * for all outgoing text links from blocks on the page. This context makes that data
 * available to InlineLink, EmbedBlock, and LinkEditModal so they can resolve
 * target node metadata without individual API calls.
 *
 * Eliminates the N+1 GET /api/nodes/uuid/{uuid} requests that fired per pill.
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { ReferencedNodeInfo } from '@/types/api';

// ─── Context ──────────────────────────────────────────────────────

type ReferencedNodesMap = Record<string, ReferencedNodeInfo>;

const ReferencedNodesContext = createContext<ReferencedNodesMap>({});

// ─── Provider ─────────────────────────────────────────────────────

interface ReferencedNodesProviderProps {
  /** Map of target node UUID → lightweight metadata, from page content response */
  referencedNodes: ReferencedNodesMap | undefined;
  children: ReactNode;
}

export function ReferencedNodesProvider({
  referencedNodes,
  children,
}: ReferencedNodesProviderProps) {
  const value = useMemo(() => referencedNodes ?? {}, [referencedNodes]);
  return (
    <ReferencedNodesContext.Provider value={value}>
      {children}
    </ReferencedNodesContext.Provider>
  );
}

// ─── Hook ─────────────────────────────────────────────────────────

/**
 * Look up a referenced node by UUID from the page-level pre-fetched map.
 * Returns undefined if the UUID is not in the map (e.g., newly created link).
 */
export function useReferencedNode(uuid: string | null): ReferencedNodeInfo | undefined {
  const map = useContext(ReferencedNodesContext);
  if (!uuid) return undefined;
  return map[uuid];
}

/**
 * Get the full referenced nodes map (for components that need to iterate).
 */
export function useReferencedNodes(): ReferencedNodesMap {
  return useContext(ReferencedNodesContext);
}
