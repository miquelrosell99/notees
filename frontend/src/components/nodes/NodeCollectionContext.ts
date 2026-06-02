/**
 * NodeCollectionContext - Provides NodeCollection state to child components.
 */
import { createContext, useContext } from 'react';
import type { NodeCollectionContextValue } from '@/types/nodeCollection';

const NodeCollectionContext = createContext<NodeCollectionContextValue | null>(null);

/**
 * Hook to access NodeCollection context
 */
export function useNodeCollectionContext(): NodeCollectionContextValue {
  const context = useContext(NodeCollectionContext);
  if (!context) {
    throw new Error('useNodeCollectionContext must be used within a NodeCollection');
  }
  return context;
}

export { NodeCollectionContext };
