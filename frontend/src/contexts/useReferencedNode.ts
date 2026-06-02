import { useContext } from 'react';
import type { Node } from '@/types/api';
import { ReferencedNodesContext } from './ReferencedNodesContext';

/**
 * Look up a referenced node by UUID from the page-level pre-fetched map.
 * Returns undefined if the UUID is not in the map (e.g., newly created link).
 */
export function useReferencedNode(uuid: string | null): Node | undefined {
  const map = useContext(ReferencedNodesContext);
  if (!uuid) return undefined;
  return map[uuid];
}
