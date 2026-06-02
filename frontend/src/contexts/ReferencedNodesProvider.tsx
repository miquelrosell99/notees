import { useMemo, type ReactNode } from 'react';
import { ReferencedNodesContext } from './ReferencedNodesContext';
import type { ReferencedNodesMap } from './ReferencedNodesContext';

interface ReferencedNodesProviderProps {
  /** Map of target node UUID → Node, from page content response */
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
