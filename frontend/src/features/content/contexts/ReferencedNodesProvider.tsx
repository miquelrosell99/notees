import { type ReactNode, useMemo } from 'react';
import { ReferencedNodesContext } from './ReferencedNodesContext';
import type { ReferencedNodesMap } from './ReferencedNodesContext';

interface ReferencedNodesProviderProps {
  /** Map of target node UUID → Node, from page content response */
  referencedNodes: ReferencedNodesMap | undefined;
  children: ReactNode;
}

const EMPTY_REFERENCED_NODES: ReferencedNodesMap = {};

export function ReferencedNodesProvider({
  referencedNodes,
  children,
}: ReferencedNodesProviderProps) {
  const value = useMemo(
    () => referencedNodes ?? EMPTY_REFERENCED_NODES,
    [referencedNodes],
  );
  return (
    <ReferencedNodesContext.Provider value={value}>
      {children}
    </ReferencedNodesContext.Provider>
  );
}
