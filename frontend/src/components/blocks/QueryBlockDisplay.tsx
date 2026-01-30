/**
 * QueryBlockDisplay Component
 * 
 * Renders a DynamicNodeViewSection for blocks that are classed as "query".
 * Executes the query stored in the block's _query_block_tree property.
 */
import { DynamicNodeViewSection } from '../nodes/DynamicNodeViewSection';
import type { Node } from '@/types/api';
import { useSystemClasses } from '@/hooks/useNodes';

export interface QueryBlockDisplayProps {
  block: Node;
  onNodeClick?: (nodeId: number, isPage?: boolean) => void;
}

export function QueryBlockDisplay({ block, onNodeClick }: QueryBlockDisplayProps) {
  const { systemClassIds } = useSystemClasses();
  
  // Check if block has the query class
  const isQueryBlock = systemClassIds?.query 
    ? block.classes?.includes(systemClassIds.query)
    : false;

  if (!isQueryBlock) {
    return null;
  }

  return (
    <div className="query-block-display">
      <DynamicNodeViewSection
        nodeId={block.id}
        nodeUuid={block.uuid}
        viewType="main_content"
        title="Query Results"
        hideWhenEmpty={false}
        defaultExpanded={true}
        onNodeClick={onNodeClick}
      />
    </div>
  );
}

export default QueryBlockDisplay;
