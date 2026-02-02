/**
 * QueryBlockDisplay Component
 * 
 * Provides inline query controls and results for blocks classed as "query".
 * Uses children render prop pattern to pass { controls, results } to parent.
 */
import { DynamicNodeViewSection } from '../nodes/DynamicNodeViewSection';
import type { Node } from '@/types/api';
import { useSystemClasses } from '@/hooks/useNodes';
import './QueryBlockDisplay.css';

export interface QueryBlockDisplayProps {
  block: Node;
  onNodeClick?: (nodeId: number, isPage?: boolean) => void;
  children: (result: QueryBlockDisplayResult | null) => React.ReactNode;
}

export interface QueryBlockDisplayResult {
  controls: React.ReactNode;
  results: React.ReactNode;
}

export function QueryBlockDisplay({ block, onNodeClick, children }: QueryBlockDisplayProps): React.ReactNode {
  const { systemClassIds } = useSystemClasses();
  
  const isQueryBlock = systemClassIds?.query 
    ? block.classes?.includes(systemClassIds.query)
    : false;

  if (!isQueryBlock) {
    return children(null);
  }

  return (
    <DynamicNodeViewSection
      nodeId={block.id}
      nodeUuid={block.uuid}
      viewType="main_content"
      title=""
      hideWhenEmpty={false}
      defaultExpanded={true}
      onNodeClick={onNodeClick}
      split={true}
    >
      {(result) => {
        if (!result || typeof result !== 'object' || !('controls' in result)) {
          return children(null);
        }
        return children(result as QueryBlockDisplayResult);
      }}
    </DynamicNodeViewSection>
  );
}

export default QueryBlockDisplay;

