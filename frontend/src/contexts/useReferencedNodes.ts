import { useContext } from 'react';
import { ReferencedNodesContext } from './ReferencedNodesContext';
import type { ReferencedNodesMap } from './ReferencedNodesContext';

/**
 * Get the full referenced nodes map (for components that need to iterate).
 */
export function useReferencedNodes(): ReferencedNodesMap {
  return useContext(ReferencedNodesContext);
}
